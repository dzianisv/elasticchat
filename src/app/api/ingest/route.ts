import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import * as cheerio from 'cheerio'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
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

const UA = 'Mozilla/5.0 (compatible; ElasticChatBot/1.0)'
const CHUNK_SIZE = 2000
const CHUNK_OVERLAP = 200

interface FeedItem {
  url: string
  title?: string
  date: string
  source: string
}

// ---------------------------------------------------------------------------
// Ensure indices exist
// ---------------------------------------------------------------------------

async function ensureIndices() {
  for (const [index, mapping] of [
    [NVIDIA_BLOGS_INDEX, nvidiaBlogsMapping],
    [CRAWL_STATE_INDEX, crawlStateMapping],
  ] as const) {
    const exists = await es.indices.exists({ index })
    if (!exists) await es.indices.create({ index, ...mapping })
  }
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// URL discovery — RSS helpers
// ---------------------------------------------------------------------------

async function fetchRss(feedUrl: string, sourceLabel: string): Promise<FeedItem[]> {
  const res = await fetch(feedUrl, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`RSS ${feedUrl} → ${res.status}`)
  const xml = await res.text()
  const $ = cheerio.load(xml, { xmlMode: true })
  const items: FeedItem[] = []

  // RSS 2.0: <item> with <link> text node and <pubDate>
  $('item').each((_, el) => {
    const url =
      $(el).find('link').text().trim() ||
      $(el).find('guid').text().trim()
    const title = $(el).find('title').text().trim()
    const date = $(el).find('pubDate').text().trim()
    if (url.startsWith('http')) items.push({ url, title, date, source: sourceLabel })
  })

  // Atom: <entry> with <link rel="alternate" href="..."> and <published>
  if (items.length === 0) {
    $('entry').each((_, el) => {
      const url =
        $(el).find('link[rel="alternate"]').attr('href') ||
        $(el).find('link').attr('href') || ''
      const title = $(el).find('title').text().trim()
      const date = $(el).find('published').text().trim() || $(el).find('updated').text().trim()
      if (url.startsWith('http')) items.push({ url, title, date, source: sourceLabel })
    })
  }

  return items
}

// Try a list of candidate feed URLs in order; return first that works.
async function tryFeeds(candidates: string[], sourceLabel: string): Promise<FeedItem[]> {
  for (const url of candidates) {
    try {
      const items = await fetchRss(url, sourceLabel)
      if (items.length > 0) return items
    } catch {
      // try next
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Source-specific discovery
// ---------------------------------------------------------------------------

async function fetchFromNvidiaBlogsRss(): Promise<FeedItem[]> {
  return fetchRss('https://blogs.nvidia.com/feed/', 'blogs.nvidia.com')
}

async function fetchFromNvidiaBlogsSitemap(limit: number): Promise<FeedItem[]> {
  const res = await fetch('https://blogs.nvidia.com/post-sitemap.xml', { headers: { 'User-Agent': UA } })
  const xml = await res.text()
  const $ = cheerio.load(xml, { xmlMode: true })
  const items: FeedItem[] = []
  $('url').each((_, el) => {
    const url = $(el).find('loc').text().trim()
    const date = $(el).find('lastmod').text().trim()
    if (url.includes('/blog/')) items.push({ url, date, source: 'blogs.nvidia.com' })
  })
  items.reverse() // sitemap is ascending; newest last
  return items.slice(0, limit)
}

async function fetchFromDeveloperBlog(limit: number): Promise<FeedItem[]> {
  // RSS confirmed 200 OK at this URL
  const items = await tryFeeds(
    ['https://developer.nvidia.com/blog/feed/'],
    'developer.nvidia.com',
  )
  return items.slice(0, limit)
}

async function fetchFromPressRoom(limit: number): Promise<FeedItem[]> {
  const items = await tryFeeds(
    ['https://nvidianews.nvidia.com/rss.xml'],
    'nvidianews.nvidia.com',
  )
  return items.slice(0, limit)
}

async function fetchFromDocs(limit: number): Promise<FeedItem[]> {
  // docs.nvidia.com has no working RSS/sitemap; scrape the hub homepage for doc index links.
  const res = await fetch('https://docs.nvidia.com/', { headers: { 'User-Agent': UA } })
  if (!res.ok) return []
  const html = await res.text()
  const $ = cheerio.load(html)
  const seen = new Set<string>()
  const items: FeedItem[] = []
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || ''
    if (!href.startsWith('https://docs.nvidia.com/')) return
    if (href.includes('login') || href.includes('index.rss') || href.includes('?')) return
    // Only take paths with a meaningful sub-path (not just the homepage)
    const path = href.replace('https://docs.nvidia.com/', '')
    if (!path || path.length < 2) return
    if (seen.has(href)) return
    seen.add(href)
    items.push({ url: href, title: $(el).text().trim().slice(0, 120) || path, date: '', source: 'docs.nvidia.com' })
  })
  return items.slice(0, limit)
}

async function fetchFromGeForceNews(limit: number): Promise<FeedItem[]> {
  // No RSS/sitemap found for this surface — scrape the listing page for links.
  const res = await fetch('https://www.nvidia.com/en-us/geforce/news/', { headers: { 'User-Agent': UA } })
  if (!res.ok) return []
  const html = await res.text()
  const $ = cheerio.load(html)
  const seen = new Set<string>()
  const items: FeedItem[] = []
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || ''
    if (!href.includes('/geforce/news/') || href.endsWith('/geforce/news/')) return
    const url = href.startsWith('http') ? href : `https://www.nvidia.com${href}`
    if (seen.has(url)) return
    seen.add(url)
    items.push({ url, title: $(el).text().trim().slice(0, 120), date: '', source: 'nvidia.com/geforce' })
  })
  return items.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Content extraction — Mozilla Readability
// ---------------------------------------------------------------------------

async function fetchContent(url: string): Promise<{ content: string; title: string }> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) return { content: '', title: '' }
  const html = await res.text()

  try {
    // Pass the real URL so Readability resolves relative links correctly.
    const dom = new JSDOM(html, { url })
    const article = new Readability(dom.window.document).parse()
    return {
      content: (article?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      title: article?.title ?? '',
    }
  } catch {
    // Readability failed (malformed HTML, etc.) — fall back to plain text extraction.
    const $ = cheerio.load(html)
    $('script, style, nav, footer, header, aside').remove()
    return {
      content: ($('article').text() || $('main').text()).replace(/\s+/g, ' ').trim(),
      title: $('h1').first().text().trim() || $('title').text().trim(),
    }
  }
}

// ---------------------------------------------------------------------------
// Crawl state helpers
// ---------------------------------------------------------------------------

async function getCrawlHash(url: string): Promise<string | null> {
  try {
    const res = await es.get({ index: CRAWL_STATE_INDEX, id: url })
    return (res._source as { content_hash?: string })?.content_hash ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Index a single post
// ---------------------------------------------------------------------------

async function indexPost(item: FeedItem): Promise<'indexed' | 'skipped' | 'unchanged'> {
  const { content, title: fetchedTitle } = await fetchContent(item.url)
  if (content.length < 100) return 'skipped'

  const hash = createHash('sha256').update(content).digest('hex')
  if ((await getCrawlHash(item.url)) === hash) return 'unchanged'

  await es
    .deleteByQuery({ index: NVIDIA_BLOGS_INDEX, query: { term: { url: item.url } }, refresh: true })
    .catch(() => {})

  const chunks = chunkText(content)
  if (chunks.length === 0) return 'skipped'

  const allEmbeddings: number[][] = []
  for (let i = 0; i < chunks.length; i += 16) {
    const batch = chunks.slice(i, i + 16)
    allEmbeddings.push(...(await embedTexts(batch)))
    if (i + 16 < chunks.length) await new Promise((r) => setTimeout(r, 4500))
  }

  const title = item.title || fetchedTitle || item.url
  const date = item.date ? new Date(item.date).toISOString() : new Date().toISOString()

  await es.bulk({
    refresh: false,
    operations: chunks.flatMap((chunk, i) => [
      { index: { _index: NVIDIA_BLOGS_INDEX, _id: `${item.url}#${i}` } },
      { url: item.url, title, date, content: chunk, chunk_index: i, source: item.source, embedding: allEmbeddings[i] },
    ]),
  })

  await es.index({
    index: CRAWL_STATE_INDEX,
    id: item.url,
    document: {
      url: item.url,
      content_hash: hash,
      last_crawled: new Date().toISOString(),
      status: 'indexed',
      source: item.source,
    },
  })

  return 'indexed'
}

// ---------------------------------------------------------------------------
// Run ingestion over a list of items
// ---------------------------------------------------------------------------

async function runIngestion(items: FeedItem[], limit: number) {
  let indexed = 0, skipped = 0, unchanged = 0, errors = 0
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
    await new Promise((r) => setTimeout(r, 4500))
  }
  return { indexed, skipped, unchanged, errors }
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  const url = new URL(req.url)
  const source = url.searchParams.get('source') || 'rss'
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 500)

  try {
    await ensureIndices()

    let items: FeedItem[] = []

    if (source === 'all') {
      const perSource = Math.max(5, Math.floor(limit / 5))
      const results = await Promise.allSettled([
        fetchFromNvidiaBlogsRss(),
        fetchFromDeveloperBlog(perSource),
        fetchFromPressRoom(perSource),
        fetchFromGeForceNews(perSource),
        fetchFromDocs(perSource),
      ])
      for (const r of results) {
        if (r.status === 'fulfilled') items.push(...r.value.slice(0, perSource))
      }
    } else if (source === 'sitemap') {
      items = await fetchFromNvidiaBlogsSitemap(limit)
    } else if (source === 'developer') {
      items = await fetchFromDeveloperBlog(limit)
    } else if (source === 'press') {
      items = await fetchFromPressRoom(limit)
    } else if (source === 'geforce') {
      items = await fetchFromGeForceNews(limit)
    } else if (source === 'docs') {
      items = await fetchFromDocs(limit)
    } else {
      items = await fetchFromNvidiaBlogsRss()
    }

    const stats = await runIngestion(items, limit)

    return NextResponse.json({
      success: true,
      source,
      requested: limit,
      fetched: items.length,
      ...stats,
      sources: ['rss', 'sitemap', 'developer', 'press', 'geforce', 'docs', 'all'],
    })
  } catch (error) {
    console.error('Ingest error:', error)
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 })
  }
}
