# ElasticChat

> A RAG chatbot that answers questions about NVIDIA by citing posts from the [NVIDIA Blog](https://blogs.nvidia.com).

**Live:** [elasticchat.vercel.app](https://elasticchat.vercel.app/) · **G-Eval:** [elasticchat.vercel.app/eval](https://elasticchat.vercel.app/eval) · **Issues:** [#1](https://github.com/dzianisv/elasticchat/issues/1)

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
- *(optional)* **Langfuse** — tracing

See [`design.md`](./design.md) for the full architectural contract, file responsibilities, ES schema, and definition of "done".

## Models

| Role | Model | Provider | Wired in |
|---|---|---|---|
| Chat / tool-calling LLM | `gpt-5.4-nano` (env: `LLM_MODEL`) | Azure OpenAI (`@ai-sdk/azure` `createAzure` → `useDeploymentBasedUrls`) | `src/app/api/chat/route.ts` |
| Embeddings | `Cohere-embed-v3-english`, 1024-d | Azure dev AI (free tier: **15 req/min, 150 req/day**) | `src/lib/embeddings.ts` |
| G-Eval judge | `gpt-4o-mini` by default (env: `LLM_MODEL_MINI`) | Azure OpenAI | `scripts/eval.ts` |

Knobs (override via env): `AZURE_OPENAI_RESOURCE_NAME`, `AZURE_OPENAI_API_VERSION` (default `2025-01-01-preview`), `LLM_MODEL`, `LLM_MODEL_MINI`. The embedding endpoint is `${AZURE_DEV_AI_BASE_URL}/embeddings` with the `api-key` header.

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
Vercel Cron ─▶ GET /api/ingest (App Router, maxDuration=300s)
                ├── ensureIndices()    create `nvidia-blogs` + `crawl-state` if missing
                ├── fetchFromRSS()     last ~18 posts from blogs.nvidia.com/feed/
                │   (or fetchFromSitemap when ?source=sitemap&limit=N)
                ├── for each post:
                │   ├── fetchContent() cheerio-strip nav/footer/share/scripts
                │   ├── sha256(body) → skip if hash matches crawl-state (idempotent)
                │   ├── chunkText()   2000c chunks, 200c overlap
                │   ├── embedTexts()  16-chunk batches, 4.5s pacing (≤15 req/min)
                │   └── es.bulk()     upsert all chunks for the URL
                └── update crawl-state with new hash + last_crawled
```

Schedule and trigger (`vercel.json`):

```json
{ "crons": [{ "path": "/api/ingest", "schedule": "0 2 * * *" }] }
```

- Runs **daily at 02:00 UTC**.
- Endpoint can also be called manually on prod or locally: `curl https://elasticchat.vercel.app/api/ingest` (RSS, default) or `curl 'https://elasticchat.vercel.app/api/ingest?source=sitemap&limit=200'` (bulk historical).
- `maxDuration = 300` is set in `src/app/api/ingest/route.ts` so a single invocation can ingest dozens of posts even with the 4.5s pacing between embed calls.
- Returns a JSON summary `{ indexed, unchanged, skipped, errors }` so you can spot regressions in the Vercel cron log.

Two ES indices, both managed by the route itself (`ensureIndices`):

| Index | Purpose | Mapping |
|---|---|---|
| `nvidia-blogs` | One doc per chunk. Hybrid search target. | `url` keyword, `title` text, `date` date, `content` text, `chunk_index` int, `embedding` dense_vector(1024, cosine, indexed) |
| `crawl-state` | One doc per source URL. Stores `content_hash` so unchanged posts skip re-embedding. | `url`, `content_hash`, `last_crawled`, `status` |

For bulk loading (e.g. fresh DB or developer machine), use the local CLI (does **not** go through Vercel — runs against the same ES cluster directly):

```bash
npx tsx scripts/seed.ts 200                # 200 newest from sitemap3
SKIP_EMBED=1 npx tsx scripts/seed.ts 200   # BM25-only when daily embed cap is hit
```

## Project layout

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | Chat UI shell, wraps `Thread` with `AssistantRuntimeProvider`. Reads `?q=` and auto-sends. |
| `src/app/eval/page.tsx` | Renders `eval-report.json` with per-case "Replay" buttons. |
| `src/app/api/chat/route.ts` | Streaming chat endpoint with `search` + `get_full_post` tools. |
| `src/app/api/ingest/route.ts` | Cron-driven incremental ingest. |
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

Q: What's the latest GPU NVIDIA released?

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

