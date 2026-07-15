import { useEffect, useState } from "react";
import { Popover } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import { explainMatch } from "../api/assistant";
import { markFeedback } from "../api/feedback";
import type { FeedbackCreate } from "../api/feedback";
import { SparklesIcon, ProveIcon, CheckIcon } from "../components/icons";

type Resource = FeedbackCreate["resource"];
// Any smart-search row carries these (see *Ranked types).
type Ranked = { score?: number; document?: string; reason?: string | null };

// Highlight the query's words inside the proof text. Semantic search matches by
// meaning, so a literal hit isn't guaranteed — this just calls out overlaps.
function highlightProof(text: string, query: string) {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return text;
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "giu");
  return text.split(re).map((part, i) =>
    tokens.includes(part.toLowerCase()) ? (
      <mark key={i} className="prove-hl">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/**
 * Shared "Relevance" column for smart-search results, with a "why matched" proof
 * popover: the LLM's one-line explanation (lazy-loaded on open), the exact
 * sentence the embedder ranked the row on (query words highlighted), the LLM
 * rerank reason when present, and a "mark correct" button that feeds this
 * project's reranker (project-local learning — never trains the shared model).
 *
 * Reused by the Devices, Maintenance and Handover screens; `idOf` returns the
 * row's id and `resource` scopes the feedback.
 */
export function useSmartProof<T>(opts: {
  resource: Resource;
  query: string;
  idOf: (row: T) => string;
}): { proofColumn: TableColumnsType<T>[number] } {
  const { resource, query, idOf } = opts;
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState<Record<string, boolean>>({});

  // A fresh query drops the previous marks / explanations.
  useEffect(() => {
    setMarked(new Set());
    setExplanations({});
    setExplaining({});
  }, [query]);

  const fetchExplanation = async (row: T) => {
    const key = idOf(row);
    const doc = (row as Ranked).document ?? "";
    if (explanations[key] !== undefined || explaining[key]) return;
    setExplaining((m) => ({ ...m, [key]: true }));
    try {
      const { explanation } = await explainMatch(query, doc);
      setExplanations((m) => ({ ...m, [key]: explanation }));
    } catch {
      setExplanations((m) => ({ ...m, [key]: "" })); // blank = unavailable, no retry loop
    } finally {
      setExplaining((m) => ({ ...m, [key]: false }));
    }
  };

  const markCorrect = async (row: T) => {
    const key = idOf(row);
    if (marked.has(key)) return;
    const r = row as Ranked;
    try {
      await markFeedback({
        resource,
        item_id: key,
        query,
        document: r.document,
        score: r.score,
        label: 1,
      });
      setMarked((s) => new Set(s).add(key));
      toast.success("Marked correct — the AI will learn from this");
    } catch (e) {
      toast.error("Couldn't save mark: " + e);
    }
  };

  const proofContent = (row: T) => {
    const key = idOf(row);
    const r = row as Ranked;
    const isMarked = marked.has(key);
    const why = explanations[key];
    return (
      <div className="prove-pop">
        <div className="prove-pop-head">
          <span className="prove-pop-score">
            {Math.round((r.score ?? 0) * 100)}% match
          </span>
          <span className="prove-pop-note">meaning + keyword overlap</span>
        </div>

        <div className="prove-pop-why">
          <SparklesIcon size={13} />
          {explaining[key] ? (
            <span className="prove-pop-dim">the AI is thinking…</span>
          ) : why ? (
            <span>{why}</span>
          ) : (
            <span className="prove-pop-dim">AI explanation unavailable</span>
          )}
        </div>

        {r.reason && (
          <div className="prove-pop-reason">
            <b>Rerank:</b> {r.reason}
          </div>
        )}

        <p className="prove-pop-text">{highlightProof(r.document ?? "", query)}</p>

        <button
          className={`prove-mark${isMarked ? " done" : ""}`}
          onClick={() => markCorrect(row)}
          disabled={isMarked}
        >
          <CheckIcon size={14} />
          {isMarked ? "Marked correct" : "Mark as correct — teach the AI"}
        </button>
      </div>
    );
  };

  const proofColumn: TableColumnsType<T>[number] = {
    title: "Relevance",
    key: "score",
    width: 168,
    render: (_: unknown, row: T) => {
      const pct = Math.round(((row as Ranked).score ?? 0) * 100);
      return (
        <span className="relevance">
          <span className="relevance-track">
            <span className="relevance-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="relevance-num">{pct}%</span>
          <Popover
            title="Why this matched"
            content={proofContent(row)}
            trigger="hover"
            placement="left"
            overlayClassName="prove-overlay"
            mouseEnterDelay={0.45}
            onOpenChange={(open) => {
              if (open) fetchExplanation(row);
            }}
          >
            <span className="prove-trigger" aria-label="Why this matched">
              <ProveIcon size={16} />
            </span>
          </Popover>
        </span>
      );
    },
  };

  return { proofColumn };
}
