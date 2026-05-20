// @ts-nocheck
import { streamText, generateText, tool, jsonSchema, stepCountIs } from 'ai'
import { createAzure } from '@ai-sdk/azure'
import { es } from '@/lib/elasticsearch'
import { embedTexts } from '@/lib/embeddings'
import { Langfuse } from 'langfuse'

export const maxDuration = 60

let langfuse: Langfuse | null = null
try {
  if (process.env.LANGFUSE_SECRET_KEY) {
    langfuse = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
      secretKey: process.env.LANGFUSE_SECRET_KEY || '',
      baseUrl: process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com',
    })
  }
} catch {
  // Langfuse not available, continue without tracing
}

const llm = createAzure({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: process.env.AZURE_OPENAI_ENDPOINT ? `${process.env.AZURE_OPENAI_ENDPOINT}/openai` : undefined,
  resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME || 'info-mjnxtt51-eastus2',
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview',
  useDeploymentBasedUrls: true,
})

const SYSTEM_PROMPT = `You are an NVIDIA blog assistant. Answer questions about NVIDIA (GPUs, AI, CUDA, products, announcements, partnerships) using the search tool to retrieve passages from the NVIDIA blog corpus.

PROCESS
1. For every user question about NVIDIA, call the search tool BEFORE answering.
2. If the first search returns nothing useful, REFORMULATE the query (try synonyms, broader/narrower terms, or related product names) and search again. Try up to 3 different queries before giving up.
3. For questions about "latest", "newest", "recent", "this year", or anything time-sensitive, set sort_by="date_desc".
4. If you need the full text of a specific post you found, call get_full_post with its URL.

ANSWER FORMAT
- Be concise and technical. 2-6 sentences for most questions.
- Cite every factual claim with [N] markers matching the source index from search results.
- ALWAYS end the answer with a "Sources:" section listing every cited [N] as: [N] Title - URL
- If, after 2-3 reformulated searches, the corpus genuinely has no relevant content, say so plainly: "The NVIDIA blog archive I have access to doesn't cover that topic." Do not invent citations.
- Never list a URL in Sources that didn't come from a search result.
- If the question is not about NVIDIA at all, decline politely.`

const INDEX = 'nvidia-blogs'

const searchSchema = jsonSchema({
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query - keywords, product names, or natural language' },
    sort_by: { type: 'string', enum: ['relevance', 'date_desc'], description: 'Use date_desc for time-sensitive queries (latest/newest/recent), relevance otherwise' },
    limit: { type: 'number', description: 'Max results to return (default 5, max 10)' },
  },
  required: ['query', 'sort_by'],
  additionalProperties: false,
})

const getFullPostSchema = jsonSchema({
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The URL of the blog post' },
  },
  required: ['url'],
  additionalProperties: false,
})

export async function POST(req: Request) {
  const { messages } = await req.json()

  const trace = langfuse?.trace({
    name: 'chat-request',
    metadata: { messageCount: messages.length },
  })

  // Query rewrite for multi-turn conversations
  if (messages.length > 2) {
    try {
      const recentMessages = messages.slice(-6)
      await generateText({
        model: llm.chat(process.env.LLM_MODEL_MINI || 'gpt-5.4-nano'),
        system: "Rewrite the user's last message as a standalone search query using the conversation context. Output only the query, nothing else.",
        messages: recentMessages,
      })
    } catch {
      // Fall back to original query
    }
  }

  const result = streamText({
    model: llm.chat(process.env.LLM_MODEL || 'gpt-5.4-nano'),
    system: SYSTEM_PROMPT,
    messages,
    stopWhen: stepCountIs(8),
    tools: {
      search: tool({
        description:
          'Search the NVIDIA blog corpus. Returns up to 5 passages with title, URL, date, and content snippet. Use sort_by="date_desc" for time-sensitive queries.',
        inputSchema: searchSchema,
        execute: async ({ query, sort_by, limit }: { query: string; sort_by: 'relevance' | 'date_desc'; limit?: number }) => {
          const size = Math.min(limit || 5, 10)

          if (sort_by === 'date_desc') {
            const resp = await es.search({
              index: INDEX,
              size,
              query: { multi_match: { query, fields: ['title^2', 'content'] } },
              sort: [{ date: { order: 'desc' } }],
              _source: ['title', 'url', 'date', 'content'],
              collapse: { field: 'url' },
            })
            return formatHits(resp.hits.hits)
          }

          // Hybrid search with RRF. Falls back to BM25 if embeddings unavailable.
          let embedding: number[] | null = null
          try {
            ;[embedding] = await embedTexts([query], 0)
          } catch {
            embedding = null
          }

          if (!embedding) {
            const resp = await es.search({
              index: INDEX,
              size,
              query: { multi_match: { query, fields: ['title^2', 'content'] } },
              _source: ['title', 'url', 'date', 'content'],
            })
            return formatHits(dedupeByUrl(resp.hits.hits, size))
          }

          const resp = await es.search({
            index: INDEX,
            size,
            retriever: {
              rrf: {
                retrievers: [
                  {
                    standard: {
                      query: { multi_match: { query, fields: ['title^2', 'content'] } },
                    },
                  },
                  {
                    knn: {
                      field: 'embedding',
                      query_vector: embedding,
                      k: 20,
                      num_candidates: 100,
                    },
                  },
                ],
              },
            },
            _source: ['title', 'url', 'date', 'content'],
          })
          return formatHits(dedupeByUrl(resp.hits.hits, size))
        },
      }),
      get_full_post: tool({
        description: 'Get the full text of a blog post by URL. Use after search to read more detail.',
        inputSchema: getFullPostSchema,
        execute: async ({ url }: { url: string }) => {
          try {
            const resp = await es.search({
              index: INDEX,
              size: 100,
              query: { term: { url } },
              sort: [{ chunk_index: { order: 'asc' } }],
              _source: ['title', 'url', 'date', 'content', 'chunk_index'],
            })
            const hits = resp.hits.hits
            if (hits.length === 0) {
              return { error: 'Post not found in index' }
            }
            const first = hits[0]._source as Record<string, unknown>
            const content = hits
              .map((hit: any) => String((hit._source as Record<string, unknown>).content || ''))
              .join('\n\n')
            return {
              title: first.title,
              url: first.url,
              date: first.date,
              content,
            }
          } catch {
            return { error: 'Failed to fetch post' }
          }
        },
      }),
    },
    onFinish: async ({ usage }) => {
      try {
        trace?.generation({
          name: 'chat-completion',
          usage: {
            input: usage?.promptTokens,
            output: usage?.completionTokens,
            total: usage?.totalTokens,
          },
        })
        await langfuse?.flushAsync()
      } catch {
        // Ignore langfuse errors
      }
    },
  })

  return result.toUIMessageStreamResponse()
}

function dedupeByUrl(hits: any[], max: number): any[] {
  const seen = new Set<string>()
  const out: any[] = []
  for (const h of hits) {
    const url = (h._source as Record<string, unknown>).url as string
    if (seen.has(url)) continue
    seen.add(url)
    out.push(h)
    if (out.length >= max) break
  }
  return out
}

function formatHits(hits: any[]) {
  return hits.map((hit, index) => {
    const src = hit._source as Record<string, unknown>
    const content = String(src.content || '')
    return {
      index: index + 1,
      title: src.title,
      url: src.url,
      date: src.date,
      content: content.slice(0, 800),
    }
  })
}
