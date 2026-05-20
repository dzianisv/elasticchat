# ElasticChat

> A RAG chatbot that answers questions about NVIDIA by citing posts from the NVIDIA blog corpus (blogs.nvidia.com, developer.nvidia.com, nvidianews.nvidia.com, and more).

**Live:** [elasticchat.vercel.app](https://elasticchat.vercel.app/) · **G-Eval:** [elasticchat.vercel.app/eval](https://elasticchat.vercel.app/eval) · **Ingestion:** [elasticchat.vercel.app/ingest](https://elasticchat.vercel.app/ingest) · **Issues:** [#1](https://github.com/dzianisv/elasticchat/issues/1)

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

Vercel cron (daily 02:00 UTC) ─▶ GET /api/ingest → RSS → chunk → embed → bulk index
```

## Stack

- **Next.js 16** (App Router, Turbopack, React 19)
- **[`@assistant-ui/react`](https://www.assistant-ui.com/)** + `@assistant-ui/react-ai-sdk` — chat UI primitives (Thread, ToolFallback, MarkdownText, foldable tool calls)
- **AI SDK v6** — `streamText`, `convertToModelMessages`, `tool`, `stepCountIs`
- **Elasticsearch 8** — `dense_vector(1024, cosine)` + BM25, combined via `retriever.rrf`
- **Vercel** — hosts the Next.js app, the chat API, and the ingest cron (all in one project)
- *(optional)* **Langfuse** (`cloud.langfuse.com`) — LLM observability: traces every `/api/chat` request with token usage (prompt + completion tokens). Enable by setting `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL` in env.

See [`design.md`](./design.md) for the full architectural contract, file responsibilities, ES schema, and definition of "done".

## Models

| Role | Model | Provider | Wired in |
|---|---|---|---|
| Chat / tool-calling LLM | `gpt-5.4-nano` (env: `LLM_MODEL`) | Azure OpenAI (`@ai-sdk/azure` `createAzure` → `useDeploymentBasedUrls`) | `src/app/api/chat/route.ts` |
| Embeddings | `Cohere-embed-v3-english`, 1024-d | Azure dev AI (free tier: **15 req/min, 150 req/day**) | `src/lib/embeddings.ts` |
| G-Eval judge | `gpt-5` (env: `LLM_MODEL_MINI`) | Azure OpenAI | `scripts/eval.ts` |

Knobs (override via env): `AZURE_OPENAI_RESOURCE_NAME`, `AZURE_OPENAI_API_VERSION` (default `2025-01-01-preview`), `LLM_MODEL`, `LLM_MODEL_MINI`, `PROMPT_AUTHOR_MODEL` (recorded in eval history, default `claude-opus-4-7`). The embedding endpoint is `${AZURE_DEV_AI_BASE_URL}/embeddings` with the `api-key` header.

When the daily embedding cap is exhausted, the chat endpoint (`src/app/api/chat/route.ts`) catches the 429 and falls back to BM25-only retrieval automatically — no human action needed. The ingest pipeline has the same retry-then-cap behavior in `src/lib/embeddings.ts`.

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
| `LLM_MODEL` (default `gpt-5.4-nano`), `LLM_MODEL_MINI` (default `gpt-4o-mini` for eval judge) | Model overrides |
| `LANGFUSE_*` *(optional)* | Tracing |

## Testing

```bash
# Live end-to-end (asserts the assistant bubble actually renders in a real browser)
BASE_URL=https://elasticchat.vercel.app npx playwright test tests/debug-live.spec.ts

# Page loads + API streams w/ citations
npx playwright test tests/e2e.spec.ts

# Tool-call UI: clickable source links + foldable tool calls
BASE_URL=https://elasticchat.vercel.app npx playwright test tests/debug-ui.spec.ts

# G-Eval (20 fixed cases, ~3 min, writes eval-report.json)
EVAL_CHAT_URL=https://elasticchat.vercel.app/api/chat npx tsx scripts/eval.ts
```

`npm run build` succeeding is **not** "done". The only completion check that counts is a Playwright run that shows a non-empty assistant bubble in the live DOM. See [`AGENTS.md`](./AGENTS.md).

## Ingestion pipeline

The ingest pipeline is a regular Next.js App-Router route, **not** a separate worker — Vercel hosts it as a serverless function and a Vercel Cron triggers it on schedule.

```
Vercel Cron ─▶ GET /api/ingest?source=rss (default)
                ├── ensureIndices()     create `nvidia-blogs` + `crawl-state` if missing
                ├── discover URLs       RSS feed or HTML listing (source-specific, see below)
                ├── for each URL:
                │   ├── fetchContent()  Mozilla Readability (Firefox Reader Mode algorithm)
                │   │                   → strips nav/ads/footer automatically, no CSS selectors
                │   │                   → falls back to cheerio if Readability throws
                │   ├── sha256(body)    skip if hash matches crawl-state (idempotent)
                │   ├── chunkText()     2000-char chunks, 200-char overlap
                │   ├── embedTexts()    16-chunk batches, 4.5s pacing (≤15 req/min cap)
                │   └── es.bulk()       upsert all chunks + store `source` label
                └── update crawl-state  url, content_hash, last_crawled, status, source
```

### Sources

| `?source=` | Discovery | URL | Confirmed |
|---|---|---|---|
| `rss` *(default, used by cron)* | RSS 2.0 | `blogs.nvidia.com/feed/` | ✓ |
| `sitemap` | XML sitemap | `blogs.nvidia.com/post-sitemap.xml` | ✓ |
| `developer` | RSS (Atom) | `developer.nvidia.com/blog/feed/` | ✓ 200 OK |
| `press` | RSS 2.0 | `nvidianews.nvidia.com/rss` | ✓ 200 OK |
| `geforce` | HTML scrape | `nvidia.com/en-us/geforce/news/` | links extracted, no RSS exists |
| `all` | all four above in parallel | `limit/4` per source | |

All sources use **Mozilla Readability** (`@mozilla/readability` + `jsdom`) for content extraction — same algorithm Firefox uses for Reader Mode. This replaces hand-coded CSS selectors and works reliably across all four domains without knowing their internal class names.

Schedule and trigger (`vercel.json`):

```json
{ "crons": [{ "path": "/api/ingest", "schedule": "0 2 * * *" }] }
```

- Runs **daily at 02:00 UTC** with `source=rss` (blogs.nvidia.com only — stays within the 150-embed/day free-tier cap).
- Additional sources can be triggered manually:

```bash
# Last ~20 posts from developer.nvidia.com/blog
curl 'https://elasticchat.vercel.app/api/ingest?source=developer&limit=20'

# Press releases from nvidianews.nvidia.com
curl 'https://elasticchat.vercel.app/api/ingest?source=press&limit=20'

# All sources, 5 posts each
curl 'https://elasticchat.vercel.app/api/ingest?source=all&limit=20'

# Bulk historical backfill from blogs.nvidia.com sitemap
curl 'https://elasticchat.vercel.app/api/ingest?source=sitemap&limit=200'
```

- `maxDuration = 300` (5 min) so a single invocation handles dozens of posts despite 4.5s pacing between embed calls.
- Returns `{ success, source, fetched, indexed, unchanged, skipped, errors, sources[] }`.
- Live ingestion status: [elasticchat.vercel.app/ingest](https://elasticchat.vercel.app/ingest) — shows last-crawled times, article list, and run history grouped by day.

### ES indices

Both indices are managed by `ensureIndices()` in the ingest route — no manual setup needed.

| Index | Purpose | Key fields |
|---|---|---|
| `nvidia-blogs` | One doc per chunk. Hybrid search target. | `url` kw, `title` text, `date` date, `content` text, `chunk_index` int, `source` kw, `embedding` dense_vector(1024, cosine) |
| `crawl-state` | One doc per source URL. Idempotency store. | `url`, `content_hash`, `last_crawled`, `status`, `source` |

The `source` field on every document records which feed/site supplied the content (`blogs.nvidia.com`, `developer.nvidia.com`, `nvidianews.nvidia.com`, `nvidia.com/geforce`), enabling per-source filtering in search queries.

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
| `src/app/ingest/page.tsx` | Ingestion dashboard — queries ES `crawl-state` live, shows last-crawled articles grouped by day. |
| `src/app/api/chat/route.ts` | Streaming chat endpoint with `search` + `get_full_post` tools. |
| `src/app/api/ingest/route.ts` | Cron-driven incremental ingest. Supports `?source=rss|sitemap|developer|press|geforce|all`. |
| `src/components/assistant-ui/*` | Thread, ToolFallback, MarkdownText — reused, not hand-rolled. |
| `src/lib/elasticsearch.ts` | Lazy ES client. |
| `src/lib/embeddings.ts` | Cohere embeddings with 429 retry + daily-cap detection. |
| `src/lib/indexMappings.ts` | ES index mappings. |
| `scripts/seed.ts` | Bulk loader (RSS + sitemaps). |
| `scripts/eval.ts` | G-Eval scorer. |
| `tests/*.spec.ts` | Playwright E2E + UI assertions. |
| `vercel.json` | Daily ingest cron. |

## Hosting on Vercel

Everything in this repo — the chat UI, the chat API, the ingest pipeline, the `/eval` results page — is deployed as **one Next.js project on Vercel**. There are no separate workers or services.

```
┌─────────────────────────────────────────────────────────────────┐
│  Vercel project: elasticchat (single Next.js App-Router app)    │
├─────────────────────────────────────────────────────────────────┤
│  Static / SSR pages                                             │
│    /          chat UI (assistant-ui Thread)                     │
│    /eval      G-Eval results, pre-rendered from eval-report.json│
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

External dependencies (none of them on Vercel infra):

- **Azure OpenAI** — chat completions, called from `/api/chat` per request.
- **Azure dev AI** — Cohere embeddings, called from `/api/chat` (query-time) and `/api/ingest` (index-time).
- **Elasticsearch 8** — vector + BM25 store. Two indices, both managed by `ensureIndices()` in the ingest route.

### Deploying

```bash
npx vercel deploy --prod    # the project token is in .env (VERCEL_TOKEN)
```

That uploads the local working tree directly. GitHub auto-deploy is currently broken on the Vercel side (the GitHub App `76526102` lost repo access) — see [issue #1](https://github.com/dzianisv/elasticchat/issues/1). The CLI workflow is the supported path until that's restored.

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

## Issues solved 

#### Q: What's the latest GPU NVIDIA released?

● Three layers, in order of how-deep-it-goes:

  1. Corpus structural gap (root)
  The index is RSS-driven from blogs.nvidia.com. NVIDIA never published a dedicated "RTX 5090 launch" post on the
  corporate blog — those announcements live on nvidia.com/geforce, the press room, and developer.nvidia.com. So when
  the model sorted by date for "latest", the newest items were Vera (CPU), Spectrum-X (networking), ServiceNow /
  Google Cloud partnerships — all real, all recent, none of them GPUs. The corpus literally cannot ground "latest GPU
  release date" from its own contents.
  
  2. Prompt didn't disambiguate categories or insist on a real answer
  The previous system prompt said "search → cite what you find". It didn't say:
  - GPU ≠ CPU ≠ DPU ≠ switch ≠ rack. Vera is a CPU, not a GPU.
  - "Released" ≠ "announced". Rubin is announced for 2026 — that's not a release.
  - If the corpus doesn't have the answer, commit to your general knowledge instead of refusing.
  
  So the model did the most literal thing: surface the freshest posts and call them the answer, even when they were a
  CPU.
  
  3. No worked example
  Models follow concrete examples far better than abstract rules. The old prompt had rules ("ground in passages with
  [N] markers", "label background knowledge"), but no exemplar. Once I added a single worked Q/A showing exactly how
  to answer "When was the latest NVIDIA GPU released?", behavior locked in across 3/3 sample calls.
  
  The fix that actually moved the needle was layer 3 — the WORKED EXAMPLE plus a FORBIDDEN list ("I cannot determine X
   from the corpus" → rewrite as a real answer). Layer 1 is the proper long-term fix (add developer.nvidia.com / the
  launch pages to the index — tracked in issue #1).
  
  A subtle related issue earlier in the session, separate from this one: useChat sends UIMessage[] (with parts), but
  streamText expects ModelMessage[] (with content). Without await convertToModelMessages(messages), /api/chat returned
   a streaming error and the bubble never rendered — that's why curl tests passed (curl used the legacy {role, 
  content: "string"} shape directly) but the browser showed nothing. Fixed in 15cf49a. Codified now in design.md as
  the canonical AI-SDK-v6 invariant so it can't regress silently.

#### Eval judge
Switching to gpt-5.4-mini would be a real improvement over the status quo (out-of-tier vs in-tier), but it still
  leaves the judge in-family. The well-known LLM-as-judge result is that same-family judges rate same-family outputs
  higher by ~0.2–0.5 on a 5-point scale, regardless of actual quality. Mini vs nano is a different model, but they
  share architecture, RLHF data, and refusal patterns — so the bias is reduced, not eliminated.


