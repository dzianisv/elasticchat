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
const CHUNK_SIZE = 500 // approximate tokens (~4 chars per token)
const CHUNK_OVERLAP = 50

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
  const words = text.split(/\s+/)
  const chunks: string[] = []
  let i = 0
  while (i < words.length) {
    const chunk = words.slice(i, i + CHUNK_SIZE).join(' ')
    if (chunk.trim()) chunks.push(chunk)
    i += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return chunks
}

interface FeedItem {
  url: string
  title: string
  date: string
  author: string
}

async function fetchFeed(): Promise<FeedItem[]> {
  const res = await fetch(RSS_URL)
  const xml = await res.text()
  const $ = cheerio.load(xml, { xmlMode: true })
  const items: FeedItem[] = []
  $('item').each((_, el) => {
    items.push({
      url: $(el).find('link').text().trim(),
      title: $(el).find('title').text().trim(),
      date: $(el).find('pubDate').text().trim(),
      author: $(el).find('dc\\:creator').text().trim() || 'NVIDIA',
    })
  })
  return items
}

async function fetchContent(url: string): Promise<string> {
  const res = await fetch(url)
  const html = await res.text()
  const $ = cheerio.load(html)
  // Remove scripts, styles, nav, footer
  $('script, style, nav, footer, header, aside').remove()
  const article = $('article').text() || $('.entry-content').text() || $('main').text()
  return article.replace(/\s+/g, ' ').trim()
}

async function getCrawlState(url: string): Promise<{ content_hash: string } | null> {
  try {
    const res = await es.get({ index: CRAWL_STATE_INDEX, id: url })
    return res._source as any
  } catch {
    return null
  }
}

export async function GET() {
  try {
    await ensureIndices()
    const items = await fetchFeed()
    let indexed = 0

    for (const item of items) {
      const content = await fetchContent(item.url)
      if (!content) continue

      const hash = createHash('sha256').update(content).digest('hex')
      const existing = await getCrawlState(item.url)
      if (existing?.content_hash === hash) continue

      // Delete old chunks for this URL
      await es.deleteByQuery({
        index: NVIDIA_BLOGS_INDEX,
        query: { term: { url: item.url } },
        refresh: true,
      }).catch(() => {})

      const chunks = chunkText(content)
      // Embed in batches of 20
      const allEmbeddings: number[][] = []
      for (let i = 0; i < chunks.length; i += 20) {
        const batch = chunks.slice(i, i + 20)
        const embeddings = await embedTexts(batch)
        allEmbeddings.push(...embeddings)
      }

      // Bulk index chunks
      const ops = chunks.flatMap((chunk, i) => [
        { index: { _index: NVIDIA_BLOGS_INDEX, _id: `${item.url}#${i}` } },
        {
          url: item.url,
          title: item.title,
          author: item.author,
          date: new Date(item.date).toISOString(),
          content: chunk,
          chunk_index: i,
          embedding: allEmbeddings[i],
        },
      ])
      if (ops.length) {
        await es.bulk({ refresh: true, operations: ops })
      }

      // Update crawl state
      await es.index({
        index: CRAWL_STATE_INDEX,
        id: item.url,
        document: { url: item.url, content_hash: hash, last_crawled: new Date().toISOString() },
      })

      indexed++
    }

    return NextResponse.json({ success: true, indexed })
  } catch (error: any) {
    console.error('Ingest error:', error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
