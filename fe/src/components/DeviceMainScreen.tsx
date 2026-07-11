import { useState, useEffect } from "react";
import { Table, Button, Input, Popover } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import {
  pageDevices,
  deleteDevice,
  deleteDevicesBatch,
  restoreDevice,
  semanticSearchDevices,
} from "../api/devices";
import { listUsers } from "../api/users";
import type { Device, DeviceRanked, DeviceStatus, User } from "../types";
import { DEVICE_STATUS_META, DEVICE_STATUS_ORDER } from "../types";
import { CreateDeviceModal } from "./Modal/CreateDeviceModal";
import { ImportDevicesModal } from "./Modal/ImportDevicesModal";
import { ConfirmModal } from "./Modal/ConfirmModal";
import { BulkDeleteBar } from "./BulkDeleteBar";
import { TrashToggle } from "./TrashToggle";
import {
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
  EditIcon,
  InfoIcon,
  UploadIcon,
  SparklesIcon,
  ProveIcon,
} from "./icons";
import { formatDate, resolveOwner, toUserMap } from "../lib/format";
import { usePagedList } from "../lib/usePagedList";
import { TABLE_SCROLL } from "../lib/table";

type StatusFilter = DeviceStatus | "all";

export const DeviceMainScreen = ({
  refreshKey = 0,
  onAdd,
}: {
  refreshKey?: number;
  onAdd?: () => void;
}) => {
  const [users, setUsers] = useState<Record<string, User>>({});
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [editTarget, setEditTarget] = useState<Device | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // Smart (semantic) search state. When aiResults !== null the table shows the
  // ranked results instead of the normal paged list.
  const [smart, setSmart] = useState(false);
  const [aiResults, setAiResults] = useState<DeviceRanked[] | null>(null);
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
      const res = await semanticSearchDevices(q, 30);
      setAiResults(res);
      setAiQuery(q);
    } catch (e) {
      toast.error("Smart search failed: " + e);
    } finally {
      setAiLoading(false);
    }
  };

  const list = usePagedList<Device>(pageDevices, {
    defaultOrderBy: "serial_number",
    defaultOrder: "asc",
    status: statusFilter === "all" ? undefined : statusFilter,
    refreshKey,
  });

  useEffect(() => {
    listUsers().then((u) => setUsers(toUserMap(u))).catch(() => {});
  }, []);

  // Drop any selection when the view (active/trash or status filter) changes.
  useEffect(() => setSelectedKeys([]), [list.trashed, statusFilter]);

  const handleBulkDelete = async () => {
    setBulkConfirm(false);
    try {
      await deleteDevicesBatch(selectedKeys, list.trashed);
      toast.success(
        `${selectedKeys.length} device(s) ${
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

  const handleDelete = async (serial: string, permanent: boolean) => {
    setDeleteTarget(null);
    try {
      await deleteDevice(serial, permanent);
      toast.success(permanent ? "Device permanently deleted" : "Moved to trash");
    } catch (e) {
      toast.error("Failed: " + e);
    } finally {
      list.reload();
    }
  };

  const handleRestore = async (serial: string) => {
    try {
      await restoreDevice(serial);
      toast.success("Device restored");
    } catch (e) {
      toast.error("Failed: " + e);
    } finally {
      list.reload();
    }
  };

  const dash = <span className="text-faint">—</span>;

  const specBubble = (d: Device) => {
    const rows: [string, string | null][] = [
      ["Barcode", d.barcode],
      ["Type", d.type],
      ["Brand", d.brand],
      ["CPU", d.cpu],
      ["RAM", d.ram],
      ["Storage", d.storage],
      ["OS", d.os],
      ["MS Office", d.msoffice],
    ];
    return (
      <dl className="detail-bubble">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v?.trim() ? v : "—"}</dd>
          </div>
        ))}
      </dl>
    );
  };

  const columns: TableColumnsType<Device> = [
    {
      title: "Device",
      dataIndex: "name",
      key: "name",
      sorter: true,
      render: (name, d) => (
        <span style={{ fontWeight: 600 }}>{name ?? d.serial_number}</span>
      ),
    },
    {
      title: "Owner",
      key: "owner",
      render: (_, d) => {
        const o = resolveOwner(d.user_id, users);
        return (
          <span>
            <span style={{ fontWeight: 500 }}>{o.name}</span>
            <span className="text-faint"> — {o.team}</span>
          </span>
        );
      },
    },
    {
      title: "Serial Number",
      dataIndex: "serial_number",
      key: "serial_number",
      sorter: true,
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      sorter: true,
      render: (status: DeviceStatus | null) => {
        const meta = DEVICE_STATUS_META[status ?? "in_stock"];
        const pulse = status === "maintaining" ? " pulse" : "";
        return (
          <span
            className={`status-dot${pulse}`}
            style={{ ["--dot" as string]: meta.color }}
          >
            {meta.label}
          </span>
        );
      },
    },
    {
      title: "Buy Date",
      dataIndex: "buy_date",
      key: "buy_date",
      sorter: true,
      render: (v) => (v ? formatDate(v) : dash),
    },
    {
      title: "",
      key: "options",
      width: 132,
      render: (_, d) =>
        list.trashed ? (
          <div className="flex items-center gap-1">
            <Button size="small" onClick={() => handleRestore(d.serial_number)}>
              Restore
            </Button>
            <Button
              type="text"
              danger
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(d)}
            />
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Popover
              title={d.name ?? d.serial_number}
              content={specBubble(d)}
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
              onClick={() => setEditTarget(d)}
            />
            <Button
              type="text"
              danger
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(d)}
            />
          </div>
        ),
    },
  ];

  // Highlight the query's words inside the proof text. Semantic search matches
  // by *meaning*, so an exact-word hit isn't guaranteed — this just calls out
  // any literal overlaps; the full sentence is the real evidence.
  const highlightProof = (text: string, query: string) => {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 3);
    if (!tokens.length) return text;
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`(${escaped.join("|")})`, "ig");
    return text.split(re).map((part, i) =>
      tokens.includes(part.toLowerCase()) ? (
        <mark key={i} className="prove-hl">
          {part}
        </mark>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
  };

  // The "prove it" popover: the exact sentence the embedder ranked this device
  // on, plus its score — so a match for "broken" / "old" is explainable.
  const proofContent = (d: DeviceRanked) => (
    <div className="prove-pop">
      <div className="prove-pop-head">
        <span className="prove-pop-score">
          {Math.round((d.score ?? 0) * 100)}% match
        </span>
        <span className="prove-pop-note">ranked by meaning, not keywords</span>
      </div>
      <p className="prove-pop-text">{highlightProof(d.document ?? "", aiQuery)}</p>
      <div className="prove-pop-foot">
        <SparklesIcon size={13} /> what the AI read about this device
      </div>
    </div>
  );

  // Relevance meter shown as the first column in smart-search results.
  const relevanceColumn: TableColumnsType<Device>[number] = {
    title: "Relevance",
    key: "score",
    width: 168,
    render: (_, d) => {
      const ranked = d as DeviceRanked;
      const pct = Math.round((ranked.score ?? 0) * 100);
      return (
        <span className="relevance">
          <span className="relevance-track">
            <span className="relevance-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="relevance-num">{pct}%</span>
          <Popover
            title="Why this matched"
            content={proofContent(ranked)}
            trigger="hover"
            placement="left"
            overlayClassName="prove-overlay"
          >
            <span className="prove-trigger" aria-label="Why this matched">
              <ProveIcon size={16} />
            </span>
          </Popover>
        </span>
      );
    },
  };

  const statusChips: StatusFilter[] = ["all", ...DEVICE_STATUS_ORDER];

  return (
    <>
      <div className="screen-toolbar">
        <div className="screen-search">
          <Input
            allowClear
            prefix={
              smart ? <SparklesIcon size={16} /> : <SearchIcon size={16} />
            }
            placeholder={
              smart
                ? "Describe what you're looking for… (Enter)"
                : "Search devices, owners… (Enter)"
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
          <Button icon={<UploadIcon size={16} />} onClick={() => setShowImport(true)}>
            Import
          </Button>
          <Button type="primary" icon={<PlusIcon size={16} />} onClick={onAdd}>
            Add Device
          </Button>
        </div>
      </div>

      {!list.trashed && !showingAi && (
        <div className="status-chips">
          {statusChips.map((s) => (
            <button
              key={s}
              className={`status-chip${statusFilter === s ? " active" : ""}`}
              onClick={() => setStatusFilter(s)}
            >
              {s !== "all" && (
                <span
                  className="chip-dot"
                  style={{ background: DEVICE_STATUS_META[s].color }}
                />
              )}
              {s === "all" ? "All" : DEVICE_STATUS_META[s].label}
            </button>
          ))}
        </div>
      )}

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
              : "Device inventory"}
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
            <Table<Device>
              rowKey="serial_number"
              columns={[relevanceColumn, ...columns]}
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
            <Table<Device>
              rowKey="serial_number"
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
        <CreateDeviceModal
          isEdit
          device={editTarget}
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
              ? `Permanently delete "${
                  deleteTarget.name ?? deleteTarget.serial_number
                }"? This cannot be undone.`
              : `Move "${
                  deleteTarget.name ?? deleteTarget.serial_number
                }" to trash?`
          }
          onConfirm={() => handleDelete(deleteTarget.serial_number, list.trashed)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {bulkConfirm && (
        <ConfirmModal
          message={
            list.trashed
              ? `Permanently delete ${selectedKeys.length} selected device(s)? This cannot be undone.`
              : `Move ${selectedKeys.length} selected device(s) to trash?`
          }
          onConfirm={handleBulkDelete}
          onCancel={() => setBulkConfirm(false)}
        />
      )}

      {showImport && <ImportDevicesModal onClose={() => {
        setShowImport(false);
        list.reload();
      }} />}
    </>
  );
};
