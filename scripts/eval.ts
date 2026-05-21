import "dotenv/config";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import { AzureOpenAI } from "openai";

// Load env: prefer .env.local, fall back to .env
const envLocalPath = resolve(process.cwd(), ".env.local");
const envPath = existsSync(envLocalPath) ? envLocalPath : resolve(process.cwd(), ".env");
const envContent = readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const openai = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview",
});

const CHAT_API = process.env.EVAL_CHAT_URL || "https://elasticchat.vercel.app/api/chat";

interface TestCase {
  category: string;
  question: string;
}

const testCases: TestCase[] = [
  // Conceptual
  { category: "conceptual", question: "What is CUDA?" },
  { category: "conceptual", question: "How do tensor cores work?" },
  { category: "conceptual", question: "Explain NVIDIA NeMo" },
  { category: "conceptual", question: "What is TensorRT?" },
  { category: "conceptual", question: "How does DLSS work?" },
  // Temporal
  { category: "temporal", question: "What's the latest GPU NVIDIA released?" },
  { category: "temporal", question: "When was the latest NVIDIA GPU released?" },
  { category: "temporal", question: "What are the newest blog posts?" },
  { category: "temporal", question: "Recent announcements from NVIDIA" },
  { category: "temporal", question: "What did NVIDIA announce this year?" },
  { category: "temporal", question: "Latest news about robotics" },
  // Specific Product
  { category: "specific_product", question: "H100 memory bandwidth" },
  { category: "specific_product", question: "RTX 5090 specs" },
  { category: "specific_product", question: "DGX Spark features" },
  { category: "specific_product", question: "Jetson Orin specifications" },
  { category: "specific_product", question: "A100 vs H100 comparison" },
  // Edge Cases
  { category: "edge_cases", question: "What's the weather today?" },
  { category: "edge_cases", question: "Tell me about AMD GPUs" },
  { category: "edge_cases", question: "latest" },
  { category: "edge_cases", question: "H100" },
  { category: "edge_cases", question: "" },
  { category: "edge_cases", question: "nvidea tensor cores explaned" },
  { category: "edge_cases", question: "最新のNVIDIA GPUは何ですか？" },
  { category: "edge_cases", question: "I'm building a deep learning pipeline for medical image segmentation using 3D U-Net. I need to understand trade-offs between A100 vs H100 for training — memory bandwidth, NVLink topology, and MIG partitioning for multi-tenant inference." },
];

interface Scores {
  relevance: number;
  citation: number;
  accuracy: number;
  notes: string;
}

interface Result {
  category: string;
  question: string;
  response: string;
  scores: Scores;
  latency_ms: number;
}

async function streamChat(question: string): Promise<string> {
  const res = await fetch(CHAT_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: question }] }),
  });

  if (!res.ok) {
    return `[ERROR: ${res.status} ${res.statusText}]`;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.type === "text-delta" && parsed.delta) {
          text += parsed.delta;
        }
      } catch {}
    }
  }

  return text;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function judge(question: string, response: string): Promise<Scores> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
    model: process.env.LLM_MODEL_MINI || "gpt-5",
    messages: [
      {
        role: "system",
        content:
          'Score this chatbot response 0-5 on: relevance (does it answer the question?), citation (does it cite sources with URLs?), accuracy (is it factual based on context?). Return JSON only: {"relevance": N, "citation": N, "accuracy": N, "notes": "string"}',
      },
      {
        role: "user",
        content: `Question: ${question}\nResponse: ${response}`,
      },
    ],
  });

      const content = completion.choices[0]?.message?.content || "{}";
      try {
        const cleaned = content.replace(/```json\n?|```/g, "").trim();
        return JSON.parse(cleaned);
      } catch {
        return { relevance: 0, citation: 0, accuracy: 0, notes: "Failed to parse judge response" };
      }
    } catch (e: any) {
      if (e?.status === 429) {
        const wait = Math.max(5, (attempt + 1) * 5);
        process.stdout.write(`[rate-limited, waiting ${wait}s]`);
        await sleep(wait * 1000);
        continue;
      }
      throw e;
    }
  }
  return { relevance: 0, citation: 0, accuracy: 0, notes: "Rate limit exhausted" };
}

async function main() {
  console.log("Running eval against", CHAT_API);
  console.log("=".repeat(60));

  const results: Result[] = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const label = tc.question || "(empty string)";
    process.stdout.write(`[${i + 1}/${testCases.length}] ${label}...`);

    const t0 = Date.now();
    const response = await streamChat(tc.question);
    const latency_ms = Date.now() - t0;
    const scores = await judge(tc.question || "(empty input)", response);

    results.push({ category: tc.category, question: tc.question, response, scores, latency_ms });
    console.log(` R:${scores.relevance} C:${scores.citation} A:${scores.accuracy} ${latency_ms}ms`);
    await sleep(4500); // avoid rate limit (15 req/min)
  }

  // Category averages
  const categories = [...new Set(testCases.map((t) => t.category))];
  const categoryAverages: Record<string, { relevance: number; citation: number; accuracy: number }> = {};

  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    categoryAverages[cat] = {
      relevance: avg(catResults.map((r) => r.scores.relevance)),
      citation: avg(catResults.map((r) => r.scores.citation)),
      accuracy: avg(catResults.map((r) => r.scores.accuracy)),
    };
  }

  const timestamp = new Date().toISOString();
  const chatModel = process.env.LLM_MODEL || "gpt-5.4-nano";
  const judgeModel = process.env.LLM_MODEL_MINI || chatModel;
  const promptAuthorModel = process.env.PROMPT_AUTHOR_MODEL || "claude-opus-4-7";
  let commit = "";
  try { commit = execSync("git rev-parse --short HEAD").toString().trim(); } catch {}

  const latencies = [...results.map(r => r.latency_ms)].sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];

  const report = {
    results,
    categoryAverages,
    timestamp,
    commit,
    models: { chat: chatModel, judge: judgeModel, promptAuthor: promptAuthorModel },
    latency_p50_ms: p50,
    latency_p95_ms: p95,
  };
  writeFileSync("eval-report.json", JSON.stringify(report, null, 2));

  appendHistoryRow({
    timestamp,
    commit,
    chatModel,
    promptAuthorModel,
    judgeModel,
    nCases: results.length,
    relevance: avg(results.map((r) => r.scores.relevance)),
    citation: avg(results.map((r) => r.scores.citation)),
    accuracy: avg(results.map((r) => r.scores.accuracy)),
    categoryAverages,
    latency_p50_ms: p50,
    latency_p95_ms: p95,
  });

  // Regression gate
  if (existsSync(HISTORY_PATH)) {
    const rows = readFileSync(HISTORY_PATH, 'utf-8')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('"timestamp"'))
      .map(l => {
        const fields = l.match(/"(?:[^"]|"")*"/g) || []
        return {
          relevance: parseFloat(fields[6]?.replace(/"/g, '') || '0'),
          citation:  parseFloat(fields[7]?.replace(/"/g, '') || '0'),
          accuracy:  parseFloat(fields[8]?.replace(/"/g, '') || '0'),
        }
      })
    if (rows.length >= 2) {
      const prev = rows[rows.length - 2]
      const curr = rows[rows.length - 1]
      const THRESHOLD = 0.5
      let regressed = false
      for (const dim of ['relevance', 'citation', 'accuracy'] as const) {
        const drop = prev[dim] - curr[dim]
        if (drop > THRESHOLD) {
          console.error(`\n⚠ REGRESSION: ${dim} dropped ${drop.toFixed(2)} points (${prev[dim].toFixed(2)} → ${curr[dim].toFixed(2)})`)
          regressed = true
        }
      }
      if (regressed) process.exit(1)
    }
  }

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("CATEGORY AVERAGES");
  console.log("-".repeat(60));
  console.log(padR("Category", 20) + padR("Relevance", 12) + padR("Citation", 12) + padR("Accuracy", 12));
  console.log("-".repeat(60));
  for (const cat of categories) {
    const a = categoryAverages[cat];
    console.log(
      padR(cat, 20) + padR(a.relevance.toFixed(2), 12) + padR(a.citation.toFixed(2), 12) + padR(a.accuracy.toFixed(2), 12)
    );
  }
  console.log("-".repeat(60));
  const allScores = results.map((r) => r.scores);
  console.log(
    padR("OVERALL", 20) +
      padR(avg(allScores.map((s) => s.relevance)).toFixed(2), 12) +
      padR(avg(allScores.map((s) => s.citation)).toFixed(2), 12) +
      padR(avg(allScores.map((s) => s.accuracy)).toFixed(2), 12)
  );
  console.log(`\nLatency  p50: ${p50}ms  p95: ${p95}ms`);
  console.log("\nResults saved to eval-report.json");
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function padR(s: string, n: number): string {
  return s.padEnd(n);
}

const HISTORY_PATH = "eval-history.csv";
const HISTORY_HEADER =
  "timestamp,commit,chat_model,prompt_author_model,judge_model,n_cases,relevance,citation,accuracy,category_averages,latency_p50_ms,latency_p95_ms\n";

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function appendHistoryRow(row: {
  timestamp: string;
  commit: string;
  chatModel: string;
  promptAuthorModel: string;
  judgeModel: string;
  nCases: number;
  relevance: number;
  citation: number;
  accuracy: number;
  categoryAverages: Record<string, { relevance: number; citation: number; accuracy: number }>;
  latency_p50_ms: number;
  latency_p95_ms: number;
}) {
  if (!existsSync(HISTORY_PATH)) writeFileSync(HISTORY_PATH, HISTORY_HEADER);
  const cells = [
    row.timestamp,
    row.commit,
    row.chatModel,
    row.promptAuthorModel,
    row.judgeModel,
    String(row.nCases),
    row.relevance.toFixed(4),
    row.citation.toFixed(4),
    row.accuracy.toFixed(4),
    JSON.stringify(row.categoryAverages),
    String(Math.round(row.latency_p50_ms)),
    String(Math.round(row.latency_p95_ms)),
  ].map(csvCell);
  appendFileSync(HISTORY_PATH, cells.join(",") + "\n");
  console.log(`Appended run to ${HISTORY_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
