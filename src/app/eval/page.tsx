import Link from "next/link";
import evalReport from "../../../eval-report.json";

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

function scoreClass(n: number): string {
  if (n >= 4) return "text-[#9bd02a]";
  if (n >= 3) return "text-yellow-400";
  return "text-red-400";
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function overallAvg(field: keyof Scores): number {
  const nums = report.results.map((r) => r.scores[field] as number);
  return avg(nums);
}

export const metadata = {
  title: "G-Eval results · NVIDIA Blog Assistant",
};

export default function EvalPage() {
  const allCategories = Object.keys(report.categoryAverages);
  const overall = {
    relevance: overallAvg("relevance"),
    citation: overallAvg("citation"),
    accuracy: overallAvg("accuracy"),
  };
  const reportDate = new Date(report.timestamp);

  return (
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
            LLM-as-judge scores (0–5) on a fixed test set of {report.results.length} questions.
            Generated {reportDate.toUTCString()}.
          </p>
        </div>
      </header>

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
              {allCategories.map((cat) => {
                const a = report.categoryAverages[cat];
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
                <td className={`px-4 py-2 ${scoreClass(overall.relevance)}`}>
                  {overall.relevance.toFixed(2)}
                </td>
                <td className={`px-4 py-2 ${scoreClass(overall.citation)}`}>
                  {overall.citation.toFixed(2)}
                </td>
                <td className={`px-4 py-2 ${scoreClass(overall.accuracy)}`}>
                  {overall.accuracy.toFixed(2)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

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
        Source: <code>scripts/eval.ts</code> (gpt-4o-mini judge, 0 temperature).
        Re-generate with{" "}
        <code>
          EVAL_CHAT_URL=https://elasticchat.vercel.app/api/chat npx tsx scripts/eval.ts
        </code>
        .
      </footer>
    </main>
  );
}
