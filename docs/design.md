# NVIDIA Blog Chat Assistant — Design Document

## Overview

An AI-powered chat assistant that answers questions about NVIDIA technology, products, and announcements by searching indexed blog posts from blogs.nvidia.com.

## Architecture

```
blogs.nvidia.com → [Vercel: Ingest cron] → [Elastic Cloud: search + state]
User             → [Vercel: Chat API]    → [Elastic Cloud] + [LLM API]
                   [Vercel: Chat UI]
                                           [Langfuse: traces (optional)]
```

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router) | AI SDK v6 native, streaming |
| AI SDK | `ai` v6 + `@ai-sdk/openai` | `streamText`, `generateText`, `tool()` with `inputSchema` |
| Chat UI | Custom (`@ai-sdk/react` useChat) | NVIDIA green theme, UIMessage/parts format |
| Search | Elastic Cloud (Serverless ES 9.x) | Hybrid search: kNN + text with RRF |
| LLM | Azure OpenAI gpt-5.4-nano (upgradeable to gpt-5.4) | Via `@ai-sdk/azure`, deployment-based URLs |
| Embeddings | Azure Cohere-embed-v3-english (1024 dims) | Via `vibe-dev-ai.cognitiveservices.azure.com` |
| Observability | Langfuse Cloud (optional) | Traces, spans, token usage |
| Deploy | Vercel | Serverless functions, cron for ingest |
| Sessions | Browser localStorage | Client sends history, no server-side session store |
| Crawl state | Elasticsearch `crawl-state` index | Dedup via content hash |

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `ELASTICSEARCH_URL` | Elastic Cloud endpoint | Yes |
| `ELASTICSEARCH_API_KEY` | Elastic Cloud API key | Yes |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key | Yes |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint URL | Yes |
| `AZURE_OPENAI_API_VERSION` | API version (e.g. `2025-01-01-preview`) | Yes |
| `LLM_MODEL` | Deployment name (e.g. `gpt-5.4-nano`) | Yes |
| `LLM_MODEL_MINI` | Lightweight model for query rewrite | Yes |
| `AZURE_DEV_AI_API_KEY` | Azure AI key (for embeddings) | Yes |
| `AZURE_DEV_AI_BASE_URL` | Azure AI endpoint | Yes |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | No |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key | No |
| `LANGFUSE_BASEURL` | Langfuse endpoint | No |

## Data Model

### `nvidia-blogs` index

| Field | Type | Description |
|---|---|---|
| `url` | keyword | Blog post URL (used as doc ID for single-chunk posts) |
| `parent_url` | keyword | Parent post URL (for multi-chunk posts) |
| `title` | text (english) | Post title |
| `content` | text (english) | Chunk text content |
| `embedding` | dense_vector (1024, cosine) | Cohere-embed-v3-english vector |
| `date` | date | Published date |
| `tags` | keyword[] | Product names/technologies (H100, CUDA, etc.) |
| `doc_type` | keyword | blog_post, press_release, tutorial, announcement |
| `is_announcement` | boolean | Whether post announces a new product/service |

### `crawl-state` index

| Field | Type | Description |
|---|---|---|
| `url` | keyword | Post URL |
| `content_hash` | keyword | SHA256 of content (for change detection) |
| `last_crawled` | date | Last crawl timestamp |
| `status` | keyword | ok, error |

## Agent Design

### System Prompt

The agent MUST:
- Always search before answering (never fabricate)
- Cite every claim with numbered references `[1]`, `[2]`
- List all sources at the end with title + URL
- Use `sort_by: "date_desc"` for temporal queries
- Decline off-topic questions gracefully

### Tools

#### `search`
- Parameters: `query` (string), `sort_by` (relevance|date_desc), `doc_type` (optional), `tags` (optional), `limit` (optional)
- Relevance mode: hybrid kNN + text with RRF
- Date mode: text match + date sort descending

#### `get_full_post`
- Parameters: `url` (string)
- Fetches all chunks for a post by `parent_url` term query

### Multi-turn Query Rewrite

When conversation has >2 messages, the last user message is rewritten into a standalone query using `generateText` before being used in search. This handles follow-ups like "what about that one?" or "tell me more".

## Ingest Pipeline

1. **Discovery**: Paginate WP REST API at `blogs.nvidia.com/wp-json/wp/v2/posts` (fallback: HTML scraping if API doesn't return content)
2. **Dedup**: Check `crawl-state` index, skip if content hash matches
3. **Enrichment**: LLM extracts tags, doc_type, is_announcement
4. **Chunking**: 2048 chars (~512 tokens), 256 char overlap, paragraph-aware
5. **Embedding**: Azure Cohere-embed-v3-english, batch up to 100 chunks
6. **Indexing**: Bulk upsert to `nvidia-blogs`, update `crawl-state`

Runs as Vercel cron (`/api/ingest`) hourly, or manually via `npx tsx scripts/ingest.ts [limit]`.

## Evaluation

20 questions across 4 categories scored by LLM-as-judge (0-5):
- **Conceptual** (5): CUDA, tensor cores, NeMo, TensorRT, DLSS
- **Temporal** (5): latest GPU, newest posts, recent announcements
- **Specific Product** (5): H100 bandwidth, RTX 5090, DGX Spark, Jetson Orin, A100 vs H100
- **Edge Cases** (5): off-topic, vague, empty input

Metrics: relevance, citation quality, accuracy.

Run: `npx tsx scripts/eval.ts` → outputs `eval-report.json`.

## File Structure

```
src/
  app/
    api/
      chat/route.ts      — Agent API (streamText + tools)
      ingest/route.ts    — Cron ingest endpoint
    page.tsx             — Chat UI
    layout.tsx           — Root layout
  lib/
    elasticsearch.ts     — ES client singleton
    embeddings.ts        — Azure embedding function
    indexMappings.ts     — Index mapping definitions
scripts/
  ingest.ts              — Full ingest pipeline (CLI)
  eval.ts                — Eval suite with LLM-as-judge
  migrate-to-cloud.ts    — Local ES → Cloud ES migration
  lib/
    chunker.ts           — Paragraph-aware text chunking
    enrichment.ts        — LLM metadata extraction
docs/
  design.md              — This file
DEPLOY.md                — Deployment checklist
vercel.json              — Cron config
```

## Current Status

### Done
- Chat API with tool calling (search + get_full_post)
- Hybrid search (kNN + text + RRF)
- Multi-turn query rewrite
- Langfuse tracing (optional)
- Ingest pipeline via WP API with crawl_state dedup
- LLM enrichment (tags, doc_type, is_announcement)
- Eval script (20 questions)
- 37 docs migrated to Elastic Cloud (Serverless ES 9.x)
- Citation format enforcement in system prompt

### Open Issues
1. **RRF on ES 9 Serverless**: Need to verify RRF retriever syntax works on serverless (may differ from ES 8.x).
2. **Vercel deployment**: Account signup + env var config pending.
3. **ES client version**: Using `@elastic/elasticsearch@8` against ES 9.x serverless — may need upgrade.
4. **Model upgrade**: Currently using `gpt-5.4-nano` — can upgrade to `gpt-5.4` or `gpt-5.1` for better quality.

### Eval Baseline (with gpt-4o-mini)

| Category | Relevance | Citation | Accuracy |
|---|---|---|---|
| Conceptual | 4.0 | 0.0 | 4.0 |
| Temporal | 2.0 | 0.2 | 2.2 |
| Specific Product | 4.2 | 0.4 | 4.2 |
| Edge Cases | 2.4 | 0.0 | 4.2 |
| **Overall** | **3.15** | **0.15** | **3.65** |

Citation score expected to improve with stronger system prompt (applied after eval) and a more capable model (gpt-5.x).
