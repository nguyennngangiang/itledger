import { useMemo } from "react";
import type { Maintenance } from "../types";

function monthKey(iso: string) {
  return iso.slice(0, 7); // "YYYY-MM"
}

function monthLabel(key: string) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" });
}

/** Dashboard "story" widget: real repair spend from maintenance.cost_vnd,
 * grouped by month (last 6) and by part (last 3 months = "this quarter"). */
export function RepairSpendPanel({ maintenance }: { maintenance: Maintenance[] }) {
  const { series, max, quarterTotal, quarterCount, topParts } = useMemo(() => {
    const now = new Date();
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    const byMonth = new Map<string, number>();
    for (const m of maintenance) {
      if (!m.maintenance_date || m.cost_vnd == null) continue;
      const key = monthKey(m.maintenance_date);
      // cost_vnd is a Postgres DECIMAL, serialized as a numeric string — coerce
      // before summing or `+=` silently does string concatenation.
      byMonth.set(key, (byMonth.get(key) ?? 0) + Number(m.cost_vnd));
    }
    const series = months.map((key) => ({
      key,
      label: monthLabel(key),
      total: byMonth.get(key) ?? 0,
    }));
    const max = Math.max(1, ...series.map((s) => s.total));

    const quarterKeys = new Set(months.slice(-3));
    let quarterTotal = 0;
    let quarterCount = 0;
    const partCounts = new Map<string, number>();
    for (const m of maintenance) {
      if (!m.maintenance_date || !quarterKeys.has(monthKey(m.maintenance_date))) continue;
      quarterTotal += Number(m.cost_vnd ?? 0);
      quarterCount += 1;
      if (m.part) partCounts.set(m.part, (partCounts.get(m.part) ?? 0) + 1);
    }
    const topParts = [...partCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);

    return { series, max, quarterTotal, quarterCount, topParts };
  }, [maintenance]);

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Repair spend</span>
        <span className="panel-count">6 months</span>
      </div>
      <div className="repair-spend-body">
        <div className="repair-spend-total">
          ₫{(quarterTotal / 1_000_000).toFixed(1)}M
        </div>
        <div className="repair-spend-sub">
          spent this quarter · {quarterCount} repair{quarterCount === 1 ? "" : "s"}
        </div>
        <div className="repair-spend-bars">
          {series.map((s, i) => (
            <div className="repair-spend-bar-col" key={s.key}>
              <div
                className={`repair-spend-bar${i >= series.length - 3 ? " recent" : ""}`}
                style={{ height: `${Math.max(6, (s.total / max) * 96)}px` }}
              />
              <span className="repair-spend-bar-label">{s.label}</span>
            </div>
          ))}
        </div>
        {topParts.length > 0 && (
          <div className="repair-spend-parts">
            Top part this period:{" "}
            {topParts.map(([part, count], i) => (
              <span key={part}>
                {i > 0 && ", then "}
                <b>{part}</b> ({count})
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
