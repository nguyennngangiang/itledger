import { useEffect, useState } from "react";
import { Table, Button } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import {
  pageHandovers,
  listHandovers,
  deleteHandover,
  deleteHandoversBatch,
  restoreHandover,
} from "../api/handovers";
import { listUsersIncludingDeleted } from "../api/users";
import { listDevices } from "../api/devices";
import type { Handover, Device, User } from "../types";
import { ConfirmModal } from "./Modal/ConfirmModal";
import { PanelHead } from "./PanelHead";
import { SearchBox } from "./SearchBox";
import { TrashToggle } from "./TrashToggle";
import HandoverModal from "./Modal/HandoverModal";
import { PlusIcon, RefreshIcon, ArrowRightIcon, TrashIcon, EditIcon } from "./icons";
import { formatDate, resolveOwner, toUserMap } from "../lib/format";
import { usePagedList } from "../lib/usePagedList";
import { useTableSelection } from "../lib/useTableSelection";
import { TABLE_SCROLL } from "../lib/table";
import { DeviceJourneyPanel } from "./DeviceJourneyPanel";
import { useT } from "../i18n/useT";

export const HandoverScreen = ({
  refreshKey = 0,
  onAdd,
}: {
  refreshKey?: number;
  onAdd?: () => void;
}) => {
  const { t } = useT();
  const [users, setUsers] = useState<Record<string, User>>({});
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [deleteTarget, setDeleteTarget] = useState<Handover | null>(null);
  const [editTarget, setEditTarget] = useState<Handover | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [selected, setSelected] = useState<Handover | null>(null);
  // Tagged with the device it belongs to, so the panel can tell "this machine's
  // history" from "the previous machine's history, still on screen".
  const [history, setHistory] = useState<{
    deviceId: string;
    rows: Handover[];
  } | null>(null);

  const list = usePagedList<Handover>(pageHandovers, {
    defaultOrderBy: "handover_date",
    defaultOrder: "desc",
    refreshKey,
  });
  const { selectedKeys, setSelectedKeys, clear, rowSelection } =
    useTableSelection(list.trashed);

  // Selecting a handover loads that device's full transfer history for the
  // journey panel (not just the current page of results). The effect only fetches
  // — what the panel shows is derived below, so a row with no device, a failed
  // fetch and a fetch still in flight all fall back to the selected row itself
  // rather than to whatever the previously selected machine left behind.
  useEffect(() => {
    const deviceId = selected?.device_id;
    if (!deviceId) return;
    let cancelled = false;
    listHandovers(deviceId).then(
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

  const deviceHandovers =
    selected === null
      ? []
      : history?.deviceId === selected.device_id
        ? history.rows
        : [selected];

  const handleBulkDelete = async () => {
    setBulkConfirm(false);
    try {
      await deleteHandoversBatch(selectedKeys, list.trashed);
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
    // Includes trashed staff — a handover names whoever held the device at the
    // time, and history should keep reading as history after they leave.
    Promise.all([listUsersIncludingDeleted(), listDevices()])
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
      toast.success(t(permanent ? "row.toast.deleted" : "row.toast.trashed"));
    } catch (e) {
      toast.error(t("row.toast.failed", { error: String(e) }));
    } finally {
      list.reload();
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await restoreHandover(id);
      toast.success(t("row.toast.restored"));
    } catch (e) {
      toast.error(t("row.toast.failed", { error: String(e) }));
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
      title: t("handover.col.date"),
      dataIndex: "handover_date",
      key: "handover_date",
      width: 130,
      sorter: true,
      render: (v) => (v ? formatDate(v) : dash),
    },
    {
      title: t("handover.col.device"),
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
      title: t("handover.col.transfer"),
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
      title: t("handover.col.reason"),
      dataIndex: "reason",
      key: "reason",
      render: (v) => (v ? v : dash),
    },
    {
      title: "",
      key: "options",
      width: 140,
      render: (_, h) => {
        // Name the row in the label — every row shows the same icons.
        const label = `handover of ${h.device_id}`;
        return list.trashed ? (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button size="small" onClick={() => handleRestore(h.handover_id)}>
              {t("row.action.restore")}
            </Button>
            <Button
              type="text"
              danger
              aria-label={t("row.action.deleteForever", { label })}
              title={t("row.action.deleteForever", { label })}
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(h)}
            />
          </div>
        ) : (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              type="text"
              aria-label={t("row.action.edit", { label })}
              title={t("row.action.edit", { label })}
              icon={<EditIcon size={18} />}
              onClick={() => setEditTarget(h)}
            />
            <Button
              type="text"
              danger
              aria-label={t("row.action.trash", { label })}
              title={t("row.action.trash", { label })}
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(h)}
            />
          </div>
        );
      },
    },
  ];

  return (
    <>
      <div className="screen-toolbar">
        <SearchBox placeholder={t("search.handover")} {...list.searchProps} />
        <div className="toolbar-actions">
          <TrashToggle trashed={list.trashed} onToggle={list.toggleTrash} />
          <Button icon={<RefreshIcon size={16} />} onClick={list.reload}>
            {t("device.refresh")}
          </Button>
          <Button type="primary" icon={<PlusIcon size={16} />} onClick={onAdd}>
            {t("handover.add")}
          </Button>
        </div>
      </div>

      <div className="split-view">
        <div className="panel table-panel">
          <PanelHead
            title="handover.panel"
            trashed={list.trashed}
            total={list.total}
            selectedCount={selectedKeys.length}
            onBulkDelete={() => setBulkConfirm(true)}
            onClearSelection={clear}
          />
          <div className="table-wrap">
            <Table<Handover>
              rowKey="handover_id"
              columns={columns}
              scroll={TABLE_SCROLL}
              rowSelection={rowSelection}
              onRow={(h) => ({
                onClick: () => setSelected(h),
                className: selected?.handover_id === h.handover_id ? "row-selected" : "",
              })}
              {...list.tableProps}
            />
          </div>
        </div>

        {selected ? (
          <DeviceJourneyPanel
            device={selected.device_id ? devices[selected.device_id] : undefined}
            handovers={deviceHandovers}
            users={users}
            onClose={() => setSelected(null)}
          />
        ) : (
          <div className="panel detail-panel">
            <div className="detail-panel-empty">
              {t("detail.empty.handover")}
            </div>
          </div>
        )}
      </div>

      {editTarget && (
        <HandoverModal
          // Remount per row: the form prefills from initial state, so the same
          // mounted modal must never be handed a different record.
          key={editTarget.handover_id}
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
              ? t("handover.confirm.delete")
              : t("handover.confirm.trash")
          }
          onConfirm={() => handleDelete(deleteTarget.handover_id, list.trashed)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {bulkConfirm && (
        <ConfirmModal
          message={
            t(
              list.trashed
                ? "handover.confirm.bulkDelete"
                : "handover.confirm.bulkTrash",
              { n: selectedKeys.length },
            )
          }
          onConfirm={handleBulkDelete}
          onCancel={() => setBulkConfirm(false)}
        />
      )}

    </>
  );
};
