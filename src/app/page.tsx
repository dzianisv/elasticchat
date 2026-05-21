'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { UIMessage } from 'ai'
import {
  AssistantRuntimeProvider,
  useAssistantRuntime,
} from '@assistant-ui/react'
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk'
import { Thread } from '@/components/assistant-ui/thread'
import { SiteFooter } from '@/components/site-footer'
import { APP_NAME } from '@/lib/appConfig'
import { PlusIcon } from 'lucide-react'

const CHAT_STORAGE_KEY = 'nvidia-chat-history'

function loadStoredMessages(): UIMessage[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as UIMessage[]) : []
  } catch {
    return []
  }
}

function saveMessages(messages: UIMessage[]) {
  try {
    window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages))
  } catch {}
}

function clearSavedMessages() {
  try {
    window.localStorage.removeItem(CHAT_STORAGE_KEY)
  } catch {}
}

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

interface HomeShellProps {
  initialMessages: UIMessage[]
  onNewChat: () => void
}

function HomeShell({ initialMessages, onNewChat }: HomeShellProps) {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: '/api/chat' }),
    messages: initialMessages,
    onFinish: ({ messages }) => saveMessages(messages),
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
            <h1 className="text-lg font-semibold leading-tight">{APP_NAME}</h1>
            <p className="text-xs text-muted-foreground">
              Ask about GPUs, AI platforms, products, and recent announcements
            </p>
          </div>
          <nav className="flex items-center gap-4 text-xs">
            <button
              onClick={onNewChat}
              className="flex items-center gap-1 text-muted-foreground hover:text-[#9bd02a] transition-colors"
              title="Start a new conversation"
            >
              <PlusIcon className="size-3.5" />
              New chat
            </button>
            <Link
              href="/eval"
              className="text-muted-foreground hover:text-[#9bd02a]"
            >
              G-Eval →
            </Link>
            <Link
              href="/ingest"
              className="text-muted-foreground hover:text-[#9bd02a]"
            >
              Ingestion →
            </Link>
          </nav>
        </header>
        <div className="flex-1 min-h-0">
          <Thread />
        </div>
        <SiteFooter />
      </div>
    </AssistantRuntimeProvider>
  )
}

export default function Home() {
  const [{ key, initialMessages }, setState] = useState({
    key: 0,
    initialMessages: [] as UIMessage[],
  })

  // Load persisted messages after first client render (avoids SSR/hydration mismatch).
  useEffect(() => {
    const stored = loadStoredMessages()
    if (stored.length > 0) {
      setState({ key: 1, initialMessages: stored })
    }
  }, [])

  const handleNewChat = () => {
    clearSavedMessages()
    setState(s => ({ key: s.key + 1, initialMessages: [] }))
  }

  return (
    <Suspense fallback={null}>
      <HomeShell key={key} initialMessages={initialMessages} onNewChat={handleNewChat} />
    </Suspense>
  )
}
