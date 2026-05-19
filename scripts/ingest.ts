import 'dotenv/config'
import { createHash } from 'crypto'
import { Client } from '@elastic/elasticsearch'
import { chunkText } from './lib/chunker'
import { enrichPost } from './lib/enrichment'

// Load .env.local
import { config } from 'dotenv'
config({ path: '.env.local' })

const ES_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200'
const AZURE_EMBED_URL = 'https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1'
const AZURE_AI_KEY = process.env.AZURE_AI_KEY || process.env.AZURE_DEV_AI_API_KEY!
const EMBED_MODEL = 'Cohere-embed-v3-english'
const EMBED_DIMS = 1024

const INDEX = 'nvidia-blogs'
const CRAWL_INDEX = 'crawl-state'
const WP_API = 'https://blogs.nvidia.com/wp-json/wp/v2/posts'

const LIMIT = parseInt(process.argv[2] || '50', 10)
const CONCURRENCY = 1
const PAGE_DELAY = 200

const es = new Client({ node: ES_URL })

async function embedTexts(texts: string[], retries = 3): Promise<number[][]> {
  const resp = await fetch(`${AZURE_EMBED_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': AZURE_AI_KEY,
    },
    body: JSON.stringify({ input: texts, model: EMBED_MODEL }),
  })
  if (resp.status === 429 && retries > 0) {
    const wait = 65000 // wait 65s for rate limit reset
    console.log(`  Rate limited, waiting ${wait/1000}s...`)
    await new Promise((r) => setTimeout(r, wait))
    return embedTexts(texts, retries - 1)
  }
  if (!resp.ok) throw new Error(`Embed failed: ${resp.status} ${await resp.text()}`)
  const data = await resp.json()
  return data.data.map((d: any) => d.embedding)
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

interface WPPost {
  id: number
  date: string
  modified: string
  link: string
  title: { rendered: string }
  content: { rendered: string }
  excerpt: { rendered: string }
}

async function fetchPosts(): Promise<WPPost[]> {
  const posts: WPPost[] = []
  let page = 1

  while (posts.length < LIMIT) {
    await new Promise((r) => setTimeout(r, PAGE_DELAY))
    const url = `${WP_API}?per_page=100&page=${page}&_fields=id,date,modified,link,title,content,excerpt`
    const resp = await fetch(url)
    if (resp.status === 400 || resp.status === 404) break
    if (!resp.ok) throw new Error(`WP API error: ${resp.status}`)
    const data: WPPost[] = await resp.json()
    if (data.length === 0) break
    posts.push(...data)
    page++
  }

  return posts.slice(0, LIMIT)
}

async function getCrawlState(url: string): Promise<string | null> {
  try {
    const resp = await es.get({ index: CRAWL_INDEX, id: url })
    return (resp._source as any)?.content_hash || null
  } catch {
    return null
  }
}

async function updateCrawlState(url: string, hash: string) {
  await es.index({
    index: CRAWL_INDEX,
    id: url,
    document: {
      url,
      content_hash: hash,
      last_crawled: new Date().toISOString(),
      status: 'indexed',
    },
  })
}

async function fetchPostContent(url: string): Promise<string> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`)
  const html = await resp.text()
  // Extract main article content
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*post-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  return articleMatch ? articleMatch[1] : html
}

async function processPost(post: WPPost) {
  const contentHtml = post.content?.rendered || await fetchPostContent(post.link)
  const hash = sha256(contentHtml)

  const existingHash = await getCrawlState(post.link)
  if (existingHash === hash) return null

  const title = stripHtml(post.title.rendered)
  const content = stripHtml(contentHtml)
  const chunks = chunkText(content)

  if (chunks.length === 0) return null

  // Enrich
  const meta = await enrichPost(title, content)

  // Embed all chunks
  const embeddings = await embedTexts(chunks)

  // Bulk index
  const operations: any[] = []
  for (let i = 0; i < chunks.length; i++) {
    const docId = `${post.link}#chunk-${i}`
    operations.push({ index: { _index: INDEX, _id: docId } })
    operations.push({
      url: post.link,
      parent_url: post.link,
      title,
      content: chunks[i],
      date: post.date,
      chunk_index: i,
      embedding: embeddings[i],
      tags: meta.tags,
      doc_type: meta.doc_type,
      is_announcement: meta.is_announcement,
    })
  }

  await es.bulk({ operations, refresh: false })
  await updateCrawlState(post.link, hash)

  return { url: post.link, chunks: chunks.length }
}

async function main() {
  console.log(`Ingest starting (limit: ${LIMIT} posts)`)

  // Ensure indices exist
  for (const idx of [INDEX, CRAWL_INDEX]) {
    const exists = await es.indices.exists({ index: idx })
    if (!exists) {
      console.log(`Creating index: ${idx}`)
      if (idx === INDEX) {
        await es.indices.create({
          index: idx,
          body: {
            mappings: {
              properties: {
                url: { type: 'keyword' },
                parent_url: { type: 'keyword' },
                title: { type: 'text' },
                content: { type: 'text' },
                date: { type: 'date' },
                chunk_index: { type: 'integer' },
                embedding: { type: 'dense_vector', dims: EMBED_DIMS, index: true, similarity: 'cosine' },
                tags: { type: 'keyword' },
                doc_type: { type: 'keyword' },
                is_announcement: { type: 'boolean' },
              },
            },
          },
        })
      } else {
        await es.indices.create({
          index: idx,
          body: {
            mappings: {
              properties: {
                url: { type: 'keyword' },
                content_hash: { type: 'keyword' },
                last_crawled: { type: 'date' },
                status: { type: 'keyword' },
              },
            },
          },
        })
      }
    }
  }

  console.log('Fetching posts from WordPress...')
  const posts = await fetchPosts()
  console.log(`Fetched ${posts.length} posts`)

  let processed = 0
  let skipped = 0
  let errors = 0

  // Process with concurrency limit
  const semaphore = { active: 0 }
  const queue = [...posts]

  async function worker() {
    while (queue.length > 0) {
      while (semaphore.active >= CONCURRENCY) {
        await new Promise((r) => setTimeout(r, 50))
      }
      const post = queue.shift()
      if (!post) break
      semaphore.active++
      try {
        const result = await processPost(post)
        if (result) {
          processed++
          if (processed % 10 === 0) {
            console.log(`  Progress: ${processed} indexed, ${skipped} skipped, ${errors} errors`)
          }
        } else {
          skipped++
        }
      } catch (e) {
        errors++
        console.error(`  Error processing ${post.link}: ${(e as Error).message}`)
      } finally {
        semaphore.active--
      }
    }
  }

  // Launch workers
  const workers = Array.from({ length: CONCURRENCY }, () => worker())
  await Promise.all(workers)

  console.log(`\nDone! Indexed: ${processed}, Skipped: ${skipped}, Errors: ${errors}`)
}

main().catch((e) => {
  console.error('Fatal error:', e)
  process.exit(1)
})
