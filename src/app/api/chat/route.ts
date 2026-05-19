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

const SYSTEM_PROMPT = `You are an NVIDIA blog assistant that answers questions using search results.

RULES:
- ALWAYS search before answering. Never make claims without search results.
- ALWAYS cite every factual claim with [1], [2], etc. matching the source index number.
- At the END of your response, list all sources as:

Sources:
[1] Title - URL
[2] Title - URL

- If search returns no results, say "I don't have information on that topic."
- For "latest/newest/recent" queries, use sort_by: "date_desc".
- Be concise and technical.
- If the question is off-topic (not about NVIDIA), politely decline.`

const INDEX = 'nvidia-blogs'

const searchSchema = jsonSchema({
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    sort_by: { type: 'string', enum: ['relevance', 'date_desc'], description: 'Sort order. Default relevance.' },
    doc_type: { type: 'string', enum: ['blog_post', 'press_release', 'tutorial', 'announcement'], description: 'Filter by document type' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (e.g. H100, CUDA)' },
    limit: { type: 'number', description: 'Max results to return (default 5)' },
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
  let rewrittenQuery: string | null = null
  if (messages.length > 2) {
    try {
      const recentMessages = messages.slice(-6)
      const rewriteResult = await generateText({
        model: llm.chat(process.env.LLM_MODEL_MINI || 'gpt-5.4-nano'),
        system: "Rewrite the user's last message as a standalone search query using the conversation context. Output only the query, nothing else.",
        messages: recentMessages,
      })
      rewrittenQuery = rewriteResult.text?.trim() || null
      trace?.generation({ name: 'query-rewrite', output: rewrittenQuery })
    } catch {
      // Fall back to original query
    }
  }

  const result = streamText({
    model: llm.chat(process.env.LLM_MODEL || 'gpt-5.4-nano'),
    system: SYSTEM_PROMPT,
    messages,
    stopWhen: stepCountIs(5),
    tools: {
      search: tool({
        description:
          'Search NVIDIA blog posts by relevance (hybrid semantic + text) or by date. Returns top 5 results.',
        inputSchema: searchSchema,
        execute: async ({ query, sort_by, doc_type, tags, limit }: { query: string; sort_by: 'relevance' | 'date_desc'; doc_type?: string; tags?: string[]; limit?: number }) => {
          const size = limit || 5
          const filters: any[] = []
          if (doc_type) filters.push({ term: { doc_type } })
          if (tags && tags.length > 0) filters.push({ terms: { tags } })

          if (sort_by === 'date_desc') {
            const must: any = { multi_match: { query, fields: ['title^2', 'content'] } }
            const searchQuery = filters.length > 0
              ? { bool: { must, filter: filters } }
              : must
            const resp = await es.search({
              index: INDEX,
              size,
              query: searchQuery,
              sort: [{ date: { order: 'desc' } }],
              _source: ['title', 'url', 'date', 'content', 'doc_type', 'tags'],
            })
            return formatHits(resp.hits.hits)
          }

          // Hybrid search with RRF
          const [embedding] = await embedTexts([query])
          const standardQuery = filters.length > 0
            ? { bool: { must: { multi_match: { query, fields: ['title^2', 'content'] } }, filter: filters } }
            : { multi_match: { query, fields: ['title^2', 'content'] } }

          const resp = await es.search({
            index: INDEX,
            size,
            retriever: {
              rrf: {
                retrievers: [
                  {
                    standard: {
                      query: standardQuery,
                    },
                  },
                  {
                    knn: {
                      field: 'embedding',
                      query_vector: embedding,
                      k: 20,
                      num_candidates: 100,
                      ...(filters.length > 0 ? { filter: { bool: { filter: filters } } } : {}),
                    },
                  },
                ],
              },
            },
            _source: ['title', 'url', 'date', 'content', 'doc_type', 'tags'],
          })
          return formatHits(resp.hits.hits)
        },
      }),
      get_full_post: tool({
        description: 'Get the full content of a blog post by its URL.',
        inputSchema: getFullPostSchema,
        execute: async ({ url }: { url: string }) => {
          try {
            const resp = await es.search({
              index: INDEX,
              size: 100,
              query: {
                term: { parent_url: url },
              },
              sort: [{ _score: { order: 'desc' } }],
              _source: ['title', 'url', 'date', 'content'],
            })
            const hits = resp.hits.hits
            if (hits.length === 0) {
              return { error: 'Post not found' }
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
            return { error: 'Post not found' }
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

function formatHits(hits: any[]) {
  return hits.map((hit, index) => {
    const src = hit._source as Record<string, unknown>
    const content = String(src.content || '')
    return {
      index: index + 1,
      title: src.title,
      url: src.url,
      date: src.date,
      content: content.slice(0, 500),
    }
  })
}
