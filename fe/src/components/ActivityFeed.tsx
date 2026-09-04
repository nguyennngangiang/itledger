import type { ReactNode } from "react";
import { DeviceIcon, WrenchIcon, HandoverIcon } from "./icons";
import { formatDate } from "../lib/format";
import { useT } from "../i18n/useT";

export type ActivityItem = {
  id: string;
  date: string;
  kind: "registered" | "repair" | "handover";
  text: ReactNode;
};

const KIND_META: Record<ActivityItem["kind"], { Icon: typeof DeviceIcon; tone: string }> = {
  registered: { Icon: DeviceIcon, tone: "emerald" },
  repair: { Icon: WrenchIcon, tone: "amber" },
  handover: { Icon: HandoverIcon, tone: "indigo" },
};

/** Dashboard "story" widget: a merged, date-sorted feed of real recent
 * registrations (buy_date), repairs (maintenance_date) and handovers
 * (handover_date) — no synthetic activity-log data, since the schema has no
 * timestamp columns to source one from. */
export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  const { t } = useT();
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{t("feed.title")}</span>
        <span className="panel-count">{t("feed.count")}</span>
      </div>
      <div className="activity-feed">
        {items.length === 0 ? (
          <div className="dash-empty">{t("feed.empty")}</div>
        ) : (
          items.map((item) => {
            const { Icon, tone } = KIND_META[item.kind];
            return (
              <div className="activity-item" key={item.id}>
                <span className={`stat-icon activity-icon ${tone}`}>
                  <Icon size={17} />
                </span>
                <span className="activity-body">{item.text}</span>
                <span className="activity-meta">{formatDate(item.date)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
