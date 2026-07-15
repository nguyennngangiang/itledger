import type { Device, Maintenance } from "../types";
import type { Owner } from "../lib/format";
import { formatDate } from "../lib/format";
import { DEVICE_STATUS_META } from "../types";
import { WrenchIcon } from "./icons";
import { VerticalStepper, type StepperNode } from "./VerticalStepper";

// cost_vnd is a Postgres DECIMAL, serialized as a numeric string — coerce
// before formatting/summing or arithmetic silently does string concatenation.
function vnd(v: number | string | null): string {
  return v != null ? `₫${Number(v).toLocaleString("vi-VN")}` : "—";
}

/** Maintenance screen's "repair story" side panel: the Problem → Solution →
 * Result of one selected repair, plus that device's other repairs for context. */
export function RepairStoryPanel({
  record,
  device,
  owner,
  history,
  onClose,
}: {
  record: Maintenance;
  device?: Device;
  owner: Owner;
  history: Maintenance[];
  onClose: () => void;
}) {
  const statusMeta = DEVICE_STATUS_META[device?.status ?? "in_stock"];
  const otherRepairs = history.filter(
    (m) => m.maintenance_id !== record.maintenance_id,
  );
  const totalCost = history.reduce((sum, m) => sum + Number(m.cost_vnd ?? 0), 0);

  const nodes: StepperNode[] = [
    {
      id: "problem",
      title: "Problem",
      subtitle: record.reason || "No problem description recorded.",
      tone: "danger",
    },
    {
      id: "solution",
      title: "Solution",
      subtitle: record.solution || "No solution recorded yet.",
      tone: "accent",
    },
    {
      id: "result",
      title: "Result",
      subtitle: record.result || "No result recorded yet.",
      tone: "success",
    },
  ];

  return (
    <div className="panel detail-panel">
      <div className="detail-panel-head">
        <span className="detail-panel-head-icon">
          <WrenchIcon size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="detail-panel-head-title">
            {device?.name ?? record.device_id ?? "Unknown device"}
          </div>
          <div className="detail-panel-head-sub">
            {device?.serial_number ?? "—"} · {owner.name}
          </div>
        </div>
        <span
          className={`status-dot${device?.status === "maintaining" ? " pulse" : ""}`}
          style={{ ["--dot" as string]: statusMeta.color }}
        >
          {statusMeta.label}
        </span>
        <button className="detail-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="detail-panel-body">
        <VerticalStepper nodes={nodes} variant="stepper" />

        <div className="detail-stat-row">
          <div className="detail-stat">
            <div className="detail-stat-label">Cost</div>
            <div className="detail-stat-value">{vnd(record.cost_vnd)}</div>
          </div>
          <div className="detail-stat">
            <div className="detail-stat-label">Part</div>
            <div className="detail-stat-value">{record.part || "—"}</div>
          </div>
        </div>

        {record.remarks && (
          <p className="info-callout">{record.remarks}</p>
        )}

        <div className="detail-history-list">
          <div className="detail-history-head">
            <span className="panel-title" style={{ fontSize: 13 }}>
              History on this device
            </span>
            <span className="panel-count">
              {history.length} repair{history.length === 1 ? "" : "s"} ·{" "}
              {vnd(totalCost)}
            </span>
          </div>
          <div
            className="detail-history-item current"
          >
            <span>This record · {record.part || "—"}</span>
            <span>{formatDate(record.maintenance_date)}</span>
          </div>
          {otherRepairs.map((m) => (
            <div className="detail-history-item" key={m.maintenance_id}>
              <span>{m.part || "Repair"}</span>
              <span>{formatDate(m.maintenance_date)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
