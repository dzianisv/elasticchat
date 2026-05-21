// @ts-nocheck
import { randomUUID, createHash } from 'crypto'
import { streamText, tool, jsonSchema, stepCountIs, convertToModelMessages } from 'ai'
import { createAzure } from '@ai-sdk/azure'
import { after } from 'next/server'
import { es } from '@/lib/elasticsearch'
import { embedTexts } from '@/lib/embeddings'

export const maxDuration = 60

const LANGFUSE_BASEURL = process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com'
const LANGFUSE_AUTH = process.env.LANGFUSE_SECRET_KEY
  ? Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64')
  : null

async function langfuseIngest(batch: object[]) {
  if (!LANGFUSE_AUTH) return
  try {
    const res = await fetch(`${LANGFUSE_BASEURL}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${LANGFUSE_AUTH}`,
      },
      body: JSON.stringify({ batch }),
    })
    const text = await res.text()
    console.log('[langfuse] ingestion status:', res.status, text.slice(0, 200))
  } catch (e) {
    console.error('[langfuse] ingestion error:', e)
  }
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

PRODUCT-CATEGORY DISCIPLINE
- NVIDIA ships GPUs (GeForce RTX, RTX PRO, Quadro, Tesla, A100, H100, H200, B100, B200, GB200, Blackwell, Hopper, Ampere, Ada, Rubin) AND non-GPU products (CPUs like Grace/Vera; SmartNICs/DPUs like BlueField/ConnectX; switches like Spectrum-X/Quantum; platforms like DGX/HGX/MGX).
- When the user asks about a GPU, you MUST cite a GPU. Do NOT answer "latest GPU" with Grace, Vera, BlueField, Spectrum-X, ConnectX, or any non-GPU product. If date_desc search surfaces a CPU/networking post, IGNORE it and re-search with GPU-specific terms ("GeForce RTX", "Blackwell GPU", "Rubin GPU", "data center GPU", "RTX PRO", "RTX 5090", "RTX 5080").
- For "latest GPU" specifically: run sort_by=date_desc once, then run sort_by=relevance with "GeForce RTX" and "Blackwell GPU" or "Rubin GPU" so you have GPU-specific hits to choose from.
- If after up to 3 searches you still cannot find a dedicated GPU-release post in the corpus, DO NOT refuse to answer. Be decisive — name a specific GPU and year, do NOT hedge with "or" between product lines. Use this NVIDIA GPU launch reference (as of early 2026):
   • Consumer (current, shipping): GeForce RTX 50 series (Blackwell architecture). RTX 5090 + 5080 launched January 2025; RTX 5070 family followed Q1–Q2 2025. The RTX 50 line is the most recent SHIPPING GeForce.
   • Data center (current, shipping): Blackwell B100, B200, and GB200 NVL72 (Grace CPU + Blackwell GPU) — announced GTC 2024, shipping through 2024–2025. Blackwell is the most recent SHIPPING data-center GPU.
   • Next-gen disclosed (NOT yet released): Rubin and Rubin Ultra data-center GPUs paired with the Vera CPU (the "Vera Rubin NVL72" system) — announced for 2026, not yet shipping.
- CRITICAL: When the user asks about the "latest" or "most recent" GPU **released**, lead with the SHIPPING product (RTX 5090 / Blackwell B200). Do NOT lead with Vera Rubin NVL72 or any 2026-announced product — those are announcements, not releases. Vera by itself is a CPU; Rubin is the GPU paired with it.
  Format the fallback as: "Note: based on general NVIDIA knowledge — the blog corpus does not have a dedicated launch post for this. [your answer naming the specific shipping GPU(s) and year(s)]". Still cite the closest corpus hits you did find under Sources.

ANSWERING
- Concise and technical. 2-6 sentences for most questions.
- ALWAYS end every NVIDIA-related answer with a "Sources:" section that lists 1-5 entries from search results, formatted as: [N] Title - URL. List the most relevant hits even if you only partially relied on them. Do NOT invent URLs.
- When search returns directly relevant passages: ground claims in those passages with inline [N] markers matching the Sources index.
- When search returns weakly-related passages: lead with what the corpus shows (cited inline), then add a short paragraph for additional context prefixed with "Background (general NVIDIA knowledge):". Still include the search hits under Sources.
- When search returns nothing useful: STILL give a substantive answer. Use general NVIDIA knowledge and prefix the answer with "Note: not directly covered in the blog corpus —". A bare "I don't know" is NOT acceptable for any NVIDIA technology question. List the closest 1-3 search hits under Sources (do not invent any).
- If the question is genuinely off-topic (e.g., weather, unrelated company), decline briefly. Skip the Sources section entirely in that case.

FORBIDDEN RESPONSES (the user has explicitly complained about these)
- "I cannot determine X from the corpus" — REWRITE as "Based on general NVIDIA knowledge: [specific answer]" + the Note prefix.
- "The corpus does not contain a dedicated launch post" alone — only acceptable if IMMEDIATELY followed by your general-knowledge answer naming the specific shipping product + year.
- Hedging with "or" between two product lines when one is clearly the most-recently-shipped — commit to one.

WORKED EXAMPLE
Q: "When was the latest NVIDIA GPU released?"
A: "The most recently released NVIDIA GPU is the GeForce RTX 5090 (Blackwell), launched January 2025 (RTX 5080 the same month; RTX 5070 family followed Q1–Q2 2025). On the data-center side, NVIDIA Blackwell — B100, B200, and GB200 NVL72 — has been shipping through 2024–2025. (Rubin / Vera Rubin NVL72 is announced for 2026 but not yet released.)

Note: based on general NVIDIA knowledge — the blog corpus does not have a dedicated RTX 50 launch post; closest related corpus coverage below.

Sources:
[1] NVIDIA Blackwell Delivers Breakthrough Performance in Latest MLPerf Training Results - https://blogs.nvidia.com/blog/blackwell-performance-mlperf-training/
[2] (next closest hit)"`

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

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || req.headers.get('x-real-ip')
    || 'unknown'
  const userAgent = req.headers.get('user-agent') || 'unknown'

  // Stable session ID: hash of the first user message (groups all turns of one conversation)
  const firstUserText: string = (() => {
    const m = messages.find((msg: any) => msg.role === 'user')
    if (!m) return ''
    if (Array.isArray(m.parts)) return m.parts.find((p: any) => p.type === 'text')?.text || ''
    return typeof m.content === 'string' ? m.content : ''
  })()
  const sessionId = firstUserText
    ? createHash('sha256').update(firstUserText.substring(0, 200)).digest('hex').substring(0, 16)
    : undefined

  const traceId = randomUUID()
  const traceTimestamp = new Date().toISOString()

  console.log('[langfuse] enabled:', !!LANGFUSE_AUTH, '| traceId:', traceId)

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
    onFinish: ({ usage }) => {
      console.log('[langfuse] onFinish called')
      if (!LANGFUSE_AUTH) return
      const generationId = randomUUID()
      const finishTimestamp = new Date().toISOString()
      after(async () => {
        console.log('[langfuse] after() running, auth:', !!LANGFUSE_AUTH)
        await langfuseIngest([
          {
            id: randomUUID(),
            type: 'trace-create',
            timestamp: traceTimestamp,
            body: {
              id: traceId,
              name: 'chat-request',
              userId: ip,
              sessionId,
              metadata: { messageCount: messages.length, userAgent, ip },
              timestamp: traceTimestamp,
            },
          },
          {
            id: randomUUID(),
            type: 'generation-create',
            timestamp: finishTimestamp,
            body: {
              id: generationId,
              traceId,
              name: 'chat-completion',
              startTime: traceTimestamp,
              endTime: finishTimestamp,
              usage: {
                input: usage?.promptTokens,
                output: usage?.completionTokens,
                total: usage?.totalTokens,
              },
            },
          },
        ])
      })
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
