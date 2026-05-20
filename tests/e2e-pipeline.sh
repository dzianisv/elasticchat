#!/bin/bash
# Full E2E pipeline test for ElasticChat
# Validates: ingest → ES storage → chat API → LLM eval
set -euo pipefail

BASE_URL="${BASE_URL:-https://elasticchat.vercel.app}"

echo "============================================"
echo " ElasticChat E2E Pipeline Test"
echo " Target: $BASE_URL"
echo "============================================"

# --- Test 1: Verify ingest endpoint ---
echo ""
echo "=== Test 1: Ingest endpoint ==="
INGEST=$(curl -sf "$BASE_URL/api/ingest")
SUCCESS=$(echo "$INGEST" | jq -r '.success')
INDEXED=$(echo "$INGEST" | jq -r '.indexed')
echo "  success=$SUCCESS indexed=$INDEXED"
[ "$SUCCESS" = "true" ] || { echo "FAIL: Ingest endpoint returned success=false"; exit 1; }
echo "  PASS"

# --- Test 2: Verify ES has data ---
echo ""
echo "=== Test 2: Elasticsearch has indexed data ==="
if [ -n "${ELASTICSEARCH_URL:-}" ] && [ -n "${ELASTICSEARCH_API_KEY:-}" ]; then
  COUNT=$(curl -sf "$ELASTICSEARCH_URL/nvidia-blogs/_count" \
    -H "Authorization: ApiKey $ELASTICSEARCH_API_KEY" | jq '.count')
  echo "  Document count: $COUNT"
  [ "$COUNT" -gt 0 ] || { echo "FAIL: No documents in ES"; exit 1; }
  echo "  PASS"
else
  echo "  SKIP (ELASTICSEARCH_URL/ELASTICSEARCH_API_KEY not set)"
fi

# --- Test 3: Chat API returns streaming response ---
echo ""
echo "=== Test 3: Chat API returns response ==="
RESPONSE=$(curl -sf -X POST "$BASE_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"what latest gpu was released by nvidia"}]}')

# Extract text from SSE stream
TEXT=$(echo "$RESPONSE" | grep '"text-delta"' | sed 's/data: //g' | jq -r '.delta // empty' | tr -d '\n')
TEXT_LEN=${#TEXT}
echo "  Response length: $TEXT_LEN chars"
echo "  Preview: ${TEXT:0:150}..."

[ "$TEXT_LEN" -gt 50 ] || { echo "FAIL: Response too short ($TEXT_LEN chars)"; exit 1; }
echo "  PASS"

# --- Test 4: Response mentions NVIDIA/GPU ---
echo ""
echo "=== Test 4: Response is relevant ==="
if echo "$TEXT" | grep -iq "nvidia\|gpu\|rtx\|geforce\|blackwell\|hopper"; then
  echo "  PASS (contains NVIDIA/GPU terms)"
else
  echo "FAIL: Response doesn't mention NVIDIA or GPUs"
  exit 1
fi

# --- Test 5: Response has citations ---
echo ""
echo "=== Test 5: Response includes citations ==="
if echo "$TEXT" | grep -iq "nvidia.com\|blogs.nvidia"; then
  echo "  PASS (contains nvidia.com URLs)"
else
  echo "  WARN: No nvidia.com URLs found in response (may be acceptable)"
fi

# --- Test 6: LLM Eval (scripts/eval.ts) ---
echo ""
echo "=== Test 6: LLM Judge Evaluation ==="
if command -v npx &> /dev/null; then
  npx tsx scripts/eval.ts 2>&1 | tail -15
  
  if [ -f eval-report.json ]; then
    AVG_REL=$(jq '[.results[].scores.relevance] | add / length' eval-report.json)
    AVG_CIT=$(jq '[.results[].scores.citation] | add / length' eval-report.json)
    AVG_ACC=$(jq '[.results[].scores.accuracy] | add / length' eval-report.json)
    echo ""
    echo "  Averages: Relevance=$AVG_REL Citation=$AVG_CIT Accuracy=$AVG_ACC"
    
    # Accuracy should be >= 3.0
    ACC_OK=$(echo "$AVG_ACC >= 3.0" | bc)
    [ "$ACC_OK" = "1" ] || { echo "FAIL: Accuracy below threshold"; exit 1; }
    echo "  PASS (accuracy >= 3.0)"
  fi
else
  echo "  SKIP (npx not available)"
fi

echo ""
echo "============================================"
echo " ALL TESTS PASSED"
echo "============================================"
