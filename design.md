# ElasticChat — Design Document

Single source of truth for what this project is, what it must use, and what "done" looks like. Read this before changing the architecture.

## Product

NVIDIA blog assistant — a RAG chatbot that answers user questions about NVIDIA by retrieving passages from an Elasticsearch index built from the [NVIDIA Blog](https://blogs.nvidia.com) corpus, then citing them in its answer.

**Live**: https://elasticchat.vercel.app/

## Required components — reuse, do not reinvent

The repo is wired around specific libraries. Use them. Do not hand-roll equivalents.

| Surface | Library | Why this and not vanilla |
|---|---|---|
| Chat UI | **`@assistant-ui/react`** + **`@assistant-ui/react-ai-sdk`** | Production-grade chat primitives: streaming, auto-scroll, foldable tool calls, markdown, reasoning blocks, error handling, mobile, a11y. Hand-rolled `useChat` UIs miss most of this. |
| Chat runtime adapter | `useChatRuntime` + `AssistantChatTransport` (from `@assistant-ui/react-ai-sdk`) | Connects the Thread to the AI SDK streaming endpoint, handling UIMessage ↔ ModelMessage parts. |
| LLM streaming | **AI SDK v6** `streamText` + `convertToModelMessages` | `useChat` sends `UIMessage[]` (with `parts`); `streamText` expects `ModelMessage[]` (with `content`). Convert before calling, or the API returns a streaming error and the bubble never renders. **This is the bug we shipped once. Don't ship it again.** |
| Tool-call display | `ToolFallback` (from `src/components/assistant-ui/tool-fallback.tsx`) | Foldable card that shows tool name, status, raw args, and raw result. Users can inspect what the agent did. Wired through `MessagePrimitive.GroupedParts` in `thread.tsx`. |
| Markdown rendering | `MarkdownText` (from `src/components/assistant-ui/markdown-text.tsx`) | Renders assistant text inside the Thread with code blocks, lists, links. |
| Styling | Tailwind v4 + shadcn-style tokens from `globals.css` | Don't introduce parallel styling. |
| LLM provider | `@ai-sdk/azure` (`createAzure` → `gpt-5.4-nano`) | Already wired through env. |
| Embeddings | Azure dev AI `Cohere-embed-v3-english` (1024-d) | Free tier capped at 15 req/min and 150 req/day — see Known Constraints. |
| Vector search | Elasticsearch 8 `dense_vector` + BM25 via `retriever.rrf` | Hybrid retrieval. Falls back to BM25-only when embeddings unavailable. |
| Eval | LLM-as-judge in `scripts/eval.ts` | 20 fixed cases, scores R/C/A 0–5. |
| Real-browser test | Playwright in `tests/debug-live.spec.ts` and `tests/debug-ui.spec.ts` | Asserts the assistant bubble actually renders. SSE-byte tests don't count. |

If you find yourself writing a chat scroll viewport, a Composer with a Send button, a tool-call display, or a markdown renderer from scratch — stop. The library has it.

## Architecture

```
User ─▶ src/app/page.tsx
            │      (AssistantRuntimeProvider + Thread from @assistant-ui/react)
            ▼
       useChatRuntime ── AssistantChatTransport ── POST /api/chat
                                                      │
                                                      ▼
       src/app/api/chat/route.ts
            ├─ convertToModelMessages(messages)   ← async, must await
            ├─ streamText(model=gpt-5.4-nano, tools={search, get_full_post})
            │    └─ search tool ─▶ ES nvidia-blogs
            │          ├─ relevance: RRF(BM25 + kNN), falls back to BM25 on embed 429
            │          └─ date_desc: sort by date
            └─ result.toUIMessageStreamResponse()  ← SSE back to useChat

Vercel cron (02:00 UTC daily) ─▶ GET /api/ingest
                                  ├─ fetch RSS (last ~18 posts)
                                  ├─ cheerio extract, chunk 2000c / 200 overlap
                                  ├─ embed (16-chunk batches, paced for 15/min cap)
                                  ├─ bulk index into nvidia-blogs
                                  └─ update crawl-state hash for idempotency

scripts/seed.ts ─▶ Same path as ingest, bulk loader, supports:
                   - --sitemap N (1, 2, or 3; newest content lives in 3)
                   - SKIP_EMBED=1 to index BM25-only when daily embed cap hit
```

## File layout

| Path | Responsibility |
|---|---|
| `src/app/page.tsx` | Wraps `Thread` with `AssistantRuntimeProvider`. Sets suggestions. NVIDIA-themed header. |
| `src/app/layout.tsx` | Root layout; wraps `TooltipProvider`; applies `dark` class. |
| `src/app/globals.css` | Tailwind v4 + shadcn token theme + typography plugin. |
| `src/app/api/chat/route.ts` | Streaming chat: `convertToModelMessages` → `streamText` with `search` + `get_full_post` tools. BM25 fallback on embed-429. |
| `src/app/api/ingest/route.ts` | Cron-driven incremental ingest (RSS or sitemap). |
| `src/components/assistant-ui/thread.tsx` | The Thread layout — owns ThreadWelcome, suggestions wiring, composer, message rendering. Customize here (placeholder text, welcome copy). |
| `src/components/assistant-ui/tool-fallback.tsx` | Foldable tool-call card (name, status icon, args, result). |
| `src/components/assistant-ui/markdown-text.tsx` | Assistant text renderer. |
| `src/components/assistant-ui/tool-group.tsx`, `reasoning.tsx`, `attachment.tsx`, `tooltip-icon-button.tsx` | Other assistant-ui primitives. |
| `src/components/ui/*` | shadcn primitives (button, collapsible, dialog, tooltip, avatar). |
| `src/lib/elasticsearch.ts` | Lazy ES client. |
| `src/lib/embeddings.ts` | Cohere embeddings with 429 retry + daily-cap detection. |
| `src/lib/indexMappings.ts` | ES index mappings (single source of truth). |
| `scripts/seed.ts` | Bulk corpus loader. |
| `scripts/eval.ts` | G-Eval scorer. |
| `tests/debug-live.spec.ts` | Real-browser E2E against live deployment. |
| `tests/debug-ui.spec.ts` | UI-rendering assertion: clickable links in assistant bubble. |
| `tests/e2e.spec.ts` | Original Playwright suite — page loads + API responds. |
| `tests/ingest.spec.ts` | ES schema/count verification. |
| `vercel.json` | Daily ingest cron at 02:00 UTC. |

## ES schema (`nvidia-blogs`)

```
url           keyword
title         text
date          date
content       text
chunk_index   integer
embedding     dense_vector(1024, cosine, indexed)   ← optional; missing on BM25-only seeds
```

`crawl-state`: `{url, content_hash, last_crawled, status}` — keyed by URL, used for idempotent re-ingest.

## Definition of done

A change is "done" only after all of these:

1. **`npm run build` clean** (no TS errors).
2. **`npx playwright test tests/e2e.spec.ts`** passes (page + API).
3. **`BASE_URL=https://elasticchat.vercel.app npx playwright test tests/debug-live.spec.ts`** shows an assistant bubble in the DOM. SSE-byte assertions alone are not enough — the bubble must render in a real browser.
4. **A user query I have not tested before, typed into the live UI, returns a useful answer with citations**. The temptation is to trust that earlier queries working means new ones will. They won't always.
5. **G-Eval (`scripts/eval.ts`)** still hits R ≥ 3.0 and A ≥ 3.0 overall.
6. **`handoff.md` + this file (`design.md`)** updated if architecture, libraries, or invariants changed.

## Known constraints (don't fight these without new credentials)

1. **Azure dev-AI embeddings: 15 req/min and 150 req/day.** Bulk seeds beyond ~75 posts/day hit the daily cap. `scripts/seed.ts` supports `SKIP_EMBED=1` to index posts BM25-only and backfill embeddings later. Chat search auto-falls-back to BM25 when the per-query embed 429s.
2. **NVIDIA blog never had standalone "What is X" explainer posts for CUDA/DLSS/NeMo/TensorRT**; those live on developer.nvidia.com. To lift conceptual citation scores, add developer.nvidia.com as a second corpus source.
3. **Vercel GitHub auto-deploy is broken** — GitHub App `76526102` lacks repo access. Workaround: `npx vercel deploy --prod` using the token in `.env`. Permanent fix: grant access at https://github.com/settings/installations/76526102.

## G-Eval baseline (this release)

| Category | Relevance | Citation | Accuracy |
|---|---|---|---|
| conceptual | 5.00 | 3.00 | 4.40 |
| temporal | 3.83 | 3.33 | 2.50 |
| specific_product | 4.20 | 3.60 | 3.20 |
| edge_cases | 3.00 | 2.00 | 2.60 |
| **OVERALL** | **4.00** | **3.00** | **3.14** |

All three metrics are now above the 3.0 threshold. The previous "latest GPU" failure (R:2 A:2, where the model returned Vera CPU info) is fixed: the model now commits to "GeForce RTX 5090 / Blackwell, launched January 2025" using general NVIDIA knowledge when the corpus lacks a dedicated launch post. Temporal-A is still pulled down because the LLM judge can't verify those launch dates from corpus citations (the corpus has Blackwell benchmark posts, not a launch page) — the proper fix is to add developer.nvidia.com / the actual RTX 50 launch page to the corpus.

Edge_cases scores low by design because the judge penalizes correct refusals of off-topic questions (weather, AMD GPUs, empty input).

Live results: https://elasticchat.vercel.app/eval — every test case has a "Replay" button that re-runs the prompt in the chat.

## Open issues

Tracked at https://github.com/dzianisv/elasticchat/issues/1.

Top items: developer.nvidia.com corpus expansion, embedding-provider with no daily cap, CI, rate-limit/auth on `/api/chat`, Vercel GitHub App fix.
