import type { TableColumnsType } from "antd";

// Shared "Relevance" meter column for smart (semantic) search results. Any row
// carrying a `score` (0–1) renders as a filled bar + percentage. Reused by the
// Devices, Maintenance and Handover screens so the meter looks identical.
export function relevanceColumn<T>(): TableColumnsType<T>[number] {
  return {
    title: "Relevance",
    key: "score",
    width: 150,
    render: (_: unknown, row: T) => {
      const pct = Math.round(((row as { score?: number }).score ?? 0) * 100);
      return (
        <span className="relevance">
          <span className="relevance-track">
            <span className="relevance-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="relevance-num">{pct}%</span>
        </span>
      );
    },
  };
}
