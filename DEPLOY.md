# Deployment Checklist

## 1. Elastic Cloud Setup

1. Go to https://cloud.elastic.co/ and sign up (14-day free trial)
2. Create a new deployment (choose closest region)
3. Copy the **Elasticsearch endpoint URL** (e.g. `https://my-deploy.es.us-east-1.aws.elastic.co`)
4. Create an API key: Kibana > Stack Management > API Keys > Create
5. Copy the **base64-encoded API key**

## 2. Vercel Setup

1. Go to https://vercel.com and sign up with GitHub
2. Import this repository (`elasticchat`)
3. Set the framework to **Next.js** (should auto-detect)

## 3. Langfuse Setup (Optional)

1. Go to https://langfuse.com and sign up
2. Create a project, copy the public/secret keys and host URL

## 4. Set Environment Variables in Vercel

Go to Project Settings > Environment Variables and add:

| Variable | Description |
|----------|-------------|
| `ELASTICSEARCH_URL` | Elastic Cloud endpoint (e.g. `https://....es.cloud.elastic.co`) |
| `ELASTICSEARCH_API_KEY` | Base64 API key from Elastic Cloud |
| `LLM_BASE_URL` | LLM inference endpoint URL |
| `LLM_API_KEY` | API key for the LLM endpoint |
| `LLM_MODEL` | Model name (e.g. `gpt-4o-mini`) |
| `LANGFUSE_PUBLIC_KEY` | (Optional) Langfuse public key |
| `LANGFUSE_SECRET_KEY` | (Optional) Langfuse secret key |
| `LANGFUSE_HOST` | (Optional) Langfuse host URL |

## 5. Deploy

```bash
vercel deploy --prod
```

Or just push to `main` — Vercel will auto-deploy if the GitHub integration is connected.

## 6. Migrate Data to Elastic Cloud

After Elastic Cloud is provisioned, migrate your local index:

```bash
ELASTICSEARCH_URL=https://your-cloud-endpoint ELASTICSEARCH_API_KEY=your-api-key npx tsx scripts/migrate-to-cloud.ts
```

This reads all documents from `http://localhost:9200/nvidia-blogs` and re-indexes them into the remote cluster.

### Alternative: elasticdump

```bash
npx elasticdump --input=http://localhost:9200/nvidia-blogs --output=https://your-cloud-endpoint/nvidia-blogs --type=mapping --headers='{"Authorization":"ApiKey YOUR_API_KEY"}'
npx elasticdump --input=http://localhost:9200/nvidia-blogs --output=https://your-cloud-endpoint/nvidia-blogs --type=data --headers='{"Authorization":"ApiKey YOUR_API_KEY"}'
```

## Cron Jobs

The `vercel.json` configures a cron job at `/api/ingest` running every hour. This will work automatically once deployed to Vercel.
