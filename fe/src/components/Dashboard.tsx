import { useEffect, useState } from "react";
import { Table } from "antd";
import type { TableColumnsType } from "antd";
import { listDevices } from "../api/devices";
import { listUsers } from "../api/users";
import { listMaintenance } from "../api/maintenance";
import { listHandovers } from "../api/handovers";
import type { Device } from "../types";
import {
  DeviceIcon,
  UserIcon,
  WrenchIcon,
  HandoverIcon,
  PlusIcon,
} from "./icons";

type Stats = {
  devices: number;
  users: number;
  maintenance: number;
  handovers: number;
};

const QUICK_ACTIONS: {
  key: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  {
    key: "device",
    title: "Manage devices",
    desc: "Add or update company hardware",
    icon: <DeviceIcon size={20} />,
  },
  {
    key: "user",
    title: "Manage users",
    desc: "Employees and team assignments",
    icon: <UserIcon size={20} />,
  },
  {
    key: "maintenance",
    title: "Log maintenance",
    desc: "Record a repair or service",
    icon: <WrenchIcon size={20} />,
  },
  {
    key: "handover",
    title: "Record handover",
    desc: "Transfer a device between users",
    icon: <HandoverIcon size={20} />,
  },
];

export const Dashboard = ({
  onNavigate,
}: {
  onNavigate: (key: string) => void;
}) => {
  const [stats, setStats] = useState<Stats>({
    devices: 0,
    users: 0,
    maintenance: 0,
    handovers: 0,
  });
  const [recentDevices, setRecentDevices] = useState<Device[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [devices, users, maintenance, handovers] = await Promise.all([
          listDevices(),
          listUsers(),
          listMaintenance(),
          listHandovers(),
        ]);
        setStats({
          devices: devices.length,
          users: users.length,
          maintenance: maintenance.length,
          handovers: handovers.length,
        });
        setRecentDevices(devices.slice(0, 5));
      } catch (err) {
        console.error(err);
      }
    })();
  }, []);

  const statCards = [
    {
      label: "Total Devices",
      value: stats.devices,
      hint: "Registered hardware",
      icon: <DeviceIcon size={22} />,
      tone: "indigo",
    },
    {
      label: "Users",
      value: stats.users,
      hint: "Active employees",
      icon: <UserIcon size={22} />,
      tone: "emerald",
    },
    {
      label: "Maintenance",
      value: stats.maintenance,
      hint: "Service records",
      icon: <WrenchIcon size={22} />,
      tone: "amber",
    },
    {
      label: "Handovers",
      value: stats.handovers,
      hint: "Device transfers",
      icon: <HandoverIcon size={22} />,
      tone: "sky",
    },
  ];

  const columns: TableColumnsType<Device> = [
    {
      title: "Device",
      dataIndex: "name",
      key: "name",
      render: (name, d) => (
        <span style={{ fontWeight: 600 }}>{name ?? d.serial_number}</span>
      ),
    },
    { title: "Serial", dataIndex: "serial_number", key: "serial_number" },
    {
      title: "Brand",
      dataIndex: "brand",
      key: "brand",
      render: (b) =>
        b ? (
          <span className="pill pill-neutral">{b}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      title: "OS",
      dataIndex: "os",
      key: "os",
      render: (v) => v ?? <span className="text-faint">—</span>,
    },
  ];

  return (
    <>
      <div className="dash-stats">
        {statCards.map((c) => (
          <div className="stat-card" key={c.label}>
            <div className="stat-card-top">
              <span className={`stat-icon ${c.tone}`}>{c.icon}</span>
            </div>
            <div>
              <div className="stat-value">{c.value}</div>
              <div className="stat-label">{c.label}</div>
            </div>
            <div className="stat-hint">{c.hint}</div>
          </div>
        ))}
      </div>

      <div className="dash-grid">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Recent devices</span>
            <span className="panel-count">{stats.devices} total</span>
          </div>
          <div className="table-wrap">
            {recentDevices.length > 0 ? (
              <Table<Device>
                rowKey="serial_number"
                dataSource={recentDevices}
                columns={columns}
                pagination={false}
                size="middle"
              />
            ) : (
              <div className="dash-empty">
                No devices yet. Add your first device to get started.
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Quick actions</span>
            <span className="stat-icon" style={{ width: 32, height: 32 }}>
              <PlusIcon size={18} />
            </span>
          </div>
          <div className="quick-actions">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.key}
                className="quick-action"
                onClick={() => onNavigate(a.key)}
              >
                <span className="quick-action-icon">{a.icon}</span>
                <span className="quick-action-text">
                  <span className="quick-action-title">{a.title}</span>
                  <span className="quick-action-desc">{a.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
};
