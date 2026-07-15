import type { Device, Handover } from "../types";
import { formatDate, resolveOwner, type UserMap } from "../lib/format";
import { DEVICE_STATUS_META } from "../types";
import { HandoverIcon } from "./icons";
import { VerticalStepper, type StepperNode } from "./VerticalStepper";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Handover screen's "device journey" side panel: the full chain of custody
 * for one selected device — registration + every handover, current holder
 * highlighted. */
export function DeviceJourneyPanel({
  device,
  handovers,
  users,
  onClose,
}: {
  device?: Device;
  handovers: Handover[];
  users: UserMap;
  onClose: () => void;
}) {
  const statusMeta = DEVICE_STATUS_META[device?.status ?? "in_stock"];
  const sorted = [...handovers].sort((a, b) =>
    (a.handover_date ?? "").localeCompare(b.handover_date ?? ""),
  );

  const nodes: StepperNode[] = [];
  if (device?.buy_date) {
    nodes.push({
      id: "origin",
      title: "Registered to stock",
      meta: formatDate(device.buy_date),
      avatarLabel: "IT",
      tone: "default",
    });
  }
  for (const h of sorted) {
    const to = resolveOwner(h.to_user_id, users);
    nodes.push({
      id: h.handover_id,
      title: `${to.name} (${to.team})`,
      subtitle: h.reason || undefined,
      meta: formatDate(h.handover_date),
      avatarLabel: initials(to.name),
      tone: "default",
    });
  }
  if (nodes.length > 0) {
    const last = nodes[nodes.length - 1];
    last.tone = "current";
    last.badge = "current holder";
  }

  return (
    <div className="panel detail-panel">
      <div className="detail-panel-head">
        <span className="detail-panel-head-icon">
          <HandoverIcon size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="detail-panel-head-title">
            {device?.name ?? "Unknown device"}
          </div>
          <div className="detail-panel-head-sub">
            {device?.serial_number ?? "—"} · bought {formatDate(device?.buy_date)}
          </div>
        </div>
        <span
          className="status-dot"
          style={{ ["--dot" as string]: statusMeta.color }}
        >
          {statusMeta.label}
        </span>
        <button className="detail-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="detail-panel-body">
        <div className="detail-history-head">
          <span className="panel-title" style={{ fontSize: 13 }}>
            Device journey
          </span>
          <span className="panel-count">{handovers.length} handovers</span>
        </div>
        {nodes.length > 0 ? (
          <VerticalStepper nodes={nodes} variant="rail" />
        ) : (
          <p className="detail-panel-empty" style={{ padding: "24px 0" }}>
            No handover history for this device yet.
          </p>
        )}
        <p className="info-callout">
          This chain is the device's story over cells — every keeper, when, and
          why, straight from the handover ledger.
        </p>
      </div>
    </div>
  );
}
