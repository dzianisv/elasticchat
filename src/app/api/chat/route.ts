// @ts-nocheck
import { streamText, tool, jsonSchema, stepCountIs, convertToModelMessages } from 'ai'
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

const SYSTEM_PROMPT = `You are an NVIDIA expert assistant. The primary knowledge source is the indexed NVIDIA blog corpus (use the search tool); you may also draw on your general knowledge of NVIDIA technology when the corpus is thin, as long as you label it clearly.

PROCESS
1. For every NVIDIA-related question, call the search tool BEFORE answering.
2. If the first search returns no useful hit, REFORMULATE the query (synonyms, broader/narrower terms, related product names) and search again. Try up to 3 different queries.
3. For questions about "latest", "newest", "recent", "this year", or anything time-sensitive, set sort_by="date_desc".
4. If you need the full text of a post, call get_full_post with its URL.

ANSWERING
- Concise and technical. 2-6 sentences for most questions.
- ALWAYS end every NVIDIA-related answer with a "Sources:" section that lists 1-5 entries from search results, formatted as: [N] Title - URL. List the most relevant hits even if you only partially relied on them. Do NOT invent URLs.
- When search returns directly relevant passages: ground claims in those passages with inline [N] markers matching the Sources index.
- When search returns weakly-related passages: lead with what the corpus shows (cited inline), then add a short paragraph for additional context prefixed with "Background (general NVIDIA knowledge):". Still include the search hits under Sources.
- When search returns nothing useful: give a brief, factual general-knowledge answer prefixed with "Note: not directly covered in the blog corpus.". Still include the closest 1-3 search hits under Sources (do not invent any).
- If the question is genuinely off-topic (e.g., weather, unrelated company), decline briefly. Skip the Sources section entirely in that case.`

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

  // useChat (AI SDK v6) sends UIMessage[] with parts; streamText needs ModelMessage[]
  const modelMessages = Array.isArray(messages) && messages[0]?.parts
    ? await convertToModelMessages(messages)
    : messages

  const result = streamText({
    model: llm.chat(process.env.LLM_MODEL || 'gpt-5.4-nano'),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
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
