import { useEffect, useState } from "react";
import { Table, Button, Input } from "antd";
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
import { BulkDeleteBar } from "./BulkDeleteBar";
import { TrashToggle } from "./TrashToggle";
import HandoverModal from "./Modal/HandoverModal";
import { PlusIcon, RefreshIcon, ArrowRightIcon, TrashIcon, EditIcon, SearchIcon } from "./icons";
import { formatDate, resolveOwner, toUserMap } from "../lib/format";
import { usePagedList } from "../lib/usePagedList";
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
  const [searchText, setSearchText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Handover | null>(null);
  const [editTarget, setEditTarget] = useState<Handover | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [selected, setSelected] = useState<Handover | null>(null);
  const [deviceHandovers, setDeviceHandovers] = useState<Handover[]>([]);

  const list = usePagedList<Handover>(pageHandovers, {
    defaultOrderBy: "handover_date",
    defaultOrder: "desc",
    refreshKey,
  });

  useEffect(() => setSelectedKeys([]), [list.trashed]);

  // Selecting a handover loads that device's full transfer history for the
  // journey panel (not just the current page of results).
  useEffect(() => {
    if (!selected?.device_id) {
      setDeviceHandovers(selected ? [selected] : []);
      return;
    }
    let cancelled = false;
    listHandovers(selected.device_id)
      .then((rows) => {
        if (!cancelled) setDeviceHandovers(rows);
      })
      .catch(() => {
        if (!cancelled) setDeviceHandovers([selected]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

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
        <div className="screen-search">
          <Input
            allowClear
            prefix={<SearchIcon size={16} />}
            placeholder={t("search.handover")}
            style={{ width: 320 }}
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              list.search(e.target.value.trim());
            }}
            onPressEnter={() => list.searchNow(searchText.trim())}
          />
        </div>
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
          <div className="panel-head">
            <span className="panel-title">
              {t(list.trashed ? "panel.trash" : "handover.panel")}
            </span>
            {selectedKeys.length > 0 ? (
              <BulkDeleteBar
                count={selectedKeys.length}
                trashed={list.trashed}
                onDelete={() => setBulkConfirm(true)}
                onClear={() => setSelectedKeys([])}
              />
            ) : (
              <span className="panel-count">{t("panel.total", { n: list.total })}</span>
            )}
          </div>
          <div className="table-wrap">
            <Table<Handover>
              rowKey="handover_id"
              columns={columns}
              scroll={TABLE_SCROLL}
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys as string[]),
              }}
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
              Select a handover to trace its device's full chain of custody.
            </div>
          </div>
        )}
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
