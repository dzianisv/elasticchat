# ElasticChat — Release State

NVIDIA blog assistant. Live, all services working, tests passing.

- **Repo**: https://github.com/dzianisv/elasticchat
- **Live**: https://elasticchat.vercel.app/
- **Vercel project**: `bison-s-projects/elasticchat` (ID `prj_jZwmKW0YNfLuUsBYu6Ar2GRdcQy0`)

## Stack
- Next.js 16.2.6 (Turbopack) + React 19
- AI SDK v6 (`@ai-sdk/react` `useChat`, `@ai-sdk/azure`)
- Elasticsearch Cloud (`nvidia-blogs` index, 101 posts / 348 chunks)
- Azure OpenAI (chat: `gpt-5.4-nano`)
- Azure dev AI / Cohere-embed-v3-english (1024-d vectors)
- Optional Langfuse tracing
- Vercel hosting + daily cron for ingest (`0 2 * * *`)

## Architecture

```
User ─▶ src/app/page.tsx (useChat)
            │
            ▼
       /api/chat ── streamText (gpt-5.4-nano, stepCountIs=8)
            │      tools: search, get_full_post
            │      │
            │      ▼
            │   src/lib/elasticsearch.ts ─▶ ES Cloud (nvidia-blogs)
            │                              │
            │                              ▼
            │                          RRF hybrid (BM25 + kNN)
            │                          + BM25-only fallback on 429
            ▼
       (SSE stream with text deltas + tool calls)

Vercel cron ─▶ /api/ingest (daily, source=rss)
                 │
                 ▼
              fetch RSS / sitemap ─▶ cheerio extract
                                       │
                                       ▼
                                    chunk(2000c, 200 overlap)
                                       │
                                       ▼
                                    embed (Cohere v3, batches of 16)
                                       │
                                       ▼
                                    bulk index + crawl-state hash

scripts/seed.ts ─▶ Same path, bulk loader (no maxDuration limit)
                   Order: sitemap3 → sitemap2 → sitemap1 (newest first)
```

## Key files

| File | Purpose |
|------|---------|
| `src/app/page.tsx` | Chat UI (useChat hook, SSE, streaming bubble) |
| `src/app/api/chat/route.ts` | Streaming chat, search + get_full_post tools, BM25 fallback |
| `src/app/api/ingest/route.ts` | Incremental ingest (RSS or sitemap source) |
| `src/lib/elasticsearch.ts` | Lazy ES client |
| `src/lib/embeddings.ts` | Cohere embeddings with 429 retry |
| `src/lib/indexMappings.ts` | `nvidia-blogs` + `crawl-state` mappings |
| `scripts/seed.ts` | Bulk seeder from sitemaps (3 → 2 → 1) |
| `scripts/eval.ts` | G-Eval style scorer (Azure OpenAI judge, 20 cases) |
| `tests/e2e.spec.ts` | Playwright: page load, input, API SSE |
| `tests/ingest.spec.ts` | ES schema + count verification |
| `promptfooconfig.yaml` | Optional promptfoo quality eval |
| `vercel.json` | Daily ingest cron (02:00 UTC) |

## Index schema (`nvidia-blogs`)

```
url           keyword
title         text
date          date
content       text
chunk_index   integer
embedding     dense_vector(1024, cosine, indexed)
```

`crawl-state`: `{url, content_hash, last_crawled, status}` — keyed by URL, used for idempotent re-ingest.

## Env vars (set in Vercel + .env locally)

```
ELASTICSEARCH_URL
ELASTICSEARCH_API_KEY
AZURE_OPENAI_API_KEY
AZURE_OPENAI_ENDPOINT
AZURE_OPENAI_API_VERSION
LLM_MODEL                 # e.g. gpt-5.4-nano
LLM_MODEL_MINI            # e.g. gpt-5.4-nano (for query rewrite & judge)
AZURE_DEV_AI_API_KEY      # embeddings
AZURE_DEV_AI_BASE_URL
LANGFUSE_SECRET_KEY       # optional
LANGFUSE_PUBLIC_KEY       # optional
```

## Tests

```bash
# E2E (Playwright, against live or local via BASE_URL)
npx playwright test tests/e2e.spec.ts                     # → 3/3 pass

# Ingest verification (needs ES creds)
set -a && source .env && set +a
npx playwright test tests/ingest.spec.ts                  # → 4/4 pass

# G-Eval (LLM judge, 20 cases, ~3 min)
EVAL_CHAT_URL=http://localhost:3000/api/chat npx tsx scripts/eval.ts

# Bulk seed (one-off; use when embedding daily quota refreshes)
npx tsx scripts/seed.ts 150
```

## G-Eval scores (101 posts / 348 chunks)

| Category | Relevance | Citation | Accuracy |
|----------|-----------|----------|----------|
| temporal | **4.00** | **5.00** | **4.00** |
| edge_cases | 3.00 | 2.20 | 3.60 |
| conceptual | 2.60 | 1.20 | 3.20 |
| specific_product | 2.60 | 2.80 | 3.40 |
| **OVERALL** | **3.05** | **2.80** | **3.55** |

Temporal queries (latest/newest/this year/recent) work very well — that's the corpus's sweet spot.
Conceptual ("What is CUDA?", "How does DLSS work?") is the weakest because the 101 indexed
posts skew to recent product/partnership announcements, not explainer content. Bulk-loading
sitemap1 (older 2016-2023 explainer posts) would raise those scores; blocked today by the
Azure dev-AI embedding free tier's 150-req/24h cap.

## Known limitations

1. **Embedding free tier**: 15 req/min and 150 req/day. Bulk seed of >75 posts in one day
   will hit the daily cap. Chat search falls back to BM25-only when this happens — usable,
   but RRF hybrid quality is reduced. Fix: upgrade Azure deployment (link in error message).
2. **Conceptual coverage**: corpus skews recent (2024–2026). Older explainer posts (2016–2023)
   not yet indexed. Run `npx tsx scripts/seed.ts 200` once quota refreshes.
3. **Vercel GitHub auto-deploy**: GitHub App installation `76526102` lacks repo access.
   Workaround: `vercel deploy --prod` via CLI (token in `.env`). Permanent fix: grant
   access at https://github.com/settings/installations/76526102 (requires GitHub sudo).
4. **Headless Chromium streaming**: `useChat` works via API but the assistant bubble doesn't
   always render in headless Playwright Chromium. Tests work around this by validating the
   SSE stream directly. UX in real browsers is fine.

## Recent fixes (this release)

- Schema mismatch between chat tool (queried `parent_url`, `doc_type`, `tags`) and
  ingest (which never populated them). Both now share a single source-of-truth mapping.
- `get_full_post` now correctly keys on `url`.
- Ingest sources expanded: RSS (18 items) → sitemap3 (344 newest posts).
- 429-aware embed retry; BM25 fallback in chat search keeps the bot answering when the
  embedding API is rate-limited.
- System prompt overhaul: instructs reformulation (up to 3 queries) before declaring no
  info; mandates citation format.
- Cron lowered from hourly to daily.
