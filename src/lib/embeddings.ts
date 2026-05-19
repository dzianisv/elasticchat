const EMBEDDING_MODEL = 'Cohere-embed-v3-english'
const EMBEDDING_DIMS = 1024

export { EMBEDDING_DIMS }

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await fetch(
    `${process.env.AZURE_DEV_AI_BASE_URL}/embeddings`,
    {
      method: 'POST',
      headers: {
        'api-key': process.env.AZURE_DEV_AI_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL }),
    }
  )
  if (!res.ok) {
    throw new Error(`Embeddings API error: ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  return data.data.map((d: any) => d.embedding)
}
