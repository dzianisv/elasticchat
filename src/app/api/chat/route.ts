// @ts-nocheck
import { streamText, tool, jsonSchema, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { es } from '@/lib/elasticsearch'
import { embedTexts } from '@/lib/embeddings'

export const maxDuration = 60

const llm = createOpenAI({
  apiKey: process.env.LLM_API_KEY || 'ollama',
  baseURL: process.env.LLM_BASE_URL || 'http://localhost:11434/v1',
})

const SYSTEM_PROMPT = `You are an NVIDIA blog assistant. Search for relevant blog posts to answer questions about NVIDIA technology, products, and announcements. Always cite sources with URLs. If the user's question is ambiguous, ask for clarification.`

const INDEX = 'nvidia-blogs'

const searchSchema = jsonSchema({
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    sort_by: { type: 'string', enum: ['relevance', 'date_desc'], description: 'Sort order. Default relevance.' },
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

  const result = streamText({
    model: llm.chat(process.env.LLM_MODEL || 'qwen3:4b', { structuredOutputs: false }),
    system: SYSTEM_PROMPT,
    messages,
    stopWhen: stepCountIs(5),
    tools: {
      search: tool({
        description:
          'Search NVIDIA blog posts by relevance (hybrid semantic + text) or by date. Returns top 5 results.',
        inputSchema: searchSchema,
        execute: async ({ query, sort_by }: { query: string; sort_by: 'relevance' | 'date_desc' }) => {
          if (sort_by === 'date_desc') {
            const resp = await es.search({
              index: INDEX,
              size: 5,
              query: {
                multi_match: {
                  query,
                  fields: ['title^2', 'content'],
                },
              },
              sort: [{ date: { order: 'desc' } }],
              _source: ['title', 'url', 'date', 'content'],
            })
            return formatHits(resp.hits.hits)
          }

          // Hybrid search with RRF
          const [embedding] = await embedTexts([query])
          const resp = await es.search({
            index: INDEX,
            size: 5,
            retriever: {
              rrf: {
                retrievers: [
                  {
                    standard: {
                      query: {
                        multi_match: {
                          query,
                          fields: ['title^2', 'content'],
                        },
                      },
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
          return formatHits(resp.hits.hits)
        },
      }),
      get_full_post: tool({
        description: 'Get the full content of a blog post by its URL.',
        inputSchema: getFullPostSchema,
        execute: async ({ url }: { url: string }) => {
          try {
            const resp = await es.get({
              index: INDEX,
              id: url,
              _source: ['title', 'url', 'date', 'content'],
            })
            const src = resp._source as Record<string, unknown>
            return {
              title: src.title,
              url: src.url,
              date: src.date,
              content: src.content,
            }
          } catch {
            return { error: 'Post not found' }
          }
        },
      }),
    },
  })

  return result.toUIMessageStreamResponse()
}

function formatHits(hits: any[]) {
  return hits.map((hit) => {
    const src = hit._source as Record<string, unknown>
    const content = String(src.content || '')
    return {
      title: src.title,
      url: src.url,
      date: src.date,
      content: content.slice(0, 500),
    }
  })
}
