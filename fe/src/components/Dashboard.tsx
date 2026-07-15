import { useEffect, useMemo, useState } from "react";
import { CountUp } from "./CountUp";
import { animateEntrance } from "../lib/sparkle";
import {
  Chart as ChartJS,
  ArcElement,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from "chart.js";
import ChartDataLabels from "chartjs-plugin-datalabels";
import { Pie, Bar } from "react-chartjs-2";
import { listDevices } from "../api/devices";
import { listMaintenance } from "../api/maintenance";
import { listHandovers } from "../api/handovers";
import { listUsers } from "../api/users";
import type { Device, Maintenance, Handover } from "../types";
import { DEVICE_STATUS_META, DEVICE_STATUS_ORDER } from "../types";
import { DeviceIcon } from "./icons";
import { formatDate, resolveOwner, toUserMap, type UserMap } from "../lib/format";
import { countByStatus } from "../lib/deviceStats";
import { ActivityFeed, type ActivityItem } from "./ActivityFeed";
import { AgingWatchlist, type AgingEntry } from "./AgingWatchlist";
import { RepairSpendPanel } from "./RepairSpendPanel";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

ChartJS.register(
  ArcElement,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  ChartDataLabels,
);

const CAT_PALETTE = [
  "#a5b4fc", "#93c5fd", "#6ee7b7", "#fcd34d", "#f9a8d4",
  "#c4b5fd", "#7dd3fc", "#bef264", "#fda4af", "#5eead4",
];

function countBy(devices: Device[], field: keyof Device) {
  const map = new Map<string, number>();
  for (const d of devices) {
    const key = (d[field] as string | null)?.trim() || "Unknown";
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

const pieOptions = {
  responsive: true,
  maintainAspectRatio: false,
  // Render at 3× backing resolution so the chart stays crisp when the panel
  // is CSS-scaled up on hover.
  devicePixelRatio: 3,
  // Spin + scale the slices in on mount / tab switch.
  animation: {
    animateRotate: true,
    animateScale: true,
    duration: 900,
    easing: "easeOutQuart" as const,
  },
  plugins: {
    legend: {
      position: "bottom" as const,
      labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 }, padding: 10 },
    },
    datalabels: {
      color: "#2b2740",
      font: { weight: "bold" as const, size: 16 },
      // Thin white outline so the number stays legible on any slice colour,
      // even while the slice darkens on hover.
      textStrokeColor: "#ffffff",
      textStrokeWidth: 3,
      textShadowColor: "rgba(255,255,255,0.75)",
      textShadowBlur: 4,
      formatter: (v: number) => (v > 0 ? v : ""),
    },
    tooltip: { enabled: true },
  },
};

export const Dashboard = ({ refreshKey = 0 }: { refreshKey?: number }) => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [maintenance, setMaintenance] = useState<Maintenance[]>([]);
  const [handovers, setHandovers] = useState<Handover[]>([]);
  const [users, setUsers] = useState<UserMap>({});
  // Snapshot of "now" taken when data last loaded — used for device-age math,
  // kept out of render (Date.now() there would re-run on every re-render).
  const [asOf, setAsOf] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const [ds, ms, hs, us] = await Promise.all([
          listDevices(),
          listMaintenance(),
          listHandovers(),
          listUsers(),
        ]);
        setDevices(ds);
        setMaintenance(ms);
        setHandovers(hs);
        setUsers(toUserMap(us));
        setAsOf(Date.now());
      } catch (err) {
        console.error(err);
      }
    })();
  }, [refreshKey]);

  // Sparkly staggered entrance once devices land.
  useEffect(() => {
    if (devices.length) {
      animateEntrance(".dash-stats .stat-card", 70);
      animateEntrance(".dash-charts .panel", 90);
      animateEntrance(".dash-story-row .panel", 100);
    }
  }, [devices.length]);

  const statusCounts = useMemo(() => countByStatus(devices), [devices]);

  const byBrand = useMemo(() => countBy(devices, "brand"), [devices]);
  const byCpu = useMemo(() => countBy(devices, "cpu"), [devices]);
  const byOs = useMemo(() => countBy(devices, "os"), [devices]);

  const devicesById = useMemo(
    () => Object.fromEntries(devices.map((d) => [d.serial_number, d])),
    [devices],
  );

  // Fleet pulse: merge real dated events (buy_date / maintenance_date /
  // handover_date) — no synthetic activity log, the schema has no timestamps.
  const activityItems = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [];
    for (const d of devices) {
      if (!d.buy_date) continue;
      items.push({
        id: `reg-${d.serial_number}`,
        date: d.buy_date,
        kind: "registered",
        text: (
          <>
            <b>{d.name ?? d.serial_number}</b> added to the ledger
          </>
        ),
      });
    }
    for (const m of maintenance) {
      if (!m.maintenance_date) continue;
      const device = m.device_id ? devicesById[m.device_id] : undefined;
      items.push({
        id: `mnt-${m.maintenance_id}`,
        date: m.maintenance_date,
        kind: "repair",
        text: (
          <>
            <b>{device?.name ?? m.device_id ?? "Unknown device"}</b> serviced
            {m.part ? <> — {m.part}</> : null}
          </>
        ),
      });
    }
    for (const h of handovers) {
      if (!h.handover_date) continue;
      const device = h.device_id ? devicesById[h.device_id] : undefined;
      const to = resolveOwner(h.to_user_id, users);
      items.push({
        id: `hnd-${h.handover_id}`,
        date: h.handover_date,
        kind: "handover",
        text: (
          <>
            <b>{device?.name ?? h.device_id ?? "Unknown device"}</b> handed to{" "}
            {to.name} <span className="text-faint">({to.team})</span>
            {h.reason ? <> — {h.reason}</> : null}
          </>
        ),
      });
    }
    return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  }, [devices, maintenance, handovers, devicesById, users]);

  const mostRecentActivityDate = useMemo(() => {
    const dates = [
      ...devices.map((d) => d.buy_date),
      ...maintenance.map((m) => m.maintenance_date),
      ...handovers.map((h) => h.handover_date),
    ].filter((d): d is string => !!d);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [devices, maintenance, handovers]);

  const AGING_THRESHOLD_YEARS = 5;
  const { agingEntries, totalAging } = useMemo(() => {
    // asOf is 0 until the first load lands; devices is empty then too, so
    // the age filter below simply yields nothing rather than needing `now`.
    const now = asOf;
    const aged = devices
      .filter((d) => d.buy_date)
      .map((d) => ({
        device: d,
        years: (now - new Date(d.buy_date as string).getTime()) / MS_PER_YEAR,
      }))
      .filter((e) => e.years >= AGING_THRESHOLD_YEARS)
      .sort((a, b) => b.years - a.years);
    const entries: AgingEntry[] = aged.slice(0, 5).map((e) => {
      const o = resolveOwner(e.device.user_id, users);
      return {
        device: e.device,
        years: e.years,
        ownerLabel: `${o.name} · ${o.team}`,
      };
    });
    return { agingEntries: entries, totalAging: aged.length };
  }, [devices, users, asOf]);

  const pieData = (entries: { label: string; value: number }[]) => ({
    labels: entries.map((e) => e.label),
    datasets: [
      {
        data: entries.map((e) => e.value),
        backgroundColor: CAT_PALETTE,
        // Keep the exact same pastel colours on hover so the slice never
        // darkens and the number stays easy to read.
        hoverBackgroundColor: CAT_PALETTE,
        borderColor: "#ffffff",
        borderWidth: 2,
        hoverBorderColor: "#ffffff",
        hoverBorderWidth: 2,
        hoverOffset: 6,
      },
    ],
  });

  const statusData = {
    labels: DEVICE_STATUS_ORDER.map((s) => DEVICE_STATUS_META[s].label),
    datasets: [
      {
        data: DEVICE_STATUS_ORDER.map((s) => statusCounts[s]),
        backgroundColor: DEVICE_STATUS_ORDER.map((s) => DEVICE_STATUS_META[s].color),
        hoverBackgroundColor: DEVICE_STATUS_ORDER.map((s) => DEVICE_STATUS_META[s].color),
        borderRadius: 8,
        maxBarThickness: 56,
      },
    ],
  };

  const statusOptions = {
    responsive: true,
    maintainAspectRatio: false,
    devicePixelRatio: 3,
    animation: { duration: 900, easing: "easeOutQuart" as const },
    // Extra headroom at the top so the number above the tallest bar never
    // gets clipped by the chart edge.
    layout: { padding: { top: 22 } },
    plugins: {
      legend: { display: false },
      datalabels: {
        anchor: "end" as const,
        align: "end" as const,
        // Keep the label inside the chart area even for very tall bars.
        clamp: true,
        clip: false,
        offset: 4,
        color: "#2b2740",
        font: { weight: "bold" as const, size: 16 },
        textStrokeColor: "#ffffff",
        textStrokeWidth: 3,
        textShadowColor: "rgba(255,255,255,0.75)",
        textShadowBlur: 4,
        formatter: (v: number) => v,
      },
      tooltip: { enabled: true },
    },
    scales: {
      y: {
        beginAtZero: true,
        // ~15% slack above the max value leaves room for the top label.
        grace: "15%",
        ticks: { precision: 0 },
        grid: { color: "#f0edf8" },
      },
      x: { grid: { display: false } },
    },
  };

  const statCards = [
    { label: "Total Devices", value: devices.length, tone: "indigo", icon: true },
    { label: DEVICE_STATUS_META.active.label, value: statusCounts.active, tone: "emerald" },
    { label: DEVICE_STATUS_META.in_stock.label, value: statusCounts.in_stock, tone: "slate" },
    { label: DEVICE_STATUS_META.maintaining.label, value: statusCounts.maintaining, tone: "amber" },
    { label: DEVICE_STATUS_META.on_del.label, value: statusCounts.on_del, tone: "rose" },
  ];

  const charts = [
    { title: "Devices by brand", unit: "brands", data: byBrand },
    { title: "Devices by CPU", unit: "types", data: byCpu },
    { title: "Devices by OS", unit: "types", data: byOs },
  ];

  return (
    <>
      <div className="dash-header">
        <span className="dash-live-pill">
          <span className="dash-live-dot" />
          Ledger current — last entry: {formatDate(mostRecentActivityDate)}
        </span>
      </div>

      {/* KPIs first */}
      <div className="dash-stats">
        {statCards.map((c) => (
          <div className="stat-card" key={c.label}>
            <div className="stat-card-top">
              <span className={`stat-icon ${c.tone}`}>
                {c.icon ? <DeviceIcon size={22} /> : <span className="stat-dot" />}
              </span>
            </div>
            <div>
              <div className="stat-value">
                <CountUp value={c.value} />
              </div>
              <div className="stat-label">{c.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts kept */}
      <div className="dash-charts">
        {charts.map((c) => (
          <div className="panel" key={c.title}>
            <div className="panel-head">
              <span className="panel-title">{c.title}</span>
              <span className="panel-count">
                {c.data.length} {c.unit}
              </span>
            </div>
            <div className="chart-body">
              <div className="chart-canvas">
                {c.data.length ? (
                  <Pie data={pieData(c.data)} options={pieOptions} />
                ) : (
                  <div className="dash-empty">No data yet</div>
                )}
              </div>
            </div>
          </div>
        ))}

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Devices by status</span>
            <span className="panel-count">{devices.length} total</span>
          </div>
          <div className="chart-body">
            <div className="chart-canvas">
              {devices.length ? (
                <Bar data={statusData} options={statusOptions} />
              ) : (
                <div className="dash-empty">No data yet</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* New "fleet story" row */}
      <div className="dash-story-row">
        <ActivityFeed items={activityItems} />
        <AgingWatchlist entries={agingEntries} totalAging={totalAging} />
        <RepairSpendPanel maintenance={maintenance} />
      </div>
    </>
  );
};
