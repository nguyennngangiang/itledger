import "./App.css";

import { useEffect, useRef, useState } from "react";
import loadingGif from "./assets/loading.gif";
import { useLoading } from "./hook/LoadingContext";
import { SparkleBackground } from "./components/SparkleBackground";
import {
  installSparkleClicks,
  installButtonPress,
  animateEntrance,
  animateSwitch,
  slideNavIndicator,
} from "./lib/sparkle";
import { Dashboard } from "./components/Dashboard";
import { DeviceMainScreen } from "./components/DeviceMainScreen";
import { MaintenanceScreen } from "./components/MaintenanceScreen";
import { HandoverScreen } from "./components/HandoverScreen";
import { CreateDeviceModal } from "./components/Modal/CreateDeviceModal";
import MaintenanceModal from "./components/Modal/MaintenanceModal";
import HandoverModal from "./components/Modal/HandoverModal";
import {
  DashboardIcon,
  DeviceIcon,
  WrenchIcon,
  HandoverIcon,
  LogoMark,
  PlusIcon,
} from "./components/icons";

type Page = "dashboard" | "device" | "maintenance" | "handover";
export type QuickAdd = "device" | "maintenance" | "handover";

const NAV: { key: Page; label: string; icon: React.ReactNode }[] = [
  { key: "dashboard", label: "Dashboard", icon: <DashboardIcon size={17} /> },
  { key: "device", label: "Devices", icon: <DeviceIcon size={17} /> },
  { key: "maintenance", label: "Maintenance", icon: <WrenchIcon size={17} /> },
  { key: "handover", label: "Handover", icon: <HandoverIcon size={17} /> },
];

const META: Record<Page, { title: string; subtitle: string }> = {
  dashboard: {
    title: "Dashboard",
    subtitle: "Fleet overview — device mix and lifecycle status",
  },
  device: { title: "Devices", subtitle: "Company hardware, owners and status" },
  maintenance: {
    title: "Maintenance",
    subtitle: "Repair and service history per device",
  },
  handover: { title: "Handover", subtitle: "Who received which device, and when" },
};

const QUICK_ADD: { key: QuickAdd; label: string }[] = [
  { key: "device", label: "Device" },
  { key: "maintenance", label: "Maintenance" },
  { key: "handover", label: "Handover" },
];

function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [createModal, setCreateModal] = useState<QuickAdd | null>(null);
  const [refresh, setRefresh] = useState({
    device: 0,
    maintenance: 0,
    handover: 0,
  });
  const { loading } = useLoading();

  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  // Global click sparkles + springy press feedback on hero controls.
  useEffect(() => installSparkleClicks(), []);
  useEffect(() => installButtonPress(), []);

  // Sparkly staggered entrance for the top bar + nav on first paint.
  useEffect(() => {
    animateEntrance(".topbar-brand, .topnav-item, .quick-add-btn, .topbar-avatar", 55);
  }, []);

  // Re-run the (bigger, smoother) page entrance whenever the page changes.
  useEffect(() => {
    animateSwitch(".app-content > *", 55);
  }, [page]);

  // Slide the nav highlight pill under the active tab on every switch.
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>(".topnav-item.active");
    if (active && indicatorRef.current) slideNavIndicator(indicatorRef.current, active);
  }, [page]);

  // Open a create modal as an overlay WITHOUT navigating away from the
  // current page. (Previously this switched pages and, via a mount effect,
  // caused nav clicks to auto-open modals — that bug is gone now.)
  const openCreate = (target: QuickAdd) => setCreateModal(target);

  const closeCreate = () => {
    if (createModal) setRefresh((r) => ({ ...r, [createModal]: r[createModal] + 1 }));
    setCreateModal(null);
  };

  const meta = META[page];

  return (
    <>
      <SparkleBackground />

      {loading && (
        <div className="app-loading-overlay">
          <div className="app-loading-card">
            <img className="app-loading-gif" src={loadingGif} alt="Loading…" />
            <span>Loading…</span>
          </div>
        </div>
      )}

      <div className="app-shell">
        <header className="topbar">
          <div className="topbar-brand">
            <span className="topbar-logo">
              <LogoMark size={20} />
            </span>
            <span className="topbar-brand-name">IT Ledger</span>
          </div>

          <nav className="topnav" ref={navRef}>
            <span className="topnav-indicator" ref={indicatorRef} />
            {NAV.map((item) => (
              <button
                key={item.key}
                className={`topnav-item${page === item.key ? " active" : ""}`}
                onClick={() => setPage(item.key)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="topbar-actions">
            <div className="quick-add">
              {QUICK_ADD.map((q) => (
                <button
                  key={q.key}
                  className="quick-add-btn"
                  onClick={() => openCreate(q.key)}
                  title={`Add ${q.label}`}
                >
                  <PlusIcon size={15} />
                  <span>{q.label}</span>
                </button>
              ))}
            </div>
            <div className="topbar-avatar">IT</div>
          </div>
        </header>

        <div className="page-subheader">
          <h1 className="page-title">{meta.title}</h1>
          <p className="page-subtitle">{meta.subtitle}</p>
        </div>

        <main className="app-content">
          {page === "dashboard" && <Dashboard refreshKey={refresh.device} />}
          {page === "device" && (
            <DeviceMainScreen
              refreshKey={refresh.device}
              onAdd={() => openCreate("device")}
            />
          )}
          {page === "maintenance" && (
            <MaintenanceScreen
              refreshKey={refresh.maintenance}
              onAdd={() => openCreate("maintenance")}
            />
          )}
          {page === "handover" && (
            <HandoverScreen
              refreshKey={refresh.handover}
              onAdd={() => openCreate("handover")}
            />
          )}
        </main>
      </div>

      {/* Global create modals — open over any page, never navigate. */}
      {createModal === "device" && <CreateDeviceModal onClose={closeCreate} />}
      {createModal === "maintenance" && <MaintenanceModal onClose={closeCreate} />}
      {createModal === "handover" && <HandoverModal onClose={closeCreate} />}
    </>
  );
}

export default App;
