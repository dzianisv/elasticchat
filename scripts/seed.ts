/**
 * Bulk seed the nvidia-blogs ES index from the sitemap.
 * Usage: npx tsx scripts/seed.ts [limit]
 *
 * Reads .env, fetches recent posts from blogs.nvidia.com sitemap, downloads
 * the HTML for each, extracts content with cheerio, chunks, embeds, and
 * bulk-indexes into Elasticsearch. Tracks crawl state for idempotency.
 *
 * Paces embedding calls to stay under the 15-req/60s Azure dev AI free tier.
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { Client } from '@elastic/elasticsearch'
import * as cheerio from 'cheerio'

// Load .env
const envPath = resolve(process.cwd(), '.env')
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}

const LIMIT = parseInt(process.argv[2] || '200', 10)
// Newest-first: sitemap3 has the most recent posts, sitemap1 has the oldest.
const SITEMAPS = [
  'https://blogs.nvidia.com/post-sitemap3.xml',
  'https://blogs.nvidia.com/post-sitemap2.xml',
  'https://blogs.nvidia.com/post-sitemap.xml',
]
const INDEX = 'nvidia-blogs'
const CRAWL_INDEX = 'crawl-state'
const CHUNK_SIZE = 2000
const CHUNK_OVERLAP = 200
const EMBED_MODEL = 'Cohere-embed-v3-english'

const es = new Client({
  node: process.env.ELASTICSEARCH_URL!,
  auth: { apiKey: process.env.ELASTICSEARCH_API_KEY! },
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function embedTexts(texts: string[], retries = 5): Promise<number[][]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${process.env.AZURE_DEV_AI_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'api-key': process.env.AZURE_DEV_AI_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: EMBED_MODEL }),
    })
    if (res.ok) {
      const data = await res.json()
      return data.data.map((d: { embedding: number[] }) => d.embedding)
    }
    if (res.status === 429 && attempt < retries) {
      console.warn(`  embed 429, waiting 65s (attempt ${attempt + 1})`)
      await sleep(65_000)
      continue
    }
    throw new Error(`embed failed: ${res.status} ${await res.text()}`)
  }
  throw new Error('embed retries exhausted')
}

function chunkText(text: string): string[] {
  if (!text) return []
  if (text.length <= CHUNK_SIZE) return [text]
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    chunks.push(text.slice(i, i + CHUNK_SIZE))
    i += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return chunks
}

interface FeedItem {
  url: string
  date: string
}

async function fetchSitemap(sitemapUrl: string): Promise<FeedItem[]> {
  const res = await fetch(sitemapUrl)
  const xml = await res.text()
  const $ = cheerio.load(xml, { xmlMode: true })
  const items: FeedItem[] = []
  $('url').each((_, el) => {
    const url = $(el).find('loc').text().trim()
    const date = $(el).find('lastmod').text().trim()
    if (url.includes('/blog/')) items.push({ url, date })
  })
  // Sitemap is ascending by lastmod — newest at end
  items.reverse()
  return items
}

async function fetchAllSitemaps(limit: number): Promise<FeedItem[]> {
  const all: FeedItem[] = []
  for (const url of SITEMAPS) {
    const items = await fetchSitemap(url)
    all.push(...items)
    if (all.length >= limit) break
  }
  return all.slice(0, limit)
}

async function fetchContent(url: string): Promise<{ content: string; title: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ElasticChatBot/1.0)' },
  })
  if (!res.ok) return { content: '', title: '' }
  const html = await res.text()
  const $ = cheerio.load(html)
  $('script, style, nav, footer, header, aside, .related-posts, .share-bar, .comments').remove()
  const title = $('h1').first().text().trim() || $('title').text().trim()
  const article = $('.entry-content').text() || $('article').text() || $('main').text() || ''
  return { content: article.replace(/\s+/g, ' ').trim(), title }
}

async function getCrawlHash(url: string): Promise<string | null> {
  try {
    const res = await es.get({ index: CRAWL_INDEX, id: url })
    return (res._source as { content_hash?: string })?.content_hash || null
  } catch {
    return null
  }
}

async function ensureIndices() {
  for (const idx of [INDEX, CRAWL_INDEX]) {
    const exists = await es.indices.exists({ index: idx })
    if (exists) continue
    if (idx === INDEX) {
      await es.indices.create({
        index: idx,
        mappings: {
          properties: {
            url: { type: 'keyword' },
            title: { type: 'text' },
            date: { type: 'date' },
            content: { type: 'text' },
            chunk_index: { type: 'integer' },
            embedding: {
              type: 'dense_vector',
              dims: 1024,
              index: true,
              similarity: 'cosine',
            },
          },
        },
      })
    } else {
      await es.indices.create({
        index: idx,
        mappings: {
          properties: {
            url: { type: 'keyword' },
            content_hash: { type: 'keyword' },
            last_crawled: { type: 'date' },
            status: { type: 'keyword' },
          },
        },
      })
    }
    console.log(`created index: ${idx}`)
  }
}

async function indexPost(item: FeedItem): Promise<'indexed' | 'unchanged' | 'skipped'> {
  const { content, title } = await fetchContent(item.url)
  if (content.length < 100) return 'skipped'

  const hash = createHash('sha256').update(content).digest('hex')
  const existing = await getCrawlHash(item.url)
  if (existing === hash) return 'unchanged'

  await es
    .deleteByQuery({
      index: INDEX,
      query: { term: { url: item.url } },
      refresh: true,
    })
    .catch(() => {})

  const chunks = chunkText(content)
  if (chunks.length === 0) return 'skipped'

  const allEmbeddings: number[][] = []
  for (let i = 0; i < chunks.length; i += 16) {
    const batch = chunks.slice(i, i + 16)
    const embeddings = await embedTexts(batch)
    allEmbeddings.push(...embeddings)
    if (i + 16 < chunks.length) await sleep(4500)
  }

  const date = item.date ? new Date(item.date).toISOString() : new Date().toISOString()
  const ops = chunks.flatMap((chunk, i) => [
    { index: { _index: INDEX, _id: `${item.url}#${i}` } },
    {
      url: item.url,
      title,
      date,
      content: chunk,
      chunk_index: i,
      embedding: allEmbeddings[i],
    },
  ])
  await es.bulk({ refresh: false, operations: ops })

  await es.index({
    index: CRAWL_INDEX,
    id: item.url,
    document: {
      url: item.url,
      content_hash: hash,
      last_crawled: new Date().toISOString(),
      status: 'indexed',
    },
  })

  return 'indexed'
}

async function main() {
  await ensureIndices()
  console.log(`Fetching sitemaps (newest first) and selecting ${LIMIT} posts...`)
  const items = await fetchAllSitemaps(LIMIT)
  console.log(`Got ${items.length} items. Starting ingest.`)

  let indexed = 0
  let unchanged = 0
  let skipped = 0
  let errors = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const t0 = Date.now()
    try {
      const result = await indexPost(item)
      if (result === 'indexed') indexed++
      else if (result === 'unchanged') unchanged++
      else skipped++
      const dt = Date.now() - t0
      console.log(
        `[${i + 1}/${items.length}] ${result} ${item.url} (${dt}ms) — indexed=${indexed} unchanged=${unchanged} skipped=${skipped} errors=${errors}`
      )
    } catch (e) {
      errors++
      console.error(`[${i + 1}/${items.length}] error ${item.url}: ${(e as Error).message}`)
    }
    // Pace between posts to spread embed load
    await sleep(4500)
  }

  // Refresh index so search sees new docs
  await es.indices.refresh({ index: INDEX })

  console.log(`\nDone. indexed=${indexed} unchanged=${unchanged} skipped=${skipped} errors=${errors}`)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
