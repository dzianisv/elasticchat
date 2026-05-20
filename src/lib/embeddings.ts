const EMBEDDING_MODEL = 'Cohere-embed-v3-english'
const EMBEDDING_DIMS = 1024

export { EMBEDDING_DIMS }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function embedTexts(texts: string[], maxRetries = 5): Promise<number[][]> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${process.env.AZURE_DEV_AI_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'api-key': process.env.AZURE_DEV_AI_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL }),
    })

    if (res.ok) {
      const data = await res.json()
      return data.data.map((d: { embedding: number[] }) => d.embedding)
    }

    if (res.status === 429 && attempt < maxRetries) {
      // Free tier limit: 15 req/60s. Wait at least 60s then retry.
      const wait = 65_000
      console.warn(`Embedding 429, waiting ${wait}ms (attempt ${attempt + 1}/${maxRetries})`)
      await sleep(wait)
      continue
    }

    const body = await res.text().catch(() => '')
    throw new Error(`Embeddings API error: ${res.status} ${body}`)
  }
  throw new Error('Embeddings API retries exhausted')
}
