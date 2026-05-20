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
- **Azure OpenAI** — `gpt-5.4-nano` for chat
- **Cohere-embed-v3-english** — 1024-d embeddings via Azure dev AI (free tier: 15 req/min, 150/day — chat auto-falls-back to BM25 when exhausted)
- **Vercel** — hosting + daily ingest cron
- *(optional)* **Langfuse** — tracing

See [`design.md`](./design.md) for the full architectural contract, file responsibilities, ES schema, and definition of "done".

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

## Corpus

The daily cron at 02:00 UTC calls `/api/ingest`, which:
1. fetches the NVIDIA blog RSS (~18 newest posts)
2. extracts main content with cheerio, chunks at 2000 chars (200 overlap)
3. embeds each chunk in 16-batch groups (paced for the 15 req/min cap)
4. bulk-indexes into `nvidia-blogs`
5. updates per-URL hashes in `crawl-state` for idempotency

To bulk-seed historical posts:

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

## Deployment

`npx vercel deploy --prod` (the project token is configured in `.env`).
GitHub auto-deploy is currently broken on the Vercel side — see [issue #1](https://github.com/dzianisv/elasticchat/issues/1).

## License

MIT.
