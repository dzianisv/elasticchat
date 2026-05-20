# ElasticChat Handoff

## Project
NVIDIA blog assistant deployed on Vercel with Elasticsearch backend.
- **Repo**: https://github.com/dzianisv/elasticchat
- **Live**: https://elasticchat.vercel.app/
- **Vercel project**: `bison-s-projects/elasticchat`, ID: `prj_jZwmKW0YNfLuUsBYu6Ar2GRdcQy0`, Team: `team_b6V25Bg4KWMiEIfaa5s3nmFX`

## Stack
- Next.js 16, AI SDK v6, `@ai-sdk/react` `useChat`, `@ai-sdk/azure`
- Elasticsearch Cloud (`nvidia-blogs` index, 53 docs, 18 crawled URLs)
- Azure OpenAI (embeddings + chat)
- Vercel (hosting + cron for ingest)

## Current State

### Working
- Chat API streaming with tool calls (search + get_full_post)
- Ingest pipeline (RSS crawl → chunk → embed → index)
- All tests pass locally: E2E 3/3, Ingest 4/4, Pipeline 6/6
- Eval pipeline (promptfoo G-Eval): accuracy 3.25/5

### NOT Complete

1. **Vercel auto-deploy from GitHub broken**
   - Vercel GitHub App (installation `76526102`) on `dzianisv` account doesn't have access to `elasticchat` repo
   - Fix: Go to https://github.com/settings/installations/76526102 → grant access to `elasticchat` repo
   - Requires GitHub sudo mode (password entry)

2. **Eval quality scores are low**
   - Relevance: 1.35/5, Citation: 1.9/5
   - Root cause: only 53 chunks from 18 RSS blog posts — very small corpus
   - Fix options:
     a. Expand ingest to crawl full blog post HTML (not just RSS summary)
     b. Add more RSS feeds or sitemap crawling
     c. Tune chunking strategy (currently basic)
     d. Improve system prompt for citation formatting

3. **Browser E2E test doesn't verify full assistant response**
   - `useChat` streaming works via API but assistant bubble never renders in headless Chromium
   - Root cause unknown — possibly AI SDK v6 streaming format + React 19 hydration issue in headless mode
   - Current workaround: API-level test validates full streaming response
   - Proper fix: debug why `useChat` `sendMessage` doesn't produce visible text parts in Playwright's Chromium

## Key Files
| File | Purpose |
|------|---------|
| `src/app/page.tsx` | Chat UI (useChat hook) |
| `src/app/api/chat/route.ts` | Streaming chat with ES search tool |
| `src/app/api/ingest/route.ts` | RSS crawl + embed + index |
| `src/lib/elasticsearch.ts` | ES client |
| `src/lib/embeddings.ts` | Azure OpenAI embeddings |
| `tests/e2e.spec.ts` | Playwright E2E tests |
| `tests/ingest.spec.ts` | ES ingest verification |
| `promptfooconfig.yaml` | G-Eval quality eval |
| `tests/e2e-pipeline.sh` | Full pipeline shell test |
| `vercel.json` | Cron config (`0 2 * * *` for ingest) |
| `.env` | Local secrets (NOT committed) |
| `.env.example` | Template for required env vars |

## Environment Variables Needed
```
ELASTICSEARCH_URL=
ELASTICSEARCH_API_KEY=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_RESOURCE_NAME=
AZURE_OPENAI_API_VERSION=
LLM_MODEL=
LLM_MODEL_MINI=
EMBEDDING_MODEL=
LANGFUSE_SECRET_KEY= (optional)
LANGFUSE_PUBLIC_KEY= (optional)
```

All are set in `.env` locally and in Vercel project env vars.

## Suggested Next Steps (priority order)

1. Fix Vercel GitHub App access (manual, needs password)
2. Expand corpus — crawl full blog HTML to improve relevance/citation scores
3. Debug headless Chromium rendering issue with `useChat` streaming
4. Add CI workflow (GitHub Actions) to run tests on push
5. Consider adding more eval test cases to `promptfooconfig.yaml`

## Running Tests
```bash
# E2E (no env needed, hits Vercel)
npx playwright test tests/e2e.spec.ts

# Ingest (needs ES creds)
set -a && source .env && set +a && npx playwright test tests/ingest.spec.ts

# Full pipeline
bash tests/e2e-pipeline.sh

# Eval (needs Azure OpenAI + ES)
npx promptfoo eval
```
