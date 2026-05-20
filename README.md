# ElasticChat — NVIDIA Blog Assistant

RAG chatbot that answers questions about NVIDIA using passages indexed from the [NVIDIA Blog](https://blogs.nvidia.com).

**Live:** https://elasticchat.vercel.app/

```
User ─▶ Next.js UI (useChat) ─▶ /api/chat ─▶ Azure OpenAI (gpt-5.4-nano)
                                                │
                                                ▼ tool: search
                                       Elasticsearch RRF(BM25 + kNN)
                                                │
                                                ▼ tool: get_full_post
                                       (Cohere-embed-v3, 1024-d vectors)
```

A daily Vercel cron pulls new posts from the NVIDIA blog feed, chunks them, embeds them, and indexes them into Elasticsearch.

## Stack

- **Next.js 16** (App Router, Turbopack, React 19)
- **AI SDK v6** — `@ai-sdk/react` `useChat`, `@ai-sdk/azure` `streamText`
- **Elasticsearch 8** — `nvidia-blogs` index (BM25 + dense vector, RRF retriever)
- **Azure OpenAI** — `gpt-5.4-nano` for chat
- **Cohere-embed-v3-english** — 1024-d embeddings via Azure dev AI
- **Vercel** — hosting + daily cron at 02:00 UTC
- *(optional)* **Langfuse** — request/generation tracing

## Local development

```bash
cp .env.example .env       # fill in real values
npm install
npm run dev
```

Open http://localhost:3000.

## Tests

```bash
# Playwright E2E (page, input, streaming API)
npx playwright test tests/e2e.spec.ts

# Ingest + ES schema verification (needs ES creds)
set -a && source .env && set +a
npx playwright test tests/ingest.spec.ts

# G-Eval (LLM-judged quality scoring, 20 cases, ~3 min)
EVAL_CHAT_URL=http://localhost:3000/api/chat npx tsx scripts/eval.ts
```

## Corpus management

Daily cron at 02:00 UTC calls `/api/ingest` (defaults to RSS, last ~18 posts).

To bulk-seed historical posts (newest first across `post-sitemap3.xml` → `post-sitemap2.xml` → `post-sitemap.xml`):

```bash
npx tsx scripts/seed.ts 200    # seed up to 200 newest posts
```

The Azure dev-AI embedding model is rate-limited (15 req/min, 150 req/day on free tier). The seeder retries on 429s; the chat search falls back to BM25-only when the daily window is exhausted.

## Deployment

See [DEPLOY.md](./DEPLOY.md).

## Project layout

| Path | Purpose |
|------|---------|
| `src/app/page.tsx` | Chat UI |
| `src/app/api/chat/route.ts` | Streaming chat endpoint with `search` + `get_full_post` tools |
| `src/app/api/ingest/route.ts` | Incremental ingest (cron target) |
| `src/lib/elasticsearch.ts` | Lazy ES client |
| `src/lib/embeddings.ts` | Cohere embeddings with 429 retry |
| `src/lib/indexMappings.ts` | ES index mappings |
| `scripts/seed.ts` | Bulk seeder from sitemaps |
| `scripts/eval.ts` | G-Eval scorer (LLM-as-judge) |
| `tests/e2e.spec.ts` | Playwright UI + API tests |
| `tests/ingest.spec.ts` | ES schema and document verification |
| `promptfooconfig.yaml` | Promptfoo quality eval (alternative to scripts/eval.ts) |
| `vercel.json` | Daily ingest cron |
