import { useEffect, useState } from "react";
import { Table, Button, Input } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import {
  pageHandovers,
  deleteHandover,
  deleteHandoversBatch,
  restoreHandover,
  semanticSearchHandovers,
} from "../api/handovers";
import { listUsers } from "../api/users";
import { listDevices } from "../api/devices";
import type { Handover, HandoverRanked, Device, User } from "../types";
import { ConfirmModal } from "./Modal/ConfirmModal";
import { BulkDeleteBar } from "./BulkDeleteBar";
import { TrashToggle } from "./TrashToggle";
import HandoverModal from "./Modal/HandoverModal";
import { PlusIcon, RefreshIcon, ArrowRightIcon, TrashIcon, EditIcon, SearchIcon, SparklesIcon } from "./icons";
import { relevanceColumn } from "../lib/relevance";
import { formatDate, resolveOwner, toUserMap } from "../lib/format";
import { usePagedList } from "../lib/usePagedList";
import { TABLE_SCROLL } from "../lib/table";

export const HandoverScreen = ({
  refreshKey = 0,
  onAdd,
}: {
  refreshKey?: number;
  onAdd?: () => void;
}) => {
  const [users, setUsers] = useState<Record<string, User>>({});
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [searchText, setSearchText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Handover | null>(null);
  const [editTarget, setEditTarget] = useState<Handover | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  // Smart (semantic) search: when aiResults !== null the table shows ranked hits.
  const [smart, setSmart] = useState(false);
  const [aiResults, setAiResults] = useState<HandoverRanked[] | null>(null);
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
      const res = await semanticSearchHandovers(q, 30);
      setAiResults(res);
      setAiQuery(q);
    } catch (e) {
      toast.error("Smart search failed: " + e);
    } finally {
      setAiLoading(false);
    }
  };

  const relevanceCol = relevanceColumn<Handover>();

  const list = usePagedList<Handover>(pageHandovers, {
    defaultOrderBy: "handover_date",
    defaultOrder: "desc",
    refreshKey,
  });

  useEffect(() => setSelectedKeys([]), [list.trashed]);

  const handleBulkDelete = async () => {
    setBulkConfirm(false);
    try {
      await deleteHandoversBatch(selectedKeys, list.trashed);
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
    Promise.all([listUsers(), listDevices()])
      .then(([us, ds]) => {
        setUsers(toUserMap(us));
        setDevices(Object.fromEntries(ds.map((d) => [d.serial_number, d])));
      })
      .catch(() => {});
  }, []);

  const handleDelete = async (id: string, permanent: boolean) => {
    setDeleteTarget(null);
    try {
      await deleteHandover(id, permanent);
      toast.success(permanent ? "Permanently deleted" : "Moved to trash");
    } catch (e) {
      toast.error("Failed: " + e);
    } finally {
      list.reload();
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await restoreHandover(id);
      toast.success("Restored");
    } catch (e) {
      toast.error("Failed: " + e);
    } finally {
      list.reload();
    }
  };

  const dash = <span className="text-faint">—</span>;

  const party = (code: string | null, to = false) => {
    const o = resolveOwner(code, users);
    return (
      <span className={`xfer-party${to ? " xfer-to" : ""}`}>
        <span className="xfer-name">{o.name}</span>
        <span className="xfer-team">{o.team}</span>
      </span>
    );
  };

  const columns: TableColumnsType<Handover> = [
    {
      title: "Date",
      dataIndex: "handover_date",
      key: "handover_date",
      width: 130,
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
      title: "Transfer",
      key: "transfer",
      align: "center",
      render: (_, h) => (
        <span className="xfer">
          {party(h.from_user_id)}
          <span className="xfer-arrow">
            <ArrowRightIcon size={16} />
          </span>
          {party(h.to_user_id, true)}
        </span>
      ),
    },
    {
      title: "Reason",
      dataIndex: "reason",
      key: "reason",
      render: (v) => (v ? v : dash),
    },
    {
      title: "",
      key: "options",
      width: 140,
      render: (_, h) =>
        list.trashed ? (
          <div className="flex items-center gap-1">
            <Button size="small" onClick={() => handleRestore(h.handover_id)}>
              Restore
            </Button>
            <Button
              type="text"
              danger
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(h)}
            />
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              type="text"
              icon={<EditIcon size={18} />}
              onClick={() => setEditTarget(h)}
            />
            <Button
              type="text"
              danger
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(h)}
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
                ? "Describe the handover you're looking for… (Enter)"
                : "Search handovers… (Enter)"
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
            Record Handover
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
            {showingAi ? "Smart results" : list.trashed ? "Trash" : "Handover history"}
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
            <Table<Handover>
              rowKey="handover_id"
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
            <Table<Handover>
              rowKey="handover_id"
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
        <HandoverModal
          isEdit
          handover={editTarget}
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
              ? "Permanently delete this handover record? This cannot be undone."
              : "Move this handover record to trash?"
          }
          onConfirm={() => handleDelete(deleteTarget.handover_id, list.trashed)}
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
