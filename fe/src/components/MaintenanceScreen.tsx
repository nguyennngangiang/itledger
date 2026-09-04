import { useEffect, useState } from "react";
import { Table, Button, Popover } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import {
  pageMaintenance,
  listMaintenance,
  deleteMaintenance,
  deleteMaintenanceBatch,
  restoreMaintenance,
} from "../api/maintenance";
import { listDevices } from "../api/devices";
import { listUsersIncludingDeleted } from "../api/users";
import type { Maintenance, Device, User } from "../types";
import { ConfirmModal } from "./Modal/ConfirmModal";
import { PanelHead } from "./PanelHead";
import { SearchBox } from "./SearchBox";
import { TrashToggle } from "./TrashToggle";
import MaintenanceModal from "./Modal/MaintenanceModal";
import { PlusIcon, RefreshIcon, InfoIcon, TrashIcon, EditIcon } from "./icons";
import { formatDate, resolveOwner, toUserMap } from "../lib/format";
import { usePagedList } from "../lib/usePagedList";
import { useTableSelection } from "../lib/useTableSelection";
import { TABLE_SCROLL } from "../lib/table";
import { RepairStoryPanel } from "./RepairStoryPanel";
import { useT } from "../i18n/useT";

export const MaintenanceScreen = ({
  refreshKey = 0,
  onAdd,
}: {
  refreshKey?: number;
  onAdd?: () => void;
}) => {
  const { t } = useT();
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [users, setUsers] = useState<Record<string, User>>({});
  const [deleteTarget, setDeleteTarget] = useState<Maintenance | null>(null);
  const [editTarget, setEditTarget] = useState<Maintenance | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [selected, setSelected] = useState<Maintenance | null>(null);
  // Tagged with the device it belongs to — see the note in HandoverScreen.
  const [history, setHistory] = useState<{
    deviceId: string;
    rows: Maintenance[];
  } | null>(null);

  const list = usePagedList<Maintenance>(pageMaintenance, {
    defaultOrderBy: "maintenance_date",
    defaultOrder: "desc",
    refreshKey,
  });
  const { selectedKeys, setSelectedKeys, clear, rowSelection } =
    useTableSelection(list.trashed);

  // Selecting a repair loads that device's full history for the story panel. The
  // effect only fetches; what the panel shows is derived below.
  useEffect(() => {
    const deviceId = selected?.device_id;
    if (!deviceId) return;
    let cancelled = false;
    listMaintenance(deviceId).then(
      (rows) => {
        if (!cancelled) setHistory({ deviceId, rows });
      },
      () => {
        if (!cancelled) setHistory({ deviceId, rows: selected ? [selected] : [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const deviceHistory =
    selected === null
      ? []
      : history?.deviceId === selected.device_id
        ? history.rows
        : [selected];

  const handleBulkDelete = async () => {
    setBulkConfirm(false);
    try {
      await deleteMaintenanceBatch(selectedKeys, list.trashed);
      toast.success(
        t(list.trashed ? "row.bulk.deleted" : "row.bulk.trashed", {
          n: selectedKeys.length,
        }),
      );
      setSelectedKeys([]);
    } catch (e) {
      toast.error(t("row.toast.failed", { error: String(e) }));
    } finally {
      list.reload();
    }
  };

  useEffect(() => {
    // Includes trashed staff — a repair row resolves the device's owner, who
    // may since have left; showing their name beats showing a bare code.
    Promise.all([listDevices(), listUsersIncludingDeleted()])
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
      toast.success(t(permanent ? "row.toast.deleted" : "row.toast.trashed"));
    } catch (e) {
      toast.error(t("row.toast.failed", { error: String(e) }));
    } finally {
      list.reload();
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await restoreMaintenance(id);
      toast.success(t("row.toast.restored"));
    } catch (e) {
      toast.error(t("row.toast.failed", { error: String(e) }));
    } finally {
      list.reload();
    }
  };

  const dash = <span className="text-faint">—</span>;

  const detailBubble = (m: Maintenance) => {
    const rows: [string, string | number | null][] = [
      [t("maint.detail.problem"), m.reason],
      [t("maint.detail.solution"), m.solution],
      [t("maint.detail.result"), m.result],
      [
        t("maint.detail.cost"),
        m.cost_vnd != null ? m.cost_vnd.toLocaleString("vi-VN") : null,
      ],
      [t("maint.detail.remarks"), m.remarks],
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
      title: t("maint.col.date"),
      dataIndex: "maintenance_date",
      key: "maintenance_date",
      sorter: true,
      render: (v) => (v ? formatDate(v) : dash),
    },
    {
      title: t("maint.col.device"),
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
      title: t("maint.col.owner"),
      key: "owner",
      render: (_, m) => {
        const d = m.device_id ? devices[m.device_id] : undefined;
        const o = resolveOwner(d?.user_id ?? null, users);
        return <span style={{ fontWeight: 500 }}>{o.name}</span>;
      },
    },
    {
      title: t("maint.col.team"),
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
      title: t("maint.col.part"),
      dataIndex: "part",
      key: "part",
      sorter: true,
      render: (v) => (v ? <span className="pill pill-neutral">{v}</span> : dash),
    },
    {
      title: "",
      key: "options",
      width: 160,
      render: (_, m) => {
        // Name the row in the label — every row shows the same three icons.
        const label = `repair on ${m.device_id}`;
        return list.trashed ? (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button size="small" onClick={() => handleRestore(m.maintenance_id)}>
              {t("row.action.restore")}
            </Button>
            <Button
              type="text"
              danger
              aria-label={t("row.action.deleteForever", { label })}
              title={t("row.action.deleteForever", { label })}
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(m)}
            />
          </div>
        ) : (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Popover
              title={t("maint.detail.title")}
              content={detailBubble(m)}
              trigger={["hover", "focus"]}
              placement="left"
            >
              <span
                className="info-trigger"
                tabIndex={0}
                aria-label={t("row.action.details", { label })}
              >
                <InfoIcon size={18} />
              </span>
            </Popover>
            <Button
              type="text"
              aria-label={t("row.action.edit", { label })}
              title={t("row.action.edit", { label })}
              icon={<EditIcon size={18} />}
              onClick={() => setEditTarget(m)}
            />
            <Button
              type="text"
              danger
              aria-label={t("row.action.trash", { label })}
              title={t("row.action.trash", { label })}
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(m)}
            />
          </div>
        );
      },
    },
  ];

  return (
    <>
      <div className="screen-toolbar">
        <SearchBox placeholder={t("search.maintenance")} {...list.searchProps} />
        <div className="toolbar-actions">
          <TrashToggle trashed={list.trashed} onToggle={list.toggleTrash} />
          <Button icon={<RefreshIcon size={16} />} onClick={list.reload}>
            {t("device.refresh")}
          </Button>
          <Button type="primary" icon={<PlusIcon size={16} />} onClick={onAdd}>
            {t("maint.add")}
          </Button>
        </div>
      </div>

      <div className="split-view">
        <div className="panel table-panel">
          <PanelHead
            title="maint.panel"
            trashed={list.trashed}
            total={list.total}
            selectedCount={selectedKeys.length}
            onBulkDelete={() => setBulkConfirm(true)}
            onClearSelection={clear}
          />
          <div className="table-wrap">
            <Table<Maintenance>
              rowKey="maintenance_id"
              columns={columns}
              scroll={TABLE_SCROLL}
              rowSelection={rowSelection}
              onRow={(m) => ({
                onClick: () => setSelected(m),
                className: selected?.maintenance_id === m.maintenance_id ? "row-selected" : "",
              })}
              {...list.tableProps}
            />
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
              {t("detail.empty.maintenance")}
            </div>
          </div>
        )}
      </div>

      {editTarget && (
        <MaintenanceModal
          key={editTarget.maintenance_id}
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
              ? t("maint.confirm.delete")
              : t("maint.confirm.trash")
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
              ? t("maint.confirm.bulkDelete", { n: selectedKeys.length })
              : t("maint.confirm.bulkTrash", { n: selectedKeys.length })
          }
          onConfirm={handleBulkDelete}
          onCancel={() => setBulkConfirm(false)}
        />
      )}
    </>
  );
};
