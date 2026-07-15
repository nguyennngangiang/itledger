import { useEffect, useState } from "react";
import { Table, Button, Input, Popover } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import {
  pageMaintenance,
  listMaintenance,
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
import { PlusIcon, RefreshIcon, SearchIcon, InfoIcon, TrashIcon, EditIcon, SparklesIcon, ProveIcon } from "./icons";
import { useSmartProof } from "../lib/relevance";
import { formatDate, resolveOwner, toUserMap } from "../lib/format";
import { usePagedList } from "../lib/usePagedList";
import { TABLE_SCROLL } from "../lib/table";
import { RepairStoryPanel } from "./RepairStoryPanel";

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
  const [rerank, setRerank] = useState(false); // LLM re-sort of smart results
  const [aiResults, setAiResults] = useState<MaintenanceRanked[] | null>(null);
  const [aiQuery, setAiQuery] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [selected, setSelected] = useState<Maintenance | null>(null);
  const [deviceHistory, setDeviceHistory] = useState<Maintenance[]>([]);

  const showingAi = aiResults !== null;

  const { proofColumn } = useSmartProof<Maintenance>({
    resource: "maintenance",
    query: aiQuery,
    idOf: (m) => m.maintenance_id,
  });

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
      const res = await semanticSearchMaintenance(q, 30, rerank);
      setAiResults(res);
      setAiQuery(q);
    } catch (e) {
      toast.error("Smart search failed: " + e);
    } finally {
      setAiLoading(false);
    }
  };

  const list = usePagedList<Maintenance>(pageMaintenance, {
    defaultOrderBy: "maintenance_date",
    defaultOrder: "desc",
    refreshKey,
  });

  useEffect(() => setSelectedKeys([]), [list.trashed]);

  // Selecting a repair loads that device's full history for the story panel.
  useEffect(() => {
    if (!selected?.device_id) {
      setDeviceHistory(selected ? [selected] : []);
      return;
    }
    let cancelled = false;
    listMaintenance(selected.device_id)
      .then((rows) => {
        if (!cancelled) setDeviceHistory(rows);
      })
      .catch(() => {
        if (!cancelled) setDeviceHistory([selected]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

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
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
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
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
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
          {smart && (
            <Button
              type={rerank ? "primary" : "default"}
              icon={<ProveIcon size={16} />}
              title="Re-rank smart results with the LLM — it learns from your marks"
              onClick={() => setRerank((v) => !v)}
            >
              {rerank ? "LLM rerank: on" : "LLM rerank"}
            </Button>
          )}
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
            {rerank
              ? " re-ranked by the LLM · it learns from your marks"
              : " ranked by meaning"}
          </span>
          <Button size="small" onClick={clearAi}>
            Clear
          </Button>
        </div>
      )}

      <div className="split-view">
        <div className="panel table-panel">
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
                columns={[proofColumn, ...columns]}
                dataSource={aiResults!}
                loading={aiLoading}
                pagination={false}
                scroll={TABLE_SCROLL}
                rowSelection={{
                  selectedRowKeys: selectedKeys,
                  onChange: (keys) => setSelectedKeys(keys as string[]),
                }}
                onRow={(m) => ({
                  onClick: () => setSelected(m),
                  className: selected?.maintenance_id === m.maintenance_id ? "row-selected" : "",
                })}
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
                onRow={(m) => ({
                  onClick: () => setSelected(m),
                  className: selected?.maintenance_id === m.maintenance_id ? "row-selected" : "",
                })}
                {...list.tableProps}
              />
            )}
          </div>
        </div>

        {selected ? (
          <RepairStoryPanel
            record={selected}
            device={selected.device_id ? devices[selected.device_id] : undefined}
            owner={resolveOwner(
              selected.device_id ? devices[selected.device_id]?.user_id ?? null : null,
              users,
            )}
            history={deviceHistory}
            onClose={() => setSelected(null)}
          />
        ) : (
          <div className="panel detail-panel">
            <div className="detail-panel-empty">
              Select a repair to read its story — problem, fix, result, and this
              device's other repairs.
            </div>
          </div>
        )}
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
