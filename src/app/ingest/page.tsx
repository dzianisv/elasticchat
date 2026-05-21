import Link from 'next/link'
import { SiteFooter } from '@/components/site-footer'
import { es } from '@/lib/elasticsearch'
import { NVIDIA_BLOGS_INDEX, CRAWL_STATE_INDEX } from '@/lib/indexMappings'
import { APP_NAME } from '@/lib/appConfig'

// Always render against fresh ES state — never cache this page.
export const dynamic = 'force-dynamic'
export const revalidate = 0

interface CrawlEntry {
  url: string
  content_hash?: string
  last_crawled?: string
  status?: string
  source?: string
}

interface BlogTitleMeta {
  title?: string
  date?: string
}

// All sources the ingest route knows about, in display order.
// esLabel must match the `source` field stored in ES by the ingest route.
// RSS and sitemap both write 'blogs.nvidia.com' so they share a count.
const ALL_SOURCES = [
  { key: 'rss', label: 'blogs.nvidia.com (RSS)', param: 'rss', esLabel: 'blogs.nvidia.com' },
  { key: 'sitemap', label: 'blogs.nvidia.com (sitemap)', param: 'sitemap', esLabel: 'blogs.nvidia.com' },
  { key: 'developer', label: 'developer.nvidia.com', param: 'developer', esLabel: 'developer.nvidia.com' },
  { key: 'press', label: 'nvidianews.nvidia.com', param: 'press', esLabel: 'nvidianews.nvidia.com' },
  { key: 'geforce', label: 'nvidia.com/geforce', param: 'geforce', esLabel: 'nvidia.com/geforce' },
  { key: 'docs', label: 'docs.nvidia.com', param: 'docs', esLabel: 'docs.nvidia.com' },
]

interface DashboardData {
  ok: boolean
  error?: string
  total: number
  uniqueUrls: number
  entries: Array<CrawlEntry & { title?: string; date?: string; source: string }>
  runs: Array<{ day: string; count: number; last: string }>
  lastRun: string | null
  /** Count of crawl-state docs per source label */
  sourceCounts: Record<string, number>
}

function resolveSource(entry: CrawlEntry): string {
  // Prefer the `source` field stored in crawl-state by the ingest route.
  if (entry.source) return entry.source
  // Fall back to URL heuristic for docs indexed before the field was added.
  const url = entry.url ?? ''
  if (url.includes('blogs.nvidia.com')) return 'blogs.nvidia.com'
  if (url.includes('developer.nvidia.com')) return 'developer.nvidia.com'
  if (url.includes('nvidianews.nvidia.com')) return 'nvidianews.nvidia.com'
  if (url.includes('nvidia.com/geforce')) return 'nvidia.com/geforce'
  if (url.includes('docs.nvidia.com')) return 'docs.nvidia.com'
  return 'unknown'
}

async function fetchDashboardData(): Promise<DashboardData> {
  const empty: DashboardData = {
    ok: true,
    total: 0,
    uniqueUrls: 0,
    entries: [],
    runs: [],
    lastRun: null,
    sourceCounts: {},
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
        source: src.source,
        title: meta?.title,
        date: meta?.date,
        // resolveSource is called below after the map so entries have the raw field
      }
    })

    // Build source counts from the actual `source` field (with URL fallback).
    const sourceCounts: Record<string, number> = {}
    const resolvedEntries = entries.map((e) => {
      const source = resolveSource(e)
      sourceCounts[source] = (sourceCounts[source] ?? 0) + 1
      return { ...e, source }
    })

    // 5. Group by UTC day for a "runs" overview. The pipeline runs once
    // nightly so day-grouping is a reasonable proxy for "run".
    const byDay = new Map<string, { count: number; last: string }>()
    for (const e of resolvedEntries) {
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

    const lastRun = resolvedEntries[0]?.last_crawled ?? null

    return { ...empty, total, uniqueUrls, entries: resolvedEntries, runs, lastRun, sourceCounts }
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
            <h1 className="text-lg font-semibold leading-tight">{APP_NAME}</h1>
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

        <section>
          <h3 className="text-lg font-semibold mb-3">Source breakdown</h3>
          <p className="text-xs text-muted-foreground mb-3">
            The nightly cron only calls <code className="text-[#9bd02a]">/api/ingest</code> (= <code className="text-[#9bd02a]">source=rss</code>).
            To crawl other sources, trigger them manually:{' '}
            <code className="text-[#9bd02a]">curl &quot;/api/ingest?source=developer&amp;limit=20&quot;</code>.
            Available values: <code className="text-[#9bd02a]">rss</code>,{' '}
            <code className="text-[#9bd02a]">sitemap</code>,{' '}
            <code className="text-[#9bd02a]">developer</code>,{' '}
            <code className="text-[#9bd02a]">press</code>,{' '}
            <code className="text-[#9bd02a]">geforce</code>,{' '}
            <code className="text-[#9bd02a]">docs</code>,{' '}
            <code className="text-[#9bd02a]">all</code>.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium text-right">URLs in crawl-state</th>
                  <th className="px-4 py-2 font-medium">Trigger command</th>
                </tr>
              </thead>
              <tbody>
                {ALL_SOURCES.map((s) => {
                  const count = data.sourceCounts[s.esLabel] ?? 0
                  return (
                    <tr key={s.key} className="border-t border-border">
                      <td className="px-4 py-2 font-mono">{s.label}</td>
                      <td className="px-4 py-2 text-right font-semibold">
                        {count === 0 ? (
                          <span className="text-muted-foreground">0 — never crawled</span>
                        ) : (
                          <span className="text-[#9bd02a]">{count}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                        curl &quot;/api/ingest?source={s.param}&amp;limit=20&quot;
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

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
