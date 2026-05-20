'use client'

import { useChat } from '@ai-sdk/react'
import { UIMessage } from 'ai'
import { useRef, useEffect, useState, FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function hasActiveTool(message: UIMessage): boolean {
  return message.parts.some(
    (p) =>
      (p.type as string).startsWith('tool-') &&
      (p as { state?: string }).state !== 'output-available'
  )
}

const SUGGESTIONS = [
  'What is CUDA?',
  'Latest NVIDIA announcements',
  'Tell me about DGX Spark',
  'How does DLSS work?',
]

export default function Home() {
  const { messages, sendMessage, status } = useChat()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const isLoading = status === 'streaming' || status === 'submitted'

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages, isLoading])

  const send = (text: string) => {
    if (!text.trim() || isLoading) return
    sendMessage({ text })
    setInput('')
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    send(input)
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800/80 bg-gray-950/80 backdrop-blur px-6 py-4 flex items-center gap-3 sticky top-0 z-10">
        <div className="w-9 h-9 rounded-md bg-[#76b900] flex items-center justify-center shadow-sm shadow-[#76b900]/30">
          <span className="text-black font-bold">N</span>
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold leading-tight">NVIDIA Blog Assistant</h1>
          <p className="text-xs text-gray-500">
            Ask about GPUs, AI platforms, products, and recent announcements
          </p>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {messages.length === 0 && (
            <div className="mt-12 sm:mt-20">
              <p className="text-2xl font-medium text-gray-200 text-center">
                Ask me anything about NVIDIA
              </p>
              <p className="mt-2 text-sm text-gray-500 text-center">
                Answers are grounded in the NVIDIA blog with sources cited.
              </p>
              <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-xl mx-auto">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="text-left text-sm rounded-lg border border-gray-800 hover:border-[#76b900]/50 bg-gray-900/40 hover:bg-gray-900 px-4 py-3 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => {
            const text = getMessageText(m)
            const isUser = m.role === 'user'
            const stillCallingTools = !isUser && hasActiveTool(m) && !text
            return (
              <div
                key={m.id}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={
                    isUser
                      ? 'max-w-[85%] rounded-2xl rounded-tr-md px-4 py-2.5 bg-[#76b900] text-black text-sm font-medium'
                      : 'max-w-[90%] w-full sm:max-w-[85%] rounded-2xl rounded-tl-md px-4 py-3 bg-gray-900/70 border border-gray-800 text-sm leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-2 prose-headings:mt-3 prose-headings:mb-2 prose-a:text-[#9bd02a] prose-a:no-underline hover:prose-a:underline prose-code:text-[#9bd02a] prose-code:before:content-none prose-code:after:content-none prose-pre:bg-gray-950 prose-pre:border prose-pre:border-gray-800'
                  }
                >
                  {isUser ? (
                    text
                  ) : stillCallingTools ? (
                    <SearchingIndicator />
                  ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                  )}
                </div>
              </div>
            )
          })}

          {isLoading && messages.at(-1)?.role === 'user' && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-tl-md px-4 py-3 bg-gray-900/70 border border-gray-800">
                <SearchingIndicator />
              </div>
            </div>
          )}
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-gray-800/80 bg-gray-950/80 backdrop-blur px-4 sm:px-6 py-4"
      >
        <div className="max-w-3xl mx-auto flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about NVIDIA blog posts..."
            className="flex-1 bg-gray-900 border border-gray-800 focus:border-[#76b900]/60 rounded-xl px-4 py-3 text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-[#76b900]/40 transition-colors"
            autoFocus
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="bg-[#76b900] text-black font-medium px-5 rounded-xl text-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  )
}

function SearchingIndicator() {
  return (
    <div className="flex items-center gap-2 text-gray-400 text-sm">
      <span className="flex gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-pulse" />
        <span
          className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-pulse"
          style={{ animationDelay: '120ms' }}
        />
        <span
          className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-pulse"
          style={{ animationDelay: '240ms' }}
        />
      </span>
      Searching NVIDIA blog…
    </div>
  )
}
