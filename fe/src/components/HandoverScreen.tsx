import { useEffect, useState } from "react";
import { Table, Button } from "antd";
import type { TableColumnsType } from "antd";
import { listHandovers } from "../api/handovers";
import { listUsers } from "../api/users";
import type { Handover, User } from "../types";
import { useLoading } from "../hook/LoadingContext";
import HandoverModal from "./Modal/HandoverModal";
import { PlusIcon, RefreshIcon, HandoverIcon } from "./icons";

export const HandoverScreen = () => {
  const [records, setRecords] = useState<Handover[]>([]);
  const [users, setUsers] = useState<Record<string, User>>({});
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const { startLoading, endLoading } = useLoading();

  const load = async () => {
    startLoading();
    try {
      const [handovers, userList] = await Promise.all([
        listHandovers(),
        listUsers(),
      ]);
      setRecords(handovers);
      setUsers(Object.fromEntries(userList.map((u) => [u.employee_code, u])));
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

  const userLabel = (code: string | null) => {
    if (!code) return dash;
    const u = users[code];
    return (
      <span>
        <span style={{ fontWeight: 600 }}>{code}</span>
        {u?.name ? (
          <span className="text-faint"> · {u.name}</span>
        ) : null}
      </span>
    );
  };

  const columns: TableColumnsType<Handover> = [
    {
      title: "Date",
      dataIndex: "handover_date",
      key: "handover_date",
      render: (v) => v ?? dash,
    },
    {
      title: "Device",
      dataIndex: "device_id",
      key: "device_id",
      render: (v) => (v ? <span style={{ fontWeight: 600 }}>{v}</span> : dash),
    },
    {
      title: "From",
      dataIndex: "from_user_id",
      key: "from_user_id",
      render: (v) => userLabel(v),
    },
    {
      title: "",
      key: "arrow",
      width: 40,
      align: "center",
      render: () => (
        <span style={{ color: "var(--accent)" }}>
          <HandoverIcon size={16} />
        </span>
      ),
    },
    {
      title: "To",
      dataIndex: "to_user_id",
      key: "to_user_id",
      render: (v) => userLabel(v),
    },
    {
      title: "Reason",
      dataIndex: "reason",
      key: "reason",
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
            Record Handover
          </Button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Handover history</span>
          <span className="panel-count">{records.length} records</span>
        </div>
        <div className="table-wrap">
          <Table<Handover>
            rowKey="handover_id"
            dataSource={records}
            columns={columns}
            pagination={false}
            scroll={{ x: "max-content" }}
          />
        </div>
      </div>

      {isCreateOpen && (
        <HandoverModal
          onClose={() => {
            setIsCreateOpen(false);
            load();
          }}
        />
      )}
    </>
  );
};
