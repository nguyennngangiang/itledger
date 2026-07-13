import { useEffect, useState } from "react";
import { Table, Button, Input, Popover } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import {
  pageMaintenance,
  deleteMaintenance,
  deleteMaintenanceBatch,
  restoreMaintenance,
  semanticSearchMaintenance,
} from "../api/maintenance";
import { listDevices } from "../api/devices";
import { listUsers } from "../api/users";
import type { Maintenance, MaintenanceRanked, Device, User } from "../types";
import { ConfirmModal } from "./Modal/ConfirmModal";
import { BulkDeleteBar } from "./BulkDeleteBar";
import { TrashToggle } from "./TrashToggle";
import MaintenanceModal from "./Modal/MaintenanceModal";
import { PlusIcon, RefreshIcon, SearchIcon, InfoIcon, TrashIcon, EditIcon, SparklesIcon } from "./icons";
import { relevanceColumn } from "../lib/relevance";
import { formatDate, resolveOwner, toUserMap } from "../lib/format";
import { usePagedList } from "../lib/usePagedList";
import { TABLE_SCROLL } from "../lib/table";

export const MaintenanceScreen = ({
  refreshKey = 0,
  onAdd,
}: {
  refreshKey?: number;
  onAdd?: () => void;
}) => {
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [users, setUsers] = useState<Record<string, User>>({});
  const [searchText, setSearchText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Maintenance | null>(null);
  const [editTarget, setEditTarget] = useState<Maintenance | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  // Smart (semantic) search: when aiResults !== null the table shows ranked hits.
  const [smart, setSmart] = useState(false);
  const [aiResults, setAiResults] = useState<MaintenanceRanked[] | null>(null);
  const [aiQuery, setAiQuery] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  const showingAi = aiResults !== null;

  const clearAi = () => {
    setAiResults(null);
    setAiQuery("");
  };

  const runSearch = async () => {
    const q = searchText.trim();
    if (!smart) {
      list.applySearch(q);
      return;
    }
    if (!q) {
      clearAi();
      return;
    }
    setAiLoading(true);
    try {
      const res = await semanticSearchMaintenance(q, 30);
      setAiResults(res);
      setAiQuery(q);
    } catch (e) {
      toast.error("Smart search failed: " + e);
    } finally {
      setAiLoading(false);
    }
  };

  const relevanceCol = relevanceColumn<Maintenance>();

  const list = usePagedList<Maintenance>(pageMaintenance, {
    defaultOrderBy: "maintenance_date",
    defaultOrder: "desc",
    refreshKey,
  });

  useEffect(() => setSelectedKeys([]), [list.trashed]);

  const handleBulkDelete = async () => {
    setBulkConfirm(false);
    try {
      await deleteMaintenanceBatch(selectedKeys, list.trashed);
      toast.success(
        `${selectedKeys.length} record(s) ${
          list.trashed ? "permanently deleted" : "moved to trash"
        }`,
      );
      setSelectedKeys([]);
    } catch (e) {
      toast.error("Failed: " + e);
    } finally {
      list.reload();
    }
  };

  useEffect(() => {
    Promise.all([listDevices(), listUsers()])
      .then(([ds, us]) => {
        setDevices(Object.fromEntries(ds.map((d) => [d.serial_number, d])));
        setUsers(toUserMap(us));
      })
      .catch(() => {});
  }, []);

  const handleDelete = async (id: string, permanent: boolean) => {
    setDeleteTarget(null);
    try {
      await deleteMaintenance(id, permanent);
      toast.success(permanent ? "Permanently deleted" : "Moved to trash");
    } catch (e) {
      toast.error("Failed: " + e);
    } finally {
      list.reload();
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await restoreMaintenance(id);
      toast.success("Restored");
    } catch (e) {
      toast.error("Failed: " + e);
    } finally {
      list.reload();
    }
  };

  const dash = <span className="text-faint">—</span>;

  const detailBubble = (m: Maintenance) => {
    const rows: [string, string | number | null][] = [
      ["Problem", m.reason],
      ["Solution", m.solution],
      ["Result", m.result],
      ["Cost (VND)", m.cost_vnd != null ? m.cost_vnd.toLocaleString("vi-VN") : null],
      ["Remarks", m.remarks],
    ];
    return (
      <dl className="detail-bubble">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v != null && v !== "" ? v : "—"}</dd>
          </div>
        ))}
      </dl>
    );
  };

  const columns: TableColumnsType<Maintenance> = [
    {
      title: "Date",
      dataIndex: "maintenance_date",
      key: "maintenance_date",
      sorter: true,
      render: (v) => (v ? formatDate(v) : dash),
    },
    {
      title: "Device",
      dataIndex: "device_id",
      key: "device_id",
      sorter: true,
      render: (id: string | null) => (
        <span style={{ fontWeight: 600 }}>
          {(id && devices[id]?.name) || id || "—"}
        </span>
      ),
    },
    {
      title: "Owner",
      key: "owner",
      render: (_, m) => {
        const d = m.device_id ? devices[m.device_id] : undefined;
        const o = resolveOwner(d?.user_id ?? null, users);
        return <span style={{ fontWeight: 500 }}>{o.name}</span>;
      },
    },
    {
      title: "Team",
      key: "team",
      // Team always follows the device owner's current team, not the value
      // that happened to be stored on the maintenance record.
      render: (_, m) => {
        const d = m.device_id ? devices[m.device_id] : undefined;
        const team = resolveOwner(d?.user_id ?? null, users).team;
        return team && team !== "—" ? (
          <span className="pill pill-accent">{team}</span>
        ) : (
          dash
        );
      },
    },
    {
      title: "Part",
      dataIndex: "part",
      key: "part",
      sorter: true,
      render: (v) => (v ? <span className="pill pill-neutral">{v}</span> : dash),
    },
    {
      title: "",
      key: "options",
      width: 160,
      render: (_, m) =>
        list.trashed ? (
          <div className="flex items-center gap-1">
            <Button size="small" onClick={() => handleRestore(m.maintenance_id)}>
              Restore
            </Button>
            <Button
              type="text"
              danger
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(m)}
            />
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Popover
              title="Repair details"
              content={detailBubble(m)}
              trigger="hover"
              placement="left"
            >
              <span className="info-trigger">
                <InfoIcon size={18} />
              </span>
            </Popover>
            <Button
              type="text"
              icon={<EditIcon size={18} />}
              onClick={() => setEditTarget(m)}
            />
            <Button
              type="text"
              danger
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(m)}
            />
          </div>
        ),
    },
  ];

  return (
    <>
      <div className="screen-toolbar">
        <div className="screen-search">
          <Input
            allowClear
            prefix={smart ? <SparklesIcon size={16} /> : <SearchIcon size={16} />}
            placeholder={
              smart
                ? "Describe the repair you're looking for… (Enter)"
                : "Search maintenance… (Enter)"
            }
            style={{ width: 320 }}
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              if (e.target.value === "") {
                if (smart) clearAi();
                else list.applySearch("");
              }
            }}
            onPressEnter={runSearch}
          />
          <Button
            type={smart ? "primary" : "default"}
            icon={<SparklesIcon size={16} />}
            title="AI semantic search — search by meaning, not keywords"
            onClick={() => {
              const next = !smart;
              setSmart(next);
              if (!next) clearAi();
            }}
          >
            {smart ? "Smart: on" : "Smart"}
          </Button>
        </div>
        <div className="toolbar-actions">
          <TrashToggle trashed={list.trashed} onToggle={list.toggleTrash} />
          <Button icon={<RefreshIcon size={16} />} onClick={list.reload}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusIcon size={16} />} onClick={onAdd}>
            Log Maintenance
          </Button>
        </div>
      </div>

      {showingAi && (
        <div className="ai-banner">
          <span className="ai-banner-text">
            <SparklesIcon size={16} />
            Smart results for <b>“{aiQuery}”</b> — {aiResults!.length} matches,
            ranked by meaning
          </span>
          <Button size="small" onClick={clearAi}>
            Clear
          </Button>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">
            {showingAi
              ? "Smart results"
              : list.trashed
              ? "Trash"
              : "Maintenance records"}
          </span>
          {selectedKeys.length > 0 ? (
            <BulkDeleteBar
              count={selectedKeys.length}
              trashed={list.trashed}
              onDelete={() => setBulkConfirm(true)}
              onClear={() => setSelectedKeys([])}
            />
          ) : (
            <span className="panel-count">
              {showingAi ? `${aiResults!.length} matches` : `${list.total} total`}
            </span>
          )}
        </div>
        <div className="table-wrap">
          {showingAi ? (
            <Table<Maintenance>
              rowKey="maintenance_id"
              columns={[relevanceCol, ...columns]}
              dataSource={aiResults!}
              loading={aiLoading}
              pagination={false}
              scroll={TABLE_SCROLL}
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys as string[]),
              }}
            />
          ) : (
            <Table<Maintenance>
              rowKey="maintenance_id"
              columns={columns}
              scroll={TABLE_SCROLL}
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys as string[]),
              }}
              {...list.tableProps}
            />
          )}
        </div>
      </div>

      {editTarget && (
        <MaintenanceModal
          isEdit
          maintenance={editTarget}
          onClose={() => {
            setEditTarget(null);
            list.reload();
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          message={
            list.trashed
              ? "Permanently delete this maintenance record? This cannot be undone."
              : "Move this maintenance record to trash?"
          }
          onConfirm={() =>
            handleDelete(deleteTarget.maintenance_id, list.trashed)
          }
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {bulkConfirm && (
        <ConfirmModal
          message={
            list.trashed
              ? `Permanently delete ${selectedKeys.length} selected record(s)? This cannot be undone.`
              : `Move ${selectedKeys.length} selected record(s) to trash?`
          }
          onConfirm={handleBulkDelete}
          onCancel={() => setBulkConfirm(false)}
        />
      )}
    </>
  );
};
