import type { Device, DeviceStatus } from "../types";

/** Tally devices by lifecycle status. Shared by the Dashboard's KPI cards and
 * the Ask AI panel's live-stats strip, so the two never drift apart. */
export function countByStatus(devices: Device[]): Record<DeviceStatus, number> {
  const counts: Record<DeviceStatus, number> = {
    active: 0,
    in_stock: 0,
    maintaining: 0,
    on_del: 0,
  };
  for (const d of devices) {
    const s = (d.status ?? "in_stock") as DeviceStatus;
    if (s in counts) counts[s] += 1;
  }
  return counts;
}
