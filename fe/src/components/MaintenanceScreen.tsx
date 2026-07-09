import { useEffect, useState } from "react";
import { Table, Button } from "antd";
import type { TableColumnsType } from "antd";
import { listMaintenance } from "../api/maintenance";
import type { Maintenance } from "../types";
import { useLoading } from "../hook/LoadingContext";
import MaintenanceModal from "./Modal/MaintenanceModal";
import { PlusIcon, RefreshIcon } from "./icons";

export const MaintenanceScreen = () => {
  const [records, setRecords] = useState<Maintenance[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const { startLoading, endLoading } = useLoading();

  const load = async () => {
    startLoading();
    try {
      setRecords(await listMaintenance());
    } catch (err) {
      console.error(err);
    } finally {
      setTimeout(() => endLoading(), 600);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const dash = <span className="text-faint">—</span>;

  const columns: TableColumnsType<Maintenance> = [
    {
      title: "Date",
      dataIndex: "maintenance_date",
      key: "maintenance_date",
      render: (v) => v ?? dash,
    },
    {
      title: "Device",
      dataIndex: "device_id",
      key: "device_id",
      render: (v) => (v ? <span style={{ fontWeight: 600 }}>{v}</span> : dash),
    },
    {
      title: "Team",
      dataIndex: "team",
      key: "team",
      render: (v) => (v ? <span className="pill pill-accent">{v}</span> : dash),
    },
    { title: "Part", dataIndex: "part", key: "part", render: (v) => v ?? dash },
    {
      title: "Problem",
      dataIndex: "reason",
      key: "reason",
      render: (v) => v ?? dash,
    },
    {
      title: "Solution",
      dataIndex: "solution",
      key: "solution",
      render: (v) => v ?? dash,
    },
    {
      title: "Result",
      dataIndex: "result",
      key: "result",
      render: (v) => v ?? dash,
    },
    {
      title: "Cost (VND)",
      dataIndex: "cost_vnd",
      key: "cost_vnd",
      align: "right",
      render: (v: number | null) =>
        v != null ? v.toLocaleString("vi-VN") : dash,
    },
    {
      title: "Remarks",
      dataIndex: "remarks",
      key: "remarks",
      render: (v) => v ?? dash,
    },
  ];

  return (
    <>
      <div className="screen-toolbar">
        <div />
        <div className="toolbar-actions">
          <Button icon={<RefreshIcon size={16} />} onClick={load}>
            Refresh
          </Button>
          <Button
            type="primary"
            icon={<PlusIcon size={16} />}
            onClick={() => setIsCreateOpen(true)}
          >
            Log Maintenance
          </Button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Maintenance records</span>
          <span className="panel-count">{records.length} records</span>
        </div>
        <div className="table-wrap">
          <Table<Maintenance>
            rowKey="maintenance_id"
            dataSource={records}
            columns={columns}
            pagination={false}
            scroll={{ x: "max-content" }}
          />
        </div>
      </div>

      {isCreateOpen && (
        <MaintenanceModal
          onClose={() => {
            setIsCreateOpen(false);
            load();
          }}
        />
      )}
    </>
  );
};
