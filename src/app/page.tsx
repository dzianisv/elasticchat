'use client'

import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk'
import { Thread } from '@/components/assistant-ui/thread'

export default function Home() {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: '/api/chat' }),
    suggestions: [
      { prompt: 'What is CUDA?' },
      { prompt: 'Latest NVIDIA announcements' },
      { prompt: 'Tell me about DGX Spark' },
      { prompt: 'How does DLSS work?' },
    ],
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
        </header>
        <div className="flex-1 min-h-0">
          <Thread />
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}
