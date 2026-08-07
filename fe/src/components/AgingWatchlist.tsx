import type { Device } from "../types";
import { useT } from "../i18n/useT";

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
  const { t } = useT();
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{t("aging.title")}</span>
        <span className="panel-count">{t("aging.count", { n: totalAging })}</span>
      </div>
      <div className="aging-list">
        {entries.length === 0 ? (
          <div className="dash-empty">{t("aging.empty")}</div>
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
                {t("aging.years", { n: e.years.toFixed(1) })}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
