# Deployment

Production runs on Vercel (`bison-s-projects/elasticchat`) with Elasticsearch Cloud and Azure OpenAI as external services.

## Prerequisites

1. **Elasticsearch Cloud** account with a deployment provisioned, plus an API key.
2. **Azure OpenAI** resource with `gpt-5.4-nano` (or equivalent) deployed as the chat model.
3. **Azure dev AI** (or any provider) with `Cohere-embed-v3-english` (1024-d) for embeddings.
4. **Vercel** project linked to this repo.
5. *(optional)* **Langfuse** account for tracing.

## Set Vercel env vars

In *Project Settings → Environment Variables*:

| Key | Notes |
|---|---|
| `ELASTICSEARCH_URL` | e.g. `https://....es.cloud.elastic.co:443` |
| `ELASTICSEARCH_API_KEY` | base64-encoded API key |
| `AZURE_OPENAI_API_KEY` | chat model key |
| `AZURE_OPENAI_ENDPOINT` | resource endpoint, no trailing path |
| `AZURE_OPENAI_API_VERSION` | e.g. `2025-01-01-preview` |
| `LLM_MODEL` | chat deployment name (e.g. `gpt-5.4-nano`) |
| `LLM_MODEL_MINI` | smaller-model deployment (same model is fine) |
| `AZURE_DEV_AI_API_KEY` | embedding model key |
| `AZURE_DEV_AI_BASE_URL` | embedding endpoint, includes `/openai/v1` |
| `LANGFUSE_PUBLIC_KEY` | optional |
| `LANGFUSE_SECRET_KEY` | optional |

## Deploy

```bash
# preferred (when GitHub auto-deploy works):
git push origin main

# fallback (current state of this repo — GitHub App lacks repo access):
set -a && source .env && set +a
npx vercel deploy --prod --token "$VERCEL_TOKEN" --yes
```

## Seed the index

The daily cron will keep things current, but on first deploy you need a baseline:

```bash
set -a && source .env && set +a
npx tsx scripts/seed.ts 200
```

This pulls newest posts from the NVIDIA blog sitemaps, chunks/embeds them, and indexes into the configured Elasticsearch cluster. Subject to the embedding model's daily quota (free tier: 150 req/day).

## Cron

`vercel.json` configures a daily cron at 02:00 UTC calling `/api/ingest`. Each run picks up posts new since the last run (idempotent via `crawl-state` content-hash).

## Smoke test live

```bash
BASE_URL=https://elasticchat.vercel.app npx playwright test tests/e2e.spec.ts
```

## Re-creating the index

If schema drift requires a clean rebuild:

```bash
set -a && source .env && set +a
curl -X DELETE "$ELASTICSEARCH_URL/nvidia-blogs"   -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY"
curl -X DELETE "$ELASTICSEARCH_URL/crawl-state"    -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY"
npx tsx scripts/seed.ts 200
```
