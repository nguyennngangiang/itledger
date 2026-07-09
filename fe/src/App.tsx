import "./App.css";

import { useState } from "react";
import { Layout, Menu } from "antd";
import type { MenuProps } from "antd";
import loadingGif from "./assets/loading.gif";
import { useLoading } from "./hook/LoadingContext";
import { Dashboard } from "./components/Dashboard";
import { DeviceMainScreen } from "./components/DeviceMainScreen";
import { UserMainScreen } from "./components/UserMainScreen";
import { MaintenanceScreen } from "./components/MaintenanceScreen";
import { HandoverScreen } from "./components/HandoverScreen";
import {
  DashboardIcon,
  DeviceIcon,
  UserIcon,
  WrenchIcon,
  HandoverIcon,
  LogoMark,
} from "./components/icons";

type ActiveMenu =
  | "dashboard"
  | "device"
  | "user"
  | "maintenance"
  | "handover";

type NavMeta = { title: string; subtitle: string };

const NAV: Record<ActiveMenu, NavMeta> = {
  dashboard: {
    title: "Dashboard",
    subtitle: "Overview of your IT assets and activity",
  },
  device: {
    title: "Devices",
    subtitle: "Track and manage company hardware",
  },
  user: {
    title: "Users",
    subtitle: "Employees and their team assignments",
  },
  maintenance: {
    title: "Maintenance",
    subtitle: "Repair and service records for devices",
  },
  handover: {
    title: "Handover",
    subtitle: "Device transfers between employees",
  },
};

const menuItems: MenuProps["items"] = [
  { key: "dashboard", icon: <DashboardIcon size={18} />, label: "Dashboard" },
  { type: "divider" },
  { key: "device", icon: <DeviceIcon size={18} />, label: "Devices" },
  { key: "user", icon: <UserIcon size={18} />, label: "Users" },
  { key: "maintenance", icon: <WrenchIcon size={18} />, label: "Maintenance" },
  { key: "handover", icon: <HandoverIcon size={18} />, label: "Handover" },
];

function App() {
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>("dashboard");
  const { loading } = useLoading();
  const meta = NAV[activeMenu];

  return (
    <>
      {loading && (
        <div className="app-loading-overlay">
          <div className="app-loading-card">
            <img className="app-loading-gif" src={loadingGif} alt="Loading…" />
            <span>Loading…</span>
          </div>
        </div>
      )}

      <Layout className="app-layout">
        <Layout.Sider width={248} className="sidebar" theme="dark">
          <div className="sidebar-brand">
            <span className="sidebar-logo">
              <LogoMark size={22} />
            </span>
            <div className="sidebar-brand-text">
              <span className="sidebar-title">IT Ledger</span>
              <span className="sidebar-subtitle">Asset Management</span>
            </div>
          </div>

          <Menu
            className="sidebar-menu"
            theme="dark"
            mode="inline"
            selectedKeys={[activeMenu]}
            items={menuItems}
            onClick={(e) => setActiveMenu(e.key as ActiveMenu)}
          />

          <div className="sidebar-footer">
            <span className="sidebar-footer-dot" />
            All systems operational
          </div>
        </Layout.Sider>

        <Layout className="app-main">
          <header className="app-header">
            <div>
              <h1 className="app-header-title">{meta.title}</h1>
              <p className="app-header-subtitle">{meta.subtitle}</p>
            </div>
            <div className="app-header-user">
              <div className="app-header-avatar">IT</div>
              <div className="app-header-user-text">
                <span className="app-header-user-name">IT Admin</span>
                <span className="app-header-user-role">Administrator</span>
              </div>
            </div>
          </header>

          <Layout.Content className="app-content">
            {activeMenu === "dashboard" && (
              <Dashboard onNavigate={(k) => setActiveMenu(k as ActiveMenu)} />
            )}
            {activeMenu === "device" && <DeviceMainScreen />}
            {activeMenu === "user" && <UserMainScreen />}
            {activeMenu === "maintenance" && <MaintenanceScreen />}
            {activeMenu === "handover" && <HandoverScreen />}
          </Layout.Content>
        </Layout>
      </Layout>
    </>
  );
}

export default App;
