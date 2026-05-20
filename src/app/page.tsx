'use client'

import { Suspense, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  AssistantRuntimeProvider,
  useAssistantRuntime,
} from '@assistant-ui/react'
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk'
import { Thread } from '@/components/assistant-ui/thread'

function ReplayFromQueryParam() {
  const runtime = useAssistantRuntime()
  const searchParams = useSearchParams()
  const sentRef = useRef(false)

  useEffect(() => {
    if (sentRef.current) return
    const q = searchParams?.get('q')
    if (!q) return
    sentRef.current = true
    try {
      runtime.thread.append({
        role: 'user',
        content: [{ type: 'text', text: q }],
      })
    } catch (err) {
      console.error('Failed to replay query:', err)
    }
  }, [runtime, searchParams])

  return null
}

function HomeShell() {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: '/api/chat' }),
    suggestions: [
      { prompt: 'What is CUDA?' },
      { prompt: 'When was the latest NVIDIA GPU released?' },
      { prompt: 'Tell me about DGX Spark' },
      { prompt: 'How does DLSS work?' },
    ],
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ReplayFromQueryParam />
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="border-b border-border bg-background/80 backdrop-blur px-6 py-4 flex items-center gap-3 sticky top-0 z-10">
          <div className="w-9 h-9 rounded-md bg-[#76b900] flex items-center justify-center shadow-sm shadow-[#76b900]/30">
            <span className="text-black font-bold">N</span>
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-semibold leading-tight">NVIDIA Blog Assistant</h1>
            <p className="text-xs text-muted-foreground">
              Ask about GPUs, AI platforms, products, and recent announcements
            </p>
          </div>
          <Link
            href="/eval"
            className="text-xs text-muted-foreground hover:text-[#9bd02a]"
          >
            G-Eval →
          </Link>
        </header>
        <div className="flex-1 min-h-0">
          <Thread />
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeShell />
    </Suspense>
  )
}
