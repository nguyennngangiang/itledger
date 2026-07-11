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
import type { Device, DeviceStatus } from "../types";
import { DEVICE_STATUS_META, DEVICE_STATUS_ORDER } from "../types";
import { DeviceIcon } from "./icons";

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

  useEffect(() => {
    (async () => {
      try {
        setDevices(await listDevices());
      } catch (err) {
        console.error(err);
      }
    })();
  }, [refreshKey]);

  // Sparkly staggered entrance once devices land.
  useEffect(() => {
    if (devices.length) {
      animateEntrance(".dash-charts .panel", 90);
      animateEntrance(".dash-stats .stat-card", 70);
    }
  }, [devices.length]);

  const statusCounts = useMemo(() => {
    const c: Record<DeviceStatus, number> = {
      active: 0,
      in_stock: 0,
      maintaining: 0,
      on_del: 0,
    };
    for (const d of devices) {
      const s = (d.status ?? "in_stock") as DeviceStatus;
      if (s in c) c[s] += 1;
    }
    return c;
  }, [devices]);

  const byBrand = useMemo(() => countBy(devices, "brand"), [devices]);
  const byCpu = useMemo(() => countBy(devices, "cpu"), [devices]);
  const byOs = useMemo(() => countBy(devices, "os"), [devices]);

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
      {/* Charts first */}
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

      {/* Totals below */}
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
    </>
  );
};
