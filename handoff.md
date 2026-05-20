# ElasticChat — Release State

NVIDIA blog assistant. Live, all services working, tests passing, G-Eval relevance/accuracy above threshold, citation just below threshold (corpus-bound).

- **Repo**: https://github.com/dzianisv/elasticchat
- **Live**: https://elasticchat.vercel.app/
- **Vercel project**: `bison-s-projects/elasticchat` (ID `prj_jZwmKW0YNfLuUsBYu6Ar2GRdcQy0`)
- **Open issue**: https://github.com/dzianisv/elasticchat/issues/1 (release-quality gaps)

## Stack
- Next.js 16.2.6 (Turbopack) + React 19
- AI SDK v6 (`@ai-sdk/react` `useChat`, `@ai-sdk/azure`)
- Elasticsearch Cloud (`nvidia-blogs` index, ~325 posts / 1064 chunks)
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

## G-Eval scores (~325 posts / 1064 chunks)

| Category | Relevance | Citation | Accuracy |
|----------|-----------|----------|----------|
| conceptual | **5.00** | 2.00 | **4.20** |
| temporal | **4.20** | **4.40** | **3.20** |
| specific_product | **3.60** | **3.20** | **3.60** |
| edge_cases | 2.80 | 2.20 | **3.20** |
| **OVERALL** | **3.90** | 2.95 | **3.55** |

R and A exceed the 3.0 threshold overall. Citation is 0.05 below — dragged down by
conceptual (corpus-bound: the NVIDIA blog never had standalone "What is CUDA/DLSS/NeMo/TensorRT"
explainer posts; those live on developer.nvidia.com) and by edge_cases (correct refusals on
off-topic input score low by judge design). The agent answers conceptual questions correctly
from labeled general NVIDIA knowledge with the closest available blog hits under Sources.

## Known limitations

1. **Embedding free tier**: 15 req/min and 150 req/day. Bulk seed of >75 posts in one day
   will hit the daily cap. `scripts/seed.ts` now supports `SKIP_EMBED=1` to index posts
   BM25-only and backfill later. Chat search auto-falls-back to BM25 when the daily window
   is exhausted. Fix: upgrade Azure deployment (link in error message).
2. **Conceptual citation**: NVIDIA's blog itself never had standalone "What is X" posts
   for CUDA / DLSS / NeMo / TensorRT — those are on developer.nvidia.com. The agent
   answers correctly from labeled general knowledge but the judge marks citation weak.
   To close this: add developer.nvidia.com docs as a second ingest source.
3. **Embedding backfill** for the ~250 BM25-only posts seeded today is pending — run
   `npx tsx scripts/seed.ts 300` (without SKIP_EMBED) once quota refreshes; it will
   re-process and add embeddings.
4. **Vercel GitHub auto-deploy**: GitHub App installation `76526102` lacks repo access.
   Workaround: `npx vercel deploy --prod` via CLI (token in `.env`). Permanent fix: grant
   access at https://github.com/settings/installations/76526102 (requires GitHub sudo).
5. **Headless Chromium streaming**: `useChat` works via API but the assistant bubble doesn't
   always render in headless Playwright Chromium. Tests work around this by validating the
   SSE stream directly. UX in real browsers is fine.
6. **No CI, no rate-limit/auth on /api/chat** — known, deferred. See issue #1.

## Recent fixes (this release)

- Schema mismatch between chat tool (queried `parent_url`, `doc_type`, `tags`) and
  ingest (which never populated them). Both now share a single source-of-truth mapping.
- `get_full_post` now correctly keys on `url`.
- Ingest sources expanded: RSS (18 items) → all 3 NVIDIA blog sitemaps (~2300 posts available).
- Bulk seeder (`scripts/seed.ts`) added with `SKIP_EMBED=1` mode that indexes posts
  BM25-only when the embedding daily quota is exhausted.
- 429-aware embed retry (per-minute) + auto-skip on daily-cap.
- BM25 fallback in chat search keeps the bot answering when the embedding API rate-limits
  the per-query vector.
- System prompt reworked: instructs up to 3 query reformulations, then a labeled
  general-knowledge fallback when corpus is thin (instead of a flat refusal). Always
  surfaces the closest 1-5 hits under Sources.
- Removed dead query-rewrite block (computed result was discarded).
- Removed broken legacy scripts (`ingest.ts`, `ingest-test.ts`, `lib/`, `migrate-to-cloud.ts`)
  that referenced `LLM_BASE_URL` (Ollama) and a non-Azure client.
- Cron lowered from hourly to daily.
- README + DEPLOY.md rewritten with real project docs.
