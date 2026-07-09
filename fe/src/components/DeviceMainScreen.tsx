import { useState, useEffect, useMemo } from "react";
import { Table, Button, Input } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import { listDevices, deleteDevice } from "../api/devices";
import type { Device } from "../types";
import { useLoading } from "../hook/LoadingContext";
import { CreateDeviceModal } from "./Modal/CreateDeviceModal";
import { ConfirmModal } from "./Modal/ConfirmModal";
import { PlusIcon, RefreshIcon, SearchIcon, TrashIcon } from "./icons";

export const DeviceMainScreen = () => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const { startLoading, endLoading } = useLoading();

  const loadDevices = async () => {
    startLoading();
    try {
      const deviceList = await listDevices();
      setDevices(deviceList);
    } catch (err) {
      console.error(err);
    } finally {
      setTimeout(() => endLoading(), 600);
    }
  };

  useEffect(() => {
    loadDevices();
  }, []);

  const handleDelete = async (serialNumber: string) => {
    setDeleteTarget(null);
    startLoading();
    try {
      await deleteDevice(serialNumber);
      toast.success("Device deleted");
    } catch (error) {
      toast.error("Failed to delete device: " + error);
    } finally {
      await loadDevices();
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter((d) =>
      [d.name, d.serial_number, d.brand, d.type, d.os]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [devices, search]);

  const dash = <span className="text-faint">—</span>;

  const columns: TableColumnsType<Device> = [
    {
      title: "Device",
      dataIndex: "name",
      key: "name",
      render: (name, d) => (
        <span style={{ fontWeight: 600 }}>{name ?? d.serial_number}</span>
      ),
    },
    { title: "Serial Number", dataIndex: "serial_number", key: "serial_number" },
    {
      title: "Brand",
      dataIndex: "brand",
      key: "brand",
      render: (b) => (b ? <span className="pill pill-neutral">{b}</span> : dash),
    },
    { title: "CPU", dataIndex: "cpu", key: "cpu", render: (v) => v ?? dash },
    { title: "RAM", dataIndex: "ram", key: "ram", render: (v) => v ?? dash },
    {
      title: "Storage",
      dataIndex: "storage",
      key: "storage",
      render: (v) => v ?? dash,
    },
    { title: "OS", dataIndex: "os", key: "os", render: (v) => v ?? dash },
    {
      title: "MS Office",
      dataIndex: "msoffice",
      key: "msoffice",
      render: (v) => v ?? dash,
    },
    {
      title: "Buy Date",
      dataIndex: "buy_date",
      key: "buy_date",
      render: (v) => v ?? dash,
    },
    {
      title: "",
      key: "options",
      width: 70,
      render: (_, d) => (
        <Button
          type="text"
          danger
          icon={<TrashIcon size={18} />}
          onClick={() => setDeleteTarget(d)}
        />
      ),
    },
  ];

  return (
    <>
      <div className="screen-toolbar">
        <div className="screen-search">
          <Input
            allowClear
            prefix={<SearchIcon size={16} />}
            placeholder="Search devices…"
            style={{ width: 280 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="toolbar-actions">
          <Button icon={<RefreshIcon size={16} />} onClick={loadDevices}>
            Refresh
          </Button>
          <Button
            type="primary"
            icon={<PlusIcon size={16} />}
            onClick={() => setIsCreateOpen(true)}
          >
            Add Device
          </Button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Device inventory</span>
          <span className="panel-count">{filtered.length} devices</span>
        </div>
        <div className="table-wrap">
          <Table<Device>
            rowKey="serial_number"
            dataSource={filtered}
            columns={columns}
            pagination={false}
            scroll={{ x: "max-content" }}
          />
        </div>
      </div>

      {isCreateOpen && (
        <CreateDeviceModal
          onClose={() => {
            setIsCreateOpen(false);
            loadDevices();
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          message={`Delete device "${
            deleteTarget.name ?? deleteTarget.serial_number
          }"? This cannot be undone.`}
          onConfirm={() => handleDelete(deleteTarget.serial_number)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
};
