"use client";
import { Bot, Loader2, Search, Wrench } from "lucide-react";
import { useState } from "react";
import { DecisionCard } from "@/components/decision";
import { useAuth, useToast } from "@/components/providers";
import { Badge, Card, Empty, ErrorBox } from "@/components/ui";
import { api } from "@/lib/api";
import type { CopilotAnswer } from "@/lib/types";

const PROMPTS = [
  "What needs my attention right now, and what should I approve first?",
  "Which station will run out first, and is the recommended shipment enough?",
  "A route is disrupted. What are the alternatives and their cost in transit time?",
  "Compare doing nothing vs the optimizer under a 1.5× demand spike.",
  "Have we seen this kind of shortage before? What did we do?",
  "What does the simulator rulebook say about DISPATCH_CAPACITY_EXCEEDED?",
];

/** Very small, safe Markdown renderer for bold, bullets and line breaks. */
function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {text.split(/\n{2,}/).map((block, i) => (
        <p key={i} className="whitespace-pre-wrap">
          {block.split(/(\*\*[^*]+\*\*)/g).map((part, j) => (part.startsWith("**") && part.endsWith("**") ? <strong key={j}>{part.slice(2, -2)}</strong> : <span key={j}>{part}</span>))}
        </p>
      ))}
    </div>
  );
}

export default function CopilotPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [question, setQuestion] = useState(PROMPTS[0]);
  const [answers, setAnswers] = useState<(CopilotAnswer & { question: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const operator = session?.role === "operator";

  const ask = async (q: string) => {
    setBusy(true);
    setError(null);
    try {
      const a = await api<CopilotAnswer>("/intelligence/investigate", { method: "POST", json: { question: q } });
      setAnswers((xs) => [{ ...a, question: q }, ...xs].slice(0, 6));
      if (a.source === "rules") toast("info", "GPT unavailable: answered by the deterministic rules agent");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Bot size={22} /> Ops Copilot
        </h1>
        <p className="max-w-3xl text-sm text-muted">
          An agent (GPT with function calling) that investigates by calling read-only tools on the live network: state, stockout risk, the decision queue, what-if projections,
          policy comparison, depot runway, and retrieval over the organizer rulebook and this platform&apos;s own incident memory. It explains and recommends; <strong>it can
          never dispatch</strong>: you approve.
        </p>
      </div>

      <Card>
        {!operator ? (
          <Empty>Sign in as an operator to use the copilot (each question is audited).</Empty>
        ) : (
          <>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim().length >= 3) void ask(question.trim());
              }}
            >
              <input aria-label="Question for the copilot" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-3 py-2 text-sm" />
              <button disabled={busy} className="flex items-center gap-1.5 rounded bg-accent px-4 text-sm font-medium text-white disabled:opacity-50">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} {busy ? "Investigating…" : "Ask"}
              </button>
            </form>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PROMPTS.map((p) => (
                <button key={p} disabled={busy} onClick={() => { setQuestion(p); void ask(p); }} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50">
                  {p}
                </button>
              ))}
            </div>
          </>
        )}
        {!!error && (
          <div className="mt-3">
            <ErrorBox error={error} />
          </div>
        )}
      </Card>

      {answers.map((a, idx) => (
        <Card
          key={idx}
          title={<span className="font-normal text-muted">“{a.question}”</span>}
          action={
            <span className="flex gap-1.5">
              <Badge tone={a.source === "agent" ? "info" : "muted"}>{a.source === "agent" ? `agent · ${a.model}` : "rules agent (fallback)"}</Badge>
              <Badge tone="muted">
                t{a.tick} · {(a.elapsedMs / 1000).toFixed(1)} s
              </Badge>
            </span>
          }
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="space-y-4">
              <Markdown text={a.text} />
              {a.actions.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Act on the recommendations mentioned</h3>
                  <div className="space-y-2">
                    {a.actions.map((r) => (
                      <DecisionCard key={r.id} rec={r} />
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase text-muted">
                  <Wrench size={13} /> Agent trace ({a.trace.length} tool calls)
                </h3>
                <ol className="space-y-1.5 border-l border-border pl-3">
                  {a.trace.map((t) => (
                    <li key={t.step} className="text-xs">
                      <span className="font-mono font-medium">{t.tool}</span>
                      {Object.keys(t.args).length > 0 && <span className="font-mono text-muted"> {JSON.stringify(t.args)}</span>}
                      <div className="text-muted">
                        → {t.summary} · {t.ms} ms
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
              {a.citations.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-semibold uppercase text-muted">Retrieved evidence ({a.citations.length})</summary>
                  {a.citations.map((c) => (
                    <div key={c.id} className="mt-2 rounded bg-surface-2 p-2">
                      <div className="flex items-center gap-1.5">
                        <Badge tone={c.kind === "playbook" ? "info" : "warn"}>{c.kind === "playbook" ? "rulebook" : "incident memory"}</Badge>
                        <span className="font-mono">{c.id}</span>
                      </div>
                      <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-muted">{c.text}</p>
                    </div>
                  ))}
                </details>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
