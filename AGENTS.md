<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Read design.md before editing

`design.md` is the single source of truth for this project. It lists the libraries you must reuse (`@assistant-ui/react`, `@assistant-ui/react-ai-sdk`, AI SDK v6 with `convertToModelMessages`, etc.) and the definition of "done".

If you find yourself hand-rolling a chat scroll viewport, a Composer, a tool-call card, a markdown renderer, or a `useChat` UI from scratch — stop and re-read design.md. Reuse the components in `src/components/assistant-ui/`.

# "Done" means it works in a real browser

`npm run build` succeeding is not "done". An SSE byte-stream test passing is not "done". The only valid completion check for a UI change:

```
BASE_URL=https://elasticchat.vercel.app npx playwright test tests/debug-live.spec.ts
```

…must show a non-empty assistant bubble in the DOM. Run it before claiming any UI or chat change is complete.
