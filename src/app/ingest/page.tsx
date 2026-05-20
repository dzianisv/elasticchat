import Link from 'next/link'
import { SiteFooter } from '@/components/site-footer'
import { es } from '@/lib/elasticsearch'
import { NVIDIA_BLOGS_INDEX, CRAWL_STATE_INDEX } from '@/lib/indexMappings'

// Always render against fresh ES state — never cache this page.
export const dynamic = 'force-dynamic'
export const revalidate = 0

interface CrawlEntry {
  url: string
  content_hash?: string
  last_crawled?: string
  status?: string
}

interface BlogTitleMeta {
  title?: string
  date?: string
}

interface DashboardData {
  ok: boolean
  error?: string
  total: number
  uniqueUrls: number
  entries: Array<CrawlEntry & { title?: string; date?: string; source: string }>
  runs: Array<{ day: string; count: number; last: string }>
  lastRun: string | null
}

function inferSource(url: string): string {
  // The pipeline pulls from either the RSS feed or one of the three sitemaps.
  // We can't read that decision from the crawl-state document directly (no
  // `source` field is persisted), so we approximate from the URL shape.
  if (!url) return 'unknown'
  if (url.includes('/blog/')) return 'blogs.nvidia.com/blog'
  if (url.includes('blogs.nvidia.com')) return 'blogs.nvidia.com (RSS/sitemap)'
  if (url.includes('developer.nvidia.com')) return 'developer.nvidia.com'
  return 'other'
}

async function fetchDashboardData(): Promise<DashboardData> {
  const empty: DashboardData = {
    ok: true,
    total: 0,
    uniqueUrls: 0,
    entries: [],
    runs: [],
    lastRun: null,
  }

  try {
    // 1. Total chunk count in nvidia-blogs.
    const totalResp = await es.count({ index: NVIDIA_BLOGS_INDEX }).catch(() => null)
    const total = totalResp?.count ?? 0

    // 2. Approximate unique-URL count (cardinality agg).
    const cardResp = await es
      .search({
        index: NVIDIA_BLOGS_INDEX,
        size: 0,
        aggs: { unique_urls: { cardinality: { field: 'url' } } },
      })
      .catch(() => null)
    const uniqueUrls =
      ((cardResp?.aggregations as any)?.unique_urls?.value as number) ?? 0

    // 3. Crawl-state entries, newest first. Limit to 100 — enough to surface
    // the most recent run plus a few days of history without paging.
    const crawlResp = await es
      .search<CrawlEntry>({
        index: CRAWL_STATE_INDEX,
        size: 100,
        sort: [{ last_crawled: { order: 'desc' } }],
        query: { match_all: {} },
      })
      .catch(() => null)
    const hits = crawlResp?.hits?.hits ?? []

    // 4. For the URLs we got, look up title+date in nvidia-blogs (chunk_index=0
    // carries the canonical title/date).
    const urls = hits
      .map((h) => h._source?.url)
      .filter((u): u is string => typeof u === 'string')
    const titleMap = new Map<string, BlogTitleMeta>()
    if (urls.length > 0) {
      const titleResp = await es
        .search({
          index: NVIDIA_BLOGS_INDEX,
          size: urls.length,
          query: {
            bool: {
              filter: [
                { terms: { url: urls } },
                { term: { chunk_index: 0 } },
              ],
            },
          },
          _source: ['url', 'title', 'date'],
        })
        .catch(() => null)
      for (const h of titleResp?.hits?.hits ?? []) {
        const src = h._source as { url?: string; title?: string; date?: string }
        if (src?.url) titleMap.set(src.url, { title: src.title, date: src.date })
      }
    }

    const entries = hits.map((h) => {
      const src = h._source ?? ({} as CrawlEntry)
      const meta = src.url ? titleMap.get(src.url) : undefined
      return {
        url: src.url ?? '',
        content_hash: src.content_hash,
        last_crawled: src.last_crawled,
        status: src.status,
        title: meta?.title,
        date: meta?.date,
        source: inferSource(src.url ?? ''),
      }
    })

    // 5. Group by UTC day for a "runs" overview. The pipeline runs once
    // nightly so day-grouping is a reasonable proxy for "run".
    const byDay = new Map<string, { count: number; last: string }>()
    for (const e of entries) {
      if (!e.last_crawled) continue
      const day = e.last_crawled.slice(0, 10)
      const cur = byDay.get(day)
      if (!cur) byDay.set(day, { count: 1, last: e.last_crawled })
      else {
        cur.count++
        if (e.last_crawled > cur.last) cur.last = e.last_crawled
      }
    }
    const runs = Array.from(byDay.entries())
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))

    const lastRun = entries[0]?.last_crawled ?? null

    return { ...empty, total, uniqueUrls, entries, runs, lastRun }
  } catch (e) {
    return {
      ...empty,
      ok: false,
      error: (e as Error).message,
    }
  }
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
  } catch {
    return iso
  }
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toISOString().slice(0, 10)
  } catch {
    return iso
  }
}

export default async function IngestionDashboardPage() {
  const data = await fetchDashboardData()

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background/80 backdrop-blur px-6 py-4 flex items-center gap-3 sticky top-0 z-10">
        <Link href="/" className="flex items-center gap-3 hover:opacity-80">
          <div className="w-9 h-9 rounded-md bg-[#76b900] flex items-center justify-center shadow-sm shadow-[#76b900]/30">
            <span className="text-black font-bold">N</span>
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">NVIDIA Blog Assistant</h1>
            <p className="text-xs text-muted-foreground">Ingestion dashboard</p>
          </div>
        </Link>
        <nav className="ml-auto flex items-center gap-4 text-sm">
          <Link href="/" className="text-muted-foreground hover:text-foreground">
            Chat
          </Link>
          <Link href="/eval" className="text-muted-foreground hover:text-foreground">
            G-Eval
          </Link>
          <span className="text-[#9bd02a] font-medium">Ingestion</span>
        </nav>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        <section>
          <h2 className="text-2xl font-semibold mb-1">Ingestion</h2>
          <p className="text-sm text-muted-foreground">
            Status of the nightly NVIDIA blog corpus crawl. The cron in{' '}
            <code className="text-[#9bd02a]">vercel.json</code> hits{' '}
            <code className="text-[#9bd02a]">/api/ingest</code> daily at{' '}
            <strong>02:00 UTC</strong>; runs are recorded in the{' '}
            <code className="text-[#9bd02a]">crawl-state</code> Elasticsearch index.
          </p>
        </section>

        {!data.ok && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
            <strong className="text-destructive">Elasticsearch unreachable.</strong>
            <div className="mt-1 text-muted-foreground">
              {data.error || 'Could not query the crawl-state / nvidia-blogs indices.'}
            </div>
          </div>
        )}

        <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card label="Last run" value={formatDateTime(data.lastRun)} />
          <Card
            label="Articles in latest run"
            value={String(data.runs[0]?.count ?? 0)}
          />
          <Card
            label="Unique articles indexed"
            value={String(data.uniqueUrls)}
            sub={`across ${data.total} chunks`}
          />
          <Card
            label="Tracked URLs (crawl-state)"
            value={String(data.entries.length)}
            sub="most recent 100"
          />
        </section>

        {data.runs.length > 0 && (
          <section>
            <h3 className="text-lg font-semibold mb-3">Recent runs (grouped by day)</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-4 py-2 font-medium">Day (UTC)</th>
                    <th className="px-4 py-2 font-medium">Latest timestamp</th>
                    <th className="px-4 py-2 font-medium text-right">Articles touched</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.day} className="border-t border-border">
                      <td className="px-4 py-2 font-mono">{r.day}</td>
                      <td className="px-4 py-2 font-mono text-muted-foreground">
                        {formatDateTime(r.last)}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold text-[#9bd02a]">
                        {r.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section>
          <h3 className="text-lg font-semibold mb-3">
            Articles in recent runs ({data.entries.length})
          </h3>
          {data.entries.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-6 text-sm">
              <strong>No crawl-state entries.</strong>
              <p className="mt-2 text-muted-foreground">
                The <code>crawl-state</code> index is empty or missing. Either the
                pipeline has not run yet, or this Elasticsearch cluster has not been
                seeded. The daily cron is configured in <code>vercel.json</code>:
              </p>
              <pre className="mt-2 rounded bg-muted/40 p-2 text-xs overflow-x-auto">
                {`{ "crons": [{ "path": "/api/ingest", "schedule": "0 2 * * *" }] }`}
              </pre>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-4 py-2 font-medium">Article</th>
                    <th className="px-4 py-2 font-medium">Published</th>
                    <th className="px-4 py-2 font-medium">Last crawled</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Source</th>
                    <th className="px-4 py-2 font-medium text-right">Replay</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => {
                    const display = e.title || e.url
                    const replayHref = `/?q=${encodeURIComponent(
                      `Tell me about ${e.title || e.url}`
                    )}`
                    return (
                      <tr
                        key={e.url}
                        data-testid="ingestion-row"
                        className="border-t border-border align-top"
                      >
                        <td className="px-4 py-2 max-w-md">
                          <a
                            href={e.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#9bd02a] hover:underline"
                          >
                            {display}
                          </a>
                          <div className="text-xs text-muted-foreground truncate">
                            {e.url}
                          </div>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">
                          {formatDate(e.date)}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs whitespace-nowrap text-muted-foreground">
                          {formatDateTime(e.last_crawled)}
                        </td>
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center rounded-md bg-[#9bd02a]/10 px-2 py-0.5 text-xs text-[#9bd02a]">
                            {e.status || 'indexed'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {e.source}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Link
                            href={replayHref}
                            className="text-xs text-[#9bd02a] hover:underline"
                          >
                            Replay →
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="text-xs text-muted-foreground pt-4 border-t border-border">
          <p>
            Data sources: <code>{CRAWL_STATE_INDEX}</code> (one doc per URL,
            keyed by URL) and <code>{NVIDIA_BLOGS_INDEX}</code> (one doc per
            chunk). See <code>src/app/api/ingest/route.ts</code> for the
            pipeline.
          </p>
        </footer>
      </main>
      <SiteFooter />
    </div>
  )
}

function Card({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}
