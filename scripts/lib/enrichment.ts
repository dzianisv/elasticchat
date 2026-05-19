import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

const llm = createOpenAI({
  apiKey: process.env.LLM_API_KEY || 'ollama',
  baseURL: process.env.LLM_BASE_URL || 'http://localhost:11434/v1',
})

const SYSTEM_PROMPT = `Extract metadata from this blog post. Return JSON only: {"tags": string[] (product names/technologies like H100, CUDA, Hopper), "doc_type": "blog_post"|"press_release"|"tutorial"|"announcement", "is_announcement": boolean}`

export async function enrichPost(
  title: string,
  content: string
): Promise<{ tags: string[]; doc_type: string; is_announcement: boolean }> {
  const input = `Title: ${title}\n\nContent: ${content.slice(0, 2000)}`

  try {
    const { text } = await generateText({
      model: llm.chat(process.env.LLM_MODEL || 'gpt-4o-mini'),
      system: SYSTEM_PROMPT,
      prompt: input,
    })

    const json = JSON.parse(text.replace(/```json?\n?/g, '').replace(/```/g, '').trim())
    return {
      tags: Array.isArray(json.tags) ? json.tags : [],
      doc_type: json.doc_type || 'blog_post',
      is_announcement: Boolean(json.is_announcement),
    }
  } catch (e) {
    console.warn(`  Enrichment failed, using defaults: ${(e as Error).message}`)
    return { tags: [], doc_type: 'blog_post', is_announcement: false }
  }
}
