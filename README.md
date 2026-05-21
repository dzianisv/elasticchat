# ElasticChat

> **NVIDIA Assistant** — a RAG chatbot that answers questions about NVIDIA by citing posts from the NVIDIA blog corpus (blogs.nvidia.com, developer.nvidia.com, nvidianews.nvidia.com, and more).

**Live:** [elasticchat.vercel.app](https://elasticchat.vercel.app/) · **G-Eval:** [elasticchat.vercel.app/eval](https://elasticchat.vercel.app/eval) · **Ingestion:** [elasticchat.vercel.app/ingest](https://elasticchat.vercel.app/ingest)

## TL;DR

- Ask the chat anything about NVIDIA.
- It searches an Elasticsearch index of blog posts (BM25 + dense-vector hybrid via RRF), feeds the snippets to `gpt-5.4-nano`, and streams an answer with inline citations.
- Every tool call (search query, results) is visible in the UI — fold it open to see exactly what the agent retrieved.
- Quality is measured continuously: visit [`/eval`](https://elasticchat.vercel.app/eval) for the latest LLM-as-judge scores and a "Replay" button on each test case.

```
User ─▶ /              (assistant-ui Thread, useChatRuntime)
            │
            ▼
       POST /api/chat   (AI SDK v6: convertToModelMessages → streamText)
            │
            ├── tool: search        ─▶ ES nvidia-blogs (RRF(BM25 + kNN))
            └── tool: get_full_post ─▶ ES nvidia-blogs (by URL, all chunks)
            │
            ▼
       SSE UIMessage stream back to the browser, rendered with markdown +
       foldable tool-call cards.

Vercel cron (daily 02:00 UTC) ─▶ GET /api/ingest → RSS/Atom → chunk → embed → bulk index
```

## Stack

- **Next.js 16** (App Router, Turbopack, React 19)
- **[`@assistant-ui/react`](https://www.assistant-ui.com/)** + `@assistant-ui/react-ai-sdk` — chat UI primitives (Thread, ToolFallback, MarkdownText, foldable tool calls)
- **AI SDK v6** — `streamText`, `convertToModelMessages`, `tool`, `stepCountIs`
- **Elasticsearch 8** — `dense_vector(1024, cosine)` + BM25, combined via `retriever.rrf`
- **Vercel** — hosts the Next.js app, the chat API, and the ingest cron (all in one project)
- *(optional)* **Langfuse** (`cloud.langfuse.com`) — LLM observability: traces every `/api/chat` request with token usage. Enable by setting `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL` in env.

See [`docs/design.md`](./docs/design.md) for the full architectural contract, file responsibilities, ES schema, and definition of "done".

## Models

| Role | Model | Provider | Wired in |
|---|---|---|---|
| Chat / tool-calling LLM | `gpt-5.4-nano` (env: `LLM_MODEL`) | Azure OpenAI | `src/app/api/chat/route.ts` |
| Embeddings | `Cohere-embed-v3-english`, 1024-d | Azure dev AI (free tier: **15 req/min, 150 req/day**) | `src/lib/embeddings.ts` |
| G-Eval judge | `gpt-5` (env: `LLM_MODEL_MINI`) | Azure OpenAI | `scripts/eval.ts` |

Knobs (override via env): `AZURE_OPENAI_RESOURCE_NAME`, `AZURE_OPENAI_API_VERSION` (default `2025-01-01-preview`), `LLM_MODEL`, `LLM_MODEL_MINI`, `PROMPT_AUTHOR_MODEL` (recorded in eval history, default `claude-opus-4-7`). The embedding endpoint is `${AZURE_DEV_AI_BASE_URL}/embeddings` with the `api-key` header.

**Embedding cap behaviour:** At query time, if the daily cap is hit the chat endpoint falls back to BM25-only search automatically. At ingest time, add `?skip_embed=1` to index documents without vectors — BM25 search still works; re-run without the flag the next day to backfill vectors.

## Quickstart

```bash
git clone https://github.com/dzianisv/elasticchat.git
cd elasticchat
cp .env.example .env       # fill in real values
npm install
npm run dev                # http://localhost:3000
```

Required env vars (see `.env.example`):

| Variable | Purpose |
|---|---|
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` | Chat completion |
| `AZURE_DEV_AI_*` | Cohere embeddings |
| `ELASTICSEARCH_URL` / `ELASTICSEARCH_API_KEY` | Vector + BM25 store |
| `LLM_MODEL` (default `gpt-5.4-nano`), `LLM_MODEL_MINI` (default `gpt-5` for eval judge) | Model overrides |
| `LANGFUSE_*` *(optional)* | Tracing |

## Testing

```bash
# Live end-to-end (asserts the assistant bubble actually renders in a real browser)
BASE_URL=https://elasticchat.vercel.app npx playwright test tests/debug-live.spec.ts

# Page loads + API streams w/ citations
npx playwright test tests/e2e.spec.ts

# Tool-call UI: clickable source links + foldable tool calls
BASE_URL=https://elasticchat.vercel.app npx playwright test tests/debug-ui.spec.ts

# G-Eval (23 fixed cases, ~5 min, writes eval-report.json)
EVAL_CHAT_URL=https://elasticchat.vercel.app/api/chat npx tsx scripts/eval.ts
```

The G-Eval suite covers four categories: **conceptual** (5 cases), **temporal** (6), **specific_product** (5), and **edge_cases** (7 — includes typo input, a Japanese-language query, and a long multi-constraint technical question about A100 vs H100 for medical image segmentation).

Each run records `latency_ms` per case and computes **p50 / p95 latency**. These are appended to `eval-history.csv` (`latency_p50_ms`, `latency_p95_ms` columns) and included in `eval-report.json`. A **regression gate** fires after each run: if any score dimension (relevance, citation, or accuracy) drops more than 0.5 points vs the previous CSV row, the script exits with code 1.

`npm run build` succeeding is **not** "done". The only completion check that counts is a Playwright run that shows a non-empty assistant bubble in the live DOM. See [`AGENTS.md`](./AGENTS.md).

## Ingestion pipeline

The ingest pipeline is a regular Next.js App-Router route, **not** a separate worker — Vercel hosts it as a serverless function and a Vercel Cron triggers it on schedule.

```
Vercel Cron ─▶ GET /api/ingest?source=rss (default)
                ├── ensureIndices()     create `nvidia-blogs` + `crawl-state` if missing
                ├── discover URLs       RSS/Atom feed or HTML listing (source-specific)
                ├── for each URL:
                │   ├── fetchContent()  Mozilla Readability (Firefox Reader Mode algorithm)
                │   │                   → strips nav/ads/footer automatically, no CSS selectors
                │   │                   → falls back to cheerio if Readability throws
                │   ├── sha256(body)    skip if hash matches crawl-state (idempotent)
                │   ├── chunkText()     2000-char chunks, 200-char overlap
                │   ├── embedTexts()    16-chunk batches, 4.5s pacing (≤15 req/min cap)
                │   │                   skipped entirely when ?skip_embed=1
                │   └── es.bulk()       upsert all chunks + store `source` label
                └── update crawl-state  url, content_hash, last_crawled, status, source
```

### Sources

| `?source=` | Format | URL | Notes |
|---|---|---|---|
| `rss` *(default, used by cron)* | RSS 2.0 | `blogs.nvidia.com/feed/` | `<item>` / `<pubDate>` |
| `sitemap` | XML sitemap | `blogs.nvidia.com/post-sitemap.xml` | sorted newest-first |
| `developer` | Atom | `developer.nvidia.com/blog/feed/` | `<entry>` / `<link rel=alternate>` |
| `press` | RSS 2.0 | `nvidianews.nvidia.com/rss.xml` | note: `/rss` (no extension) serves HTML |
| `geforce` | HTML scrape | `nvidia.com/en-us/geforce/news/` | no RSS exists |
| `docs` | HTML scrape | `docs.nvidia.com/` | hub page → sub-doc links |
| `all` | all five above in parallel | | `floor(limit/5)` per source |

All sources use **Mozilla Readability** (`@mozilla/readability` + `jsdom`) for content extraction — same algorithm Firefox uses for Reader Mode. This works reliably across all five domains without knowing their internal class names.

Schedule and trigger (`vercel.json`):

```json
{ "crons": [{ "path": "/api/ingest", "schedule": "0 2 * * *" }] }
```

- Runs **daily at 02:00 UTC** with `source=rss` (blogs.nvidia.com — stays within the 150-embed/day free-tier cap).
- Additional sources can be triggered manually:

```bash
# Last ~20 posts from developer.nvidia.com (Atom feed)
curl 'https://elasticchat.vercel.app/api/ingest?source=developer&limit=20'

# Press releases from nvidianews.nvidia.com
curl 'https://elasticchat.vercel.app/api/ingest?source=press&limit=20'

# GeForce news (HTML scrape — no RSS)
curl 'https://elasticchat.vercel.app/api/ingest?source=geforce&limit=20'

# Documentation hub pages
curl 'https://elasticchat.vercel.app/api/ingest?source=docs&limit=20'

# All five sources, 5 posts each
curl 'https://elasticchat.vercel.app/api/ingest?source=all&limit=25'

# Bulk historical backfill from blogs.nvidia.com sitemap
curl 'https://elasticchat.vercel.app/api/ingest?source=sitemap&limit=200'
```

**When the daily embed cap is exhausted** (HTTP 429 with 65s retry × 5 = >300s, which exceeds Vercel's limit), add `?skip_embed=1` to index documents as BM25-only:

```bash
curl 'https://elasticchat.vercel.app/api/ingest?source=developer&limit=20&skip_embed=1'
```

Without `skip_embed=1` the job will timeout. Re-run without the flag the next day to add vector embeddings. The `skip_embed` field appears in the JSON response so you can confirm it was active.

- `maxDuration = 300` (5 min) for embed jobs; `skip_embed=1` jobs complete in seconds.
- Returns `{ success, source, fetched, indexed, unchanged, skipped, errors, skip_embed, sources[] }`.
- Live ingestion status: [elasticchat.vercel.app/ingest](https://elasticchat.vercel.app/ingest) — shows stat tiles (total articles, sources, last run), a source breakdown table with article counts per source, and a full article list.

### ES indices

Both indices are managed by `ensureIndices()` in the ingest route — no manual setup needed.

| Index | Purpose | Key fields |
|---|---|---|
| `nvidia-blogs` | One doc per chunk. Hybrid search target. | `url` kw, `title` text, `date` date, `content` text, `chunk_index` int, `source` kw, `embedding` dense_vector(1024, cosine) — absent on BM25-only docs |
| `crawl-state` | One doc per source URL. Idempotency store. | `url` kw, `content_hash` kw, `last_crawled` date, `status` kw, `source` kw |

### Bulk loading

For a fresh DB or developer machine, use the local CLI (bypasses Vercel — hits the same ES cluster directly):

```bash
npx tsx scripts/seed.ts 200                # 200 newest posts from blogs.nvidia.com sitemap
SKIP_EMBED=1 npx tsx scripts/seed.ts 200   # BM25-only when daily embed cap is exhausted
```

## Project layout

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | Chat UI shell, wraps `Thread` with `AssistantRuntimeProvider`. Reads `?q=` and auto-sends. |
| `src/app/eval/page.tsx` | G-Eval results page — reads `eval-history.csv` (latest run metadata + scores) and `eval-report.json` (per-case detail). |
| `src/app/ingest/page.tsx` | Ingestion dashboard — live ES query on `crawl-state`, source breakdown, stat tiles. |
| `src/app/api/chat/route.ts` | Streaming chat endpoint with `search` + `get_full_post` tools. Langfuse tracing. |
| `src/app/api/ingest/route.ts` | Cron-driven incremental ingest. Supports `?source=rss\|sitemap\|developer\|press\|geforce\|docs\|all` and `?skip_embed=1`. |
| `src/components/assistant-ui/*` | Thread, ToolFallback, MarkdownText — reused, not hand-rolled. |
| `src/lib/appConfig.ts` | Exports `APP_NAME = "NVIDIA Assistant"` — single source of truth for the application name. |
| `src/lib/elasticsearch.ts` | Lazy ES client. |
| `src/lib/embeddings.ts` | Cohere embeddings with 429 retry (65s backoff, 5 attempts). |
| `src/lib/indexMappings.ts` | ES index mappings for both indices. |
| `scripts/seed.ts` | Bulk loader (RSS + sitemaps). Supports `SKIP_EMBED=1`. |
| `scripts/eval.ts` | G-Eval scorer — 23 cases, LLM-as-judge, CSV history, regression gate. |
| `tests/*.spec.ts` | Playwright E2E + UI assertions. |
| `vercel.json` | Daily ingest cron. |
| `docs/design.md` | Architectural contract, invariants, data model. |

## Hosting on Vercel

Everything in this repo — the chat UI, the chat API, the ingest pipeline, the `/eval` results page — is deployed as **one Next.js project on Vercel**. There are no separate workers or services.

```
┌─────────────────────────────────────────────────────────────────┐
│  Vercel project: elasticchat (single Next.js App-Router app)    │
├─────────────────────────────────────────────────────────────────┤
│  Static / SSR pages                                             │
│    /          chat UI (assistant-ui Thread)                     │
│    /eval      G-Eval results, pre-rendered from eval-report.json│
│    /ingest    ingestion dashboard (live ES query)               │
│                                                                 │
│  Serverless route handlers                                      │
│    POST /api/chat      maxDuration=60s, streams SSE             │
│    GET  /api/ingest    maxDuration=300s, triggered by Vercel    │
│                        Cron (vercel.json) or manual curl        │
│                                                                 │
│  Vercel Cron                                                    │
│    "0 2 * * *"  →  /api/ingest  (daily 02:00 UTC)               │
└─────────────────────────────────────────────────────────────────┘
            │                              │
            ▼                              ▼
   Azure OpenAI                    Azure dev AI
   (gpt-5.4-nano)                  (Cohere-embed-v3-english)
            │                              │
            └────────────┬─────────────────┘
                         ▼
              Elasticsearch 8 cluster
              (nvidia-blogs + crawl-state indices)
```

External dependencies:

- **Azure OpenAI** — chat completions, called from `/api/chat` per request.
- **Azure dev AI** — Cohere embeddings, called from `/api/chat` (query-time) and `/api/ingest` (index-time).
- **Elasticsearch 8** — vector + BM25 store. Two indices, both managed by `ensureIndices()` in the ingest route.

### Deploying

```bash
npx vercel deploy --prod --token $VERCEL_TOKEN
```

The project token is in `.env` (`VERCEL_TOKEN`). GitHub auto-deploy is not currently active — the CLI workflow is the supported path.

### Environment variables on Vercel

The same vars listed in [Quickstart](#quickstart) are set in the Vercel project settings (Production scope). To rotate or add one:

```bash
vercel env add AZURE_OPENAI_API_KEY production
vercel deploy --prod
```

### Observing the cron

In the Vercel dashboard: **Project → Crons** shows the next scheduled run, the last run's status, and links into the function logs. The `/api/ingest` response (`{ indexed, unchanged, skipped, errors }`) is the alarm signal — if `errors > 0` across two consecutive runs, something upstream (RSS, ES, embeddings) has broken.

## License

MIT.
