import type { Device } from "../types";

export type AgingEntry = {
  device: Device;
  years: number;
  ownerLabel: string;
};

/** Dashboard "story" widget: oldest devices by buy_date, so aging hardware
 * doesn't hide inside the fleet totals. */
export function AgingWatchlist({
  entries,
  totalAging,
}: {
  entries: AgingEntry[];
  totalAging: number;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Aging watchlist</span>
        <span className="panel-count">{totalAging} devices</span>
      </div>
      <div className="aging-list">
        {entries.length === 0 ? (
          <div className="dash-empty">No purchase-date data yet</div>
        ) : (
          entries.map((e) => (
            <div className="aging-row" key={e.device.serial_number}>
              <span className="aging-info">
                <span className="aging-name">
                  {e.device.name ?? e.device.serial_number}
                </span>
                <span className="aging-owner">{e.ownerLabel}</span>
              </span>
              <span className={`aging-age${e.years >= 6 ? " danger" : ""}`}>
                {e.years.toFixed(1)} yrs
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
