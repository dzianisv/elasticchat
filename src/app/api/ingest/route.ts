import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import * as cheerio from 'cheerio'
import { es } from '@/lib/elasticsearch'
import { embedTexts } from '@/lib/embeddings'
import {
  NVIDIA_BLOGS_INDEX,
  CRAWL_STATE_INDEX,
  nvidiaBlogsMapping,
  crawlStateMapping,
} from '@/lib/indexMappings'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const RSS_URL = 'https://blogs.nvidia.com/feed/'
const SITEMAP_URL = 'https://blogs.nvidia.com/post-sitemap.xml'

const CHUNK_SIZE = 2000
const CHUNK_OVERLAP = 200

interface FeedItem {
  url: string
  title?: string
  date: string
}

async function ensureIndices() {
  for (const [index, mapping] of [
    [NVIDIA_BLOGS_INDEX, nvidiaBlogsMapping],
    [CRAWL_STATE_INDEX, crawlStateMapping],
  ] as const) {
    const exists = await es.indices.exists({ index })
    if (!exists) {
      await es.indices.create({ index, ...mapping })
    }
  }
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

async function fetchFromRSS(): Promise<FeedItem[]> {
  const res = await fetch(RSS_URL)
  const xml = await res.text()
  const $ = cheerio.load(xml, { xmlMode: true })
  const items: FeedItem[] = []
  $('item').each((_, el) => {
    const url = $(el).find('link').text().trim()
    const title = $(el).find('title').text().trim()
    const date = $(el).find('pubDate').text().trim()
    if (url) items.push({ url, title, date })
  })
  return items
}

async function fetchFromSitemap(limit: number): Promise<FeedItem[]> {
  const res = await fetch(SITEMAP_URL)
  const xml = await res.text()
  const $ = cheerio.load(xml, { xmlMode: true })
  const items: FeedItem[] = []
  $('url').each((_, el) => {
    const url = $(el).find('loc').text().trim()
    const date = $(el).find('lastmod').text().trim()
    if (url.includes('/blog/')) items.push({ url, date })
  })
  // Sitemap is ordered ascending by lastmod — take newest first
  items.reverse()
  return items.slice(0, limit)
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
  const article =
    $('.entry-content').text() ||
    $('article').text() ||
    $('main').text() ||
    ''
  return {
    content: article.replace(/\s+/g, ' ').trim(),
    title,
  }
}

async function getCrawlHash(url: string): Promise<string | null> {
  try {
    const res = await es.get({ index: CRAWL_STATE_INDEX, id: url })
    return (res._source as { content_hash?: string })?.content_hash || null
  } catch {
    return null
  }
}

async function indexPost(item: FeedItem): Promise<'indexed' | 'skipped' | 'unchanged'> {
  const { content, title: fetchedTitle } = await fetchContent(item.url)
  if (content.length < 100) return 'skipped'

  const hash = createHash('sha256').update(content).digest('hex')
  const existing = await getCrawlHash(item.url)
  if (existing === hash) return 'unchanged'

  await es
    .deleteByQuery({
      index: NVIDIA_BLOGS_INDEX,
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
    // Pace to stay under free-tier rate limit (15 req/60s)
    if (i + 16 < chunks.length) await new Promise((r) => setTimeout(r, 4500))
  }

  const title = item.title || fetchedTitle || item.url
  const date = item.date ? new Date(item.date).toISOString() : new Date().toISOString()

  const ops = chunks.flatMap((chunk, i) => [
    { index: { _index: NVIDIA_BLOGS_INDEX, _id: `${item.url}#${i}` } },
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
    index: CRAWL_STATE_INDEX,
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

export async function GET(req: Request) {
  const url = new URL(req.url)
  const source = url.searchParams.get('source') || 'rss' // rss (default, fast) or sitemap (bulk)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 500)

  try {
    await ensureIndices()
    const items = source === 'sitemap' ? await fetchFromSitemap(limit) : await fetchFromRSS()
    let indexed = 0
    let skipped = 0
    let unchanged = 0
    let errors = 0

    for (const item of items.slice(0, limit)) {
      try {
        const result = await indexPost(item)
        if (result === 'indexed') indexed++
        else if (result === 'unchanged') unchanged++
        else skipped++
      } catch (e) {
        console.error(`Failed ${item.url}:`, (e as Error).message)
        errors++
      }
      // Pace between posts to spread embedding calls under the 15/min budget
      await new Promise((r) => setTimeout(r, 4500))
    }

    return NextResponse.json({
      success: true,
      source,
      requested: limit,
      fetched: items.length,
      indexed,
      unchanged,
      skipped,
      errors,
    })
  } catch (error) {
    console.error('Ingest error:', error)
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    )
  }
}
