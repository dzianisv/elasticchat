# Test-Driven Development Plan

## Test Suite Overview

| # | Test | Type | Tool | Pass Criteria |
|---|------|------|------|---------------|
| 1 | Ingest indexes blog data into ES | Integration | API call + ES query | `indexed > 0` on first run; ES `nvidia-blogs` index has docs with `content`, `url`, `embedding` fields |
| 2 | Chat UI loads and accepts input | E2E | Playwright | Page loads, input visible, can type and submit |
| 3 | Chat returns relevant answer | E2E + LLM-eval | Playwright + G-Eval | Response mentions NVIDIA GPU, includes source URLs |
| 4 | Response quality meets threshold | Eval | Promptfoo / G-Eval | Relevance >= 3/5, Citation >= 3/5, Accuracy >= 3/5 |

---

## Test 1: Ingestion / Indexer

**Goal:** Verify the ingest pipeline fetches NVIDIA blog RSS, chunks content, generates embeddings, and stores documents in Elasticsearch.

**Steps:**
1. Call `POST /api/ingest` (or `GET` — the route handles both)
2. Assert response: `{ success: true, indexed: N }` where N >= 0
3. Query ES directly: `GET nvidia-blogs/_count` — assert count > 0
4. Spot-check a document: verify fields `url`, `title`, `content`, `embedding` (1024-dim vector), `published`

**Implementation:**
```bash
# Trigger ingest
curl -s https://elasticchat.vercel.app/api/ingest | jq '.success'

# Verify ES has data
curl -s "$ELASTICSEARCH_URL/nvidia-blogs/_count" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" | jq '.count'

# Spot-check document structure
curl -s "$ELASTICSEARCH_URL/nvidia-blogs/_search?size=1" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" | \
  jq '.hits.hits[0]._source | keys'
# Expected: ["content", "embedding", "published", "title", "url"]
```

---

## Test 2: Chat UI E2E (Playwright)

**Goal:** Open the app, type a question, receive a streamed response.

**Steps:**
1. Navigate to `https://elasticchat.vercel.app/`
2. Wait for chat input to be visible
3. Type: `what latest gpu was released by nvidia`
4. Submit (press Enter or click send)
5. Wait for response to appear (non-empty assistant message)
6. Extract the full response text

**Implementation (Playwright):**
```typescript
import { test, expect } from '@playwright/test';

test('chat returns relevant GPU answer', async ({ page }) => {
  await page.goto('https://elasticchat.vercel.app/');
  
  // Wait for input
  const input = page.getByRole('textbox');
  await expect(input).toBeVisible({ timeout: 10000 });
  
  // Type question and submit
  await input.fill('what latest gpu was released by nvidia');
  await input.press('Enter');
  
  // Wait for assistant response (streaming completes)
  const response = page.locator('[data-role="assistant"]').last();
  await expect(response).toBeVisible({ timeout: 30000 });
  await expect(response).not.toBeEmpty();
  
  // Extract text for evaluation
  const text = await response.textContent();
  console.log('Assistant response:', text);
  
  // Basic assertions
  expect(text?.toLowerCase()).toMatch(/nvidia|gpu|rtx|geforce|blackwell/i);
  expect(text?.length).toBeGreaterThan(50);
});
```

---

## Test 3: Response Quality (G-Eval / Promptfoo)

**Goal:** Use an LLM judge to evaluate the response against quality criteria.

**Evaluation Dimensions (G-Eval style):**
- **Relevance (1-5):** Does the answer address the question about NVIDIA's latest GPU?
- **Citation (1-5):** Does it include source URLs from nvidia.com/blogs?
- **Accuracy (1-5):** Are the stated facts correct and not hallucinated?
- **Groundedness (1-5):** Is the answer grounded in retrieved documents (not just parametric knowledge)?

**Pass Criteria:** All dimensions >= 3/5

**Implementation (Promptfoo config):**
```yaml
# promptfooconfig.yaml
providers:
  - id: https://elasticchat.vercel.app/api/chat
    config:
      method: POST
      headers:
        Content-Type: application/json
      body:
        messages:
          - role: user
            content: "{{prompt}}"
      responseParser: "extractLastAssistantMessage(json)"

prompts:
  - "what latest gpu was released by nvidia"
  - "tell me about nvidia robotics announcements"
  - "what is nvidia NeMo framework"

defaultTest:
  assert:
    - type: llm-rubric
      value: |
        Evaluate whether the response:
        1. Directly answers the user's question about NVIDIA
        2. Cites specific blog post URLs from blogs.nvidia.com
        3. Contains factually accurate information
        4. Is grounded in retrieved documents rather than general knowledge
      threshold: 0.6
    - type: contains-any
      value: ["nvidia.com", "blogs.nvidia.com"]
    - type: javascript
      value: "output.length > 100"
```

**Alternative: scripts/eval.ts (already implemented)**

The existing `scripts/eval.ts` already runs G-Eval style scoring with Azure OpenAI as judge. Run with:
```bash
npx tsx scripts/eval.ts
```

---

## Test 4: Full E2E Pipeline Test

**Goal:** Combine all tests into a single flow that validates the entire system.

**Steps:**
1. Verify ES has indexed data (Test 1)
2. Open UI, ask question, extract response (Test 2)
3. Evaluate response quality with LLM judge (Test 3)
4. Assert all pass criteria met

**Implementation:**
```bash
#!/bin/bash
# tests/e2e-pipeline.sh
set -e

echo "=== Test 1: Verify ES has indexed data ==="
COUNT=$(curl -s "$ELASTICSEARCH_URL/nvidia-blogs/_count" \
  -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" | jq '.count')
echo "ES doc count: $COUNT"
[ "$COUNT" -gt 0 ] || { echo "FAIL: No docs in ES"; exit 1; }

echo "=== Test 2: Chat API returns response ==="
RESPONSE=$(curl -s -X POST https://elasticchat.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"what latest gpu was released by nvidia"}]}')
# Parse SSE stream for final text
TEXT=$(echo "$RESPONSE" | grep 'text-delta' | jq -r '.delta' | tr -d '\n')
echo "Response length: ${#TEXT}"
[ "${#TEXT}" -gt 50 ] || { echo "FAIL: Response too short"; exit 1; }

echo "=== Test 3: Eval with LLM judge ==="
npx tsx scripts/eval.ts
# Check eval-report.json for passing scores
RELEVANCE=$(jq '.categoryAverages.temporal.relevance' eval-report.json)
echo "Temporal relevance: $RELEVANCE"

echo "=== ALL TESTS PASSED ==="
```

---

## Running Tests

```bash
# Unit/integration (ingest + ES verification)
npx tsx scripts/eval.ts

# E2E with Playwright
npx playwright test tests/e2e.spec.ts

# Full pipeline
bash tests/e2e-pipeline.sh

# Promptfoo evaluation
npx promptfoo eval --config promptfooconfig.yaml
```

---

## CI Integration

Add to `package.json`:
```json
{
  "scripts": {
    "test:eval": "tsx scripts/eval.ts",
    "test:e2e": "playwright test",
    "test:pipeline": "bash tests/e2e-pipeline.sh"
  }
}
```
