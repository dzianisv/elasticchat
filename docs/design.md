# NVIDIA Assistant — Design Document

Single source of truth for architecture, invariants, file responsibilities, and definition of "done".

## Overview

A RAG chatbot that answers NVIDIA questions by searching an Elasticsearch index of blog posts from multiple NVIDIA properties. The index is built from live RSS/Atom feeds and HTML-scraped listing pages; query-time retrieval uses hybrid BM25 + kNN (RRF). Every answer includes inline citations with source URLs.

## Architecture

```
blogs.nvidia.com      ┐
developer.nvidia.com  ├── RSS / Atom / HTML scrape
nvidianews.nvidia.com │       │
nvidia.com/geforce    ┘       ▼
docs.nvidia.com           GET /api/ingest  ← Vercel Cron (daily 02:00 UTC)
                               │
                        Elasticsearch 8
                        (nvidia-blogs + crawl-state)
                               │
User → POST /api/chat ─────────┘ + Azure OpenAI (gpt-5.4-nano)
       SSE stream → browser (assistant-ui Thread)
                               │
                        Langfuse (optional tracing)
```

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 App Router, Turbopack, React 19 |
| Chat UI | `@assistant-ui/react` + `@assistant-ui/react-ai-sdk` (Thread, ToolFallback, MarkdownText) |
| AI SDK | `ai` v6 — `streamText`, `convertToModelMessages`, `tool` |
| LLM | Azure OpenAI `gpt-5.4-nano` (env: `LLM_MODEL`) |
| Embeddings | Azure Cohere-embed-v3-english, 1024-d (free tier: 15 req/min, 150 req/day) |
| Search | Elasticsearch 8 — `dense_vector(1024, cosine)` + BM25 via `retriever.rrf` |
| Observability | Langfuse Cloud (optional — wired, disabled when keys absent) |
| Deploy | Vercel (single Next.js project: UI + API + cron) |
| Eval | LLM-as-judge (`gpt-5`, env: `LLM_MODEL_MINI`) — 23 fixed cases, CSV history |

## Critical invariants

### AI SDK v6 message conversion

`useChat` / `useChatRuntime` produces `UIMessage[]` (with `.parts`). `streamText` requires `ModelMessage[]` (with `.content`). These are different types. **Always call `await convertToModelMessages(messages)` before passing to `streamText`.**

Failure mode without it: the API streams a JSON error immediately, the UI renders nothing, but `npm run build` and unit tests still pass. This is the hardest regression to catch — only a real browser test reveals it.

### Definition of "done" for UI changes

```bash
BASE_URL=https://elasticchat.vercel.app npx playwright test tests/debug-live.spec.ts
```

The test must show a non-empty assistant bubble in the live DOM. `npm run build` passing is not sufficient.

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `AZURE_OPENAI_API_KEY` | Yes | Chat completions |
| `AZURE_OPENAI_ENDPOINT` | Yes | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_API_VERSION` | Yes | API version (default `2025-01-01-preview`) |
| `LLM_MODEL` | Yes | Chat model deployment name (default `gpt-5.4-nano`) |
| `LLM_MODEL_MINI` | Yes | Judge model for eval (default `gpt-5`) |
| `AZURE_DEV_AI_API_KEY` | Yes | Cohere embeddings API key |
| `AZURE_DEV_AI_BASE_URL` | Yes | Cohere embeddings endpoint |
| `ELASTICSEARCH_URL` | Yes | ES cluster endpoint |
| `ELASTICSEARCH_API_KEY` | Yes | ES API key |
| `PROMPT_AUTHOR_MODEL` | No | Recorded in eval CSV (default `claude-opus-4-7`) |
| `LANGFUSE_PUBLIC_KEY` | No | Enables Langfuse tracing when set |
| `LANGFUSE_SECRET_KEY` | No | Enables Langfuse tracing when set |
| `LANGFUSE_BASEURL` | No | Langfuse endpoint (default `https://cloud.langfuse.com`) |
| `VERCEL_TOKEN` | No | For `vercel deploy --prod` from CLI |

## Data model

### `nvidia-blogs` index

One document per text chunk (2000 chars, 200-char overlap).

| Field | Type | Description |
|---|---|---|
| `_id` | keyword | `{url}#{chunk_index}` |
| `url` | keyword | Source page URL |
| `title` | text | Page title |
| `date` | date | Published / last-modified date |
| `content` | text | Chunk text |
| `chunk_index` | integer | Position within the post |
| `source` | keyword | Feed label (e.g. `blogs.nvidia.com`, `developer.nvidia.com`) |
| `embedding` | dense_vector(1024, cosine) | Cohere-embed-v3-english vector; absent on BM25-only docs |

### `crawl-state` index

One document per source URL. Used for idempotent re-crawling.

| Field | Type | Description |
|---|---|---|
| `_id` | keyword | Source URL |
| `url` | keyword | Source URL (duplicate for filtering) |
| `content_hash` | keyword | SHA256 of extracted text — skip re-index if unchanged |
| `last_crawled` | date | Timestamp of last successful crawl |
| `status` | keyword | `indexed` or `error` |
| `source` | keyword | Feed label (same as `nvidia-blogs`) |

## Ingest pipeline

Route: `GET /api/ingest` (`src/app/api/ingest/route.ts`)

```
1. ensureIndices()       — create nvidia-blogs + crawl-state if missing
2. discover URLs         — source-specific (see Sources section)
3. for each URL:
   a. fetchContent()     — Readability (Firefox Reader Mode) → cheerio fallback
   b. sha256(text)       — skip if matches crawl-state hash
   c. deleteByQuery()    — remove old chunks for this URL
   d. chunkText()        — 2000-char chunks, 200-char overlap
   e. embedTexts()       — 16-chunk batches; 4.5s pacing between batches
                           skipped if ?skip_embed=1
   f. es.bulk()          — upsert all chunks (with or without embedding field)
4. update crawl-state    — url, content_hash, last_crawled, status, source
```

### Feed formats

| Source | Format | URL | Notes |
|---|---|---|---|
| `rss` (default) | RSS 2.0 | `blogs.nvidia.com/feed/` | `<item>` / `<pubDate>` |
| `sitemap` | XML sitemap | `blogs.nvidia.com/post-sitemap.xml` | sorted newest-first |
| `developer` | Atom | `developer.nvidia.com/blog/feed/` | `<entry>` / `<link rel=alternate>` / `<published>` |
| `press` | RSS 2.0 | `nvidianews.nvidia.com/rss.xml` | Note: `/rss` (no extension) returns HTML |
| `geforce` | HTML scrape | `nvidia.com/en-us/geforce/news/` | no RSS exists |
| `docs` | HTML scrape | `docs.nvidia.com/` | hub page → sub-doc links |
| `all` | all 5 above | parallel | `floor(limit/5)` per source |

### Embedding rate limits

Free-tier cap: **15 req/min, 150 req/day** (Azure Cohere-embed-v3-english).

On 429: `embeddings.ts` waits 65s and retries (up to 5×). With a full daily cap, this makes even a single post take >300s, exceeding Vercel's `maxDuration`. **Use `?skip_embed=1` when the cap is exhausted** — documents are indexed BM25-only (no `embedding` field). BM25 search still works; kNN just has no candidates for those docs. Re-run without `skip_embed=1` the next day to backfill vectors.

## Chat API

Route: `POST /api/chat` (`src/app/api/chat/route.ts`)

- Accepts `{ messages: UIMessage[] }` — converts to `ModelMessage[]` via `convertToModelMessages`
- `streamText` with two tools:
  - **`search`**: `query`, `sort_by` (relevance|date_desc), `limit` → ES hybrid RRF query
  - **`get_full_post`**: `url` → all chunks for a URL, concatenated
- On embed 429 at query time: falls back to BM25-only search automatically
- Langfuse: creates a trace per request with `model`, `userId`, token usage. Disabled when `LANGFUSE_SECRET_KEY` is absent.

## Eval suite

Script: `scripts/eval.ts`

23 fixed test cases across 4 categories:

| Category | Count | Examples |
|---|---|---|
| conceptual | 5 | "What is CUDA?", "How does DLSS work?" |
| temporal | 6 | "What's the latest GPU NVIDIA released?", "Recent announcements" |
| specific_product | 5 | "H100 memory bandwidth", "RTX 5090 specs" |
| edge_cases | 7 | empty string, typo ("nvidea tensor cores"), Japanese query, 400-word technical query, off-topic |

Each case is scored 0–5 by `LLM_MODEL_MINI` (currently `gpt-5`) on three dimensions: **relevance**, **citation**, **accuracy**.

**Regression gate**: after each run, compares scores to the previous CSV row. If any dimension drops >0.5 points, exits with code 1.

**Latency tracking**: `latency_ms` recorded per case; `latency_p50_ms` and `latency_p95_ms` appended to `eval-history.csv` and `eval-report.json`.

Output files:
- `eval-report.json` — full per-case results + category averages + latency
- `eval-history.csv` — one row per run: timestamp, commit, models, scores, latency

## File responsibilities

| Path | Responsibility |
|---|---|
| `src/app/page.tsx` | Chat UI shell — `AssistantRuntimeProvider` + `Thread`. Reads `?q=` and auto-sends. |
| `src/app/eval/page.tsx` | G-Eval results — reads `eval-history.csv` + `eval-report.json`, renders scores and Replay links. |
| `src/app/ingest/page.tsx` | Ingestion dashboard — live ES query on `crawl-state`, source breakdown table, stat tiles. |
| `src/app/api/chat/route.ts` | Streaming chat with `search` + `get_full_post` tools. Langfuse tracing. |
| `src/app/api/ingest/route.ts` | Cron-triggered ingest. Multi-source. `?skip_embed=1` for BM25-only mode. |
| `src/components/assistant-ui/*` | Thread, ToolFallback, MarkdownText — from `@assistant-ui/react`. |
| `src/lib/appConfig.ts` | `APP_NAME = "NVIDIA Assistant"` — single source of truth for app name. |
| `src/lib/elasticsearch.ts` | Lazy ES client singleton. |
| `src/lib/embeddings.ts` | `embedTexts()` — batches of 16, 429 retry with 65s backoff, throws after 5 attempts. |
| `src/lib/indexMappings.ts` | ES mapping definitions for both indices. |
| `scripts/seed.ts` | Local bulk loader — bypasses Vercel, hits ES cluster directly. Supports `SKIP_EMBED=1`. |
| `scripts/eval.ts` | G-Eval runner — streams from live API, scores with LLM judge, writes CSV + JSON. |
| `tests/*.spec.ts` | Playwright E2E tests. |
| `vercel.json` | Cron: `GET /api/ingest` daily at 02:00 UTC. |
| `docs/design.md` | This file. |
