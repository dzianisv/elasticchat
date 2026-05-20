import Link from "next/link";
import { readFileSync } from "fs";
import { SiteFooter } from "@/components/site-footer";
import { resolve } from "path";
import evalReport from "../../../eval-report.json";
import { APP_NAME } from "@/lib/appConfig";

type Scores = {
  relevance: number;
  citation: number;
  accuracy: number;
  notes: string;
};

type Result = {
  category: string;
  question: string;
  response: string;
  scores: Scores;
};

type Report = {
  results: Result[];
  categoryAverages: Record<
    string,
    { relevance: number; citation: number; accuracy: number }
  >;
  timestamp: string;
};

const report = evalReport as Report;

type HistoryRow = {
  timestamp: string;
  commit: string;
  chat_model: string;
  prompt_author_model: string;
  judge_model: string;
  n_cases: number;
  relevance: number;
  citation: number;
  accuracy: number;
  category_averages: Record<
    string,
    { relevance: number; citation: number; accuracy: number }
  >;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      cell = "";
      row = [];
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function loadHistory(): HistoryRow[] {
  try {
    const text = readFileSync(resolve(process.cwd(), "eval-history.csv"), "utf-8");
    const rows = parseCsv(text);
    if (rows.length < 2) return [];
    const header = rows[0];
    const idx = (name: string) => header.indexOf(name);
    return rows.slice(1).map((r) => ({
      timestamp: r[idx("timestamp")] || "",
      commit: r[idx("commit")] || "",
      chat_model: r[idx("chat_model")] || "",
      prompt_author_model: r[idx("prompt_author_model")] || "",
      judge_model: r[idx("judge_model")] || "",
      n_cases: Number(r[idx("n_cases")] || 0),
      relevance: Number(r[idx("relevance")] || 0),
      citation: Number(r[idx("citation")] || 0),
      accuracy: Number(r[idx("accuracy")] || 0),
      category_averages: (() => {
        try {
          return JSON.parse(r[idx("category_averages")] || "{}");
        } catch {
          return {};
        }
      })(),
    }));
  } catch {
    return [];
  }
}

function scoreClass(n: number): string {
  if (n >= 4) return "text-[#9bd02a]";
  if (n >= 3) return "text-yellow-400";
  return "text-red-400";
}

export const metadata = {
  title: `G-Eval results · ${APP_NAME}`,
};

export default function EvalPage() {
  const history = loadHistory();
  const latest = history[history.length - 1];

  // Fallback to eval-report.json if CSV is empty (first deploy before any run).
  const headline = latest ?? {
    timestamp: report.timestamp,
    commit: "",
    chat_model: "gpt-5.4-nano",
    prompt_author_model: "claude-opus-4-7",
    judge_model: "gpt-5",
    n_cases: report.results.length,
    relevance: 0,
    citation: 0,
    accuracy: 0,
    category_averages: report.categoryAverages,
  };

  const headlineDate = new Date(headline.timestamp);
  const categories = Object.keys(headline.category_averages);

  return (
    <>
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">
            <Link href="/" className="text-[#9bd02a] hover:underline">
              ← Chat
            </Link>
          </div>
          <h1 className="mt-2 text-2xl font-semibold">G-Eval results</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            LLM-as-judge scores (0–5) on a fixed test set of {headline.n_cases} questions.
            Generated {headlineDate.toUTCString()}.
          </p>
        </div>
      </header>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Run metadata
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b">
                <td className="w-40 px-4 py-2 text-muted-foreground">Commit</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {headline.commit || "(unknown)"}
                </td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 text-muted-foreground">Chat model</td>
                <td className="px-4 py-2 font-mono text-xs">{headline.chat_model}</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 text-muted-foreground">
                  Prompt-tuning model
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  {headline.prompt_author_model}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-muted-foreground">Judge model</td>
                <td className="px-4 py-2 font-mono text-xs">{headline.judge_model}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Category averages
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30 text-left">
                <th className="px-4 py-2 font-medium">Category</th>
                <th className="px-4 py-2 font-medium">Relevance</th>
                <th className="px-4 py-2 font-medium">Citation</th>
                <th className="px-4 py-2 font-medium">Accuracy</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => {
                const a = headline.category_averages[cat];
                return (
                  <tr key={cat} className="border-b last:border-b-0">
                    <td className="px-4 py-2 font-medium">{cat}</td>
                    <td className={`px-4 py-2 ${scoreClass(a.relevance)}`}>
                      {a.relevance.toFixed(2)}
                    </td>
                    <td className={`px-4 py-2 ${scoreClass(a.citation)}`}>
                      {a.citation.toFixed(2)}
                    </td>
                    <td className={`px-4 py-2 ${scoreClass(a.accuracy)}`}>
                      {a.accuracy.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-muted/30 font-medium">
                <td className="px-4 py-2">OVERALL</td>
                <td className={`px-4 py-2 ${scoreClass(headline.relevance)}`}>
                  {headline.relevance.toFixed(2)}
                </td>
                <td className={`px-4 py-2 ${scoreClass(headline.citation)}`}>
                  {headline.citation.toFixed(2)}
                </td>
                <td className={`px-4 py-2 ${scoreClass(headline.accuracy)}`}>
                  {headline.accuracy.toFixed(2)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {history.length > 1 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Run history
          </h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Commit</th>
                  <th className="px-4 py-2 font-medium">Chat</th>
                  <th className="px-4 py-2 font-medium">Judge</th>
                  <th className="px-4 py-2 font-medium">R</th>
                  <th className="px-4 py-2 font-medium">C</th>
                  <th className="px-4 py-2 font-medium">A</th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((h, i) => (
                  <tr key={i} className="border-b last:border-b-0">
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {new Date(h.timestamp).toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{h.commit}</td>
                    <td className="px-4 py-2 font-mono text-xs">{h.chat_model}</td>
                    <td className="px-4 py-2 font-mono text-xs">{h.judge_model}</td>
                    <td className={`px-4 py-2 ${scoreClass(h.relevance)}`}>
                      {h.relevance.toFixed(2)}
                    </td>
                    <td className={`px-4 py-2 ${scoreClass(h.citation)}`}>
                      {h.citation.toFixed(2)}
                    </td>
                    <td className={`px-4 py-2 ${scoreClass(h.accuracy)}`}>
                      {h.accuracy.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Per-question results
        </h2>
        <div className="flex flex-col gap-3">
          {report.results.map((r, i) => {
            const replayHref = `/?q=${encodeURIComponent(r.question || "")}`;
            const displayQ = r.question || "(empty input)";
            return (
              <details
                key={i}
                className="group rounded-lg border bg-background/40 transition-colors"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 hover:bg-muted/30">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                        {r.category}
                      </span>
                      <span className="text-muted-foreground">
                        R{" "}
                        <span className={scoreClass(r.scores.relevance)}>
                          {r.scores.relevance}
                        </span>{" "}
                        · C{" "}
                        <span className={scoreClass(r.scores.citation)}>
                          {r.scores.citation}
                        </span>{" "}
                        · A{" "}
                        <span className={scoreClass(r.scores.accuracy)}>
                          {r.scores.accuracy}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1 truncate text-sm font-medium">
                      {displayQ}
                    </div>
                  </div>
                  <Link
                    href={replayHref}
                    className="shrink-0 rounded-md border border-[#76b900]/40 bg-[#76b900]/10 px-3 py-1.5 text-xs font-medium text-[#9bd02a] hover:bg-[#76b900]/20"
                  >
                    Replay ▶
                  </Link>
                </summary>
                <div className="border-t px-4 py-3 text-sm">
                  <div className="mb-3">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                      Response
                    </div>
                    <div className="whitespace-pre-wrap rounded bg-muted/30 p-3 text-foreground/90">
                      {r.response || "(no response)"}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                      Judge notes
                    </div>
                    <div className="whitespace-pre-wrap text-muted-foreground">
                      {r.scores.notes}
                    </div>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      </section>

      <footer className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Source: <code>scripts/eval.ts</code>. Each run appends a row to{" "}
        <code>eval-history.csv</code> (commit + models + scores) and rewrites{" "}
        <code>eval-report.json</code> (per-case detail).
        <br />
        Re-generate with{" "}
        <code>
          EVAL_CHAT_URL=https://elasticchat.vercel.app/api/chat npx tsx scripts/eval.ts
        </code>
        .
      </footer>
    </main>
    <SiteFooter />
    </>
  );
}
