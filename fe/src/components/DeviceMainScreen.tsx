import { useState, useEffect } from "react";
import { Table, Button, Popover } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import {
  pageDevices,
  deleteDevice,
  deleteDevicesBatch,
  restoreDevice,
} from "../api/devices";
import { listUsersIncludingDeleted } from "../api/users";
import type { Device, DeviceStatus, User } from "../types";
import { DEVICE_STATUS_META, DEVICE_STATUS_ORDER } from "../types";
import { CreateDeviceModal } from "./Modal/CreateDeviceModal";
import { ConfirmModal } from "./Modal/ConfirmModal";
import { PanelHead } from "./PanelHead";
import { SearchBox } from "./SearchBox";
import { TrashToggle } from "./TrashToggle";
import {
  PlusIcon,
  RefreshIcon,
  DownloadIcon,
  TrashIcon,
  EditIcon,
  InfoIcon,
} from "./icons";
import { formatDate, resolveOwner, toUserMap } from "../lib/format";
import { usePagedList } from "../lib/usePagedList";
import { useTableSelection } from "../lib/useTableSelection";
import { TABLE_SCROLL } from "../lib/table";
import { ApiError } from "../api/client";
import { useT } from "../i18n/useT";
import { exportDevices } from "../lib/exportDevices";
import { todayIsoDate } from "../lib/format";

type StatusFilter = DeviceStatus | "all";

export const DeviceMainScreen = ({
  refreshKey = 0,
  onAdd,
}: {
  refreshKey?: number;
  onAdd?: () => void;
}) => {
  const { t } = useT();
  const [users, setUsers] = useState<Record<string, User>>({});
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [editTarget, setEditTarget] = useState<Device | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);

  const list = usePagedList<Device>(pageDevices, {
    defaultOrderBy: "serial_number",
    defaultOrder: "asc",
    status: statusFilter === "all" ? undefined : statusFilter,
    refreshKey,
  });
  // Drop any selection when the view (active/trash or status filter) changes.
  const { selectedKeys, setSelectedKeys, clear, rowSelection } =
    useTableSelection(list.trashed, statusFilter);

  useEffect(() => {
    // Includes trashed staff: a device's owner may have left, and the row
    // should still show their name rather than a bare code.
    listUsersIncludingDeleted()
      .then((u) => setUsers(toUserMap(u)))
      .catch(() => {});
  }, []);

  /** Download the WHOLE ledger, deliberately ignoring the search box, the status
   * chips and the sort — "export the device list" means the list, not whatever
   * happens to be filtered on screen. */
  const runExport = async () => {
    setExporting(true);
    try {
      const n = await exportDevices(users, todayIsoDate());
      toast[n ? "success" : "info"](t(n ? "export.done" : "export.empty", { n }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("export.failed"));
    } finally {
      setExporting(false);
    }
  };

  const handleBulkDelete = async () => {
    setBulkConfirm(false);
    try {
      await deleteDevicesBatch(selectedKeys, list.trashed);
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

  const handleDelete = async (serial: string, permanent: boolean) => {
    setDeleteTarget(null);
    try {
      await deleteDevice(serial, permanent);
      toast.success(
        t(permanent ? "device.toast.deleted" : "row.toast.trashed"),
      );
    } catch (e) {
      toast.error(t("row.toast.failed", { error: String(e) }));
    } finally {
      list.reload();
    }
  };

  const handleRestore = async (serial: string) => {
    try {
      await restoreDevice(serial);
      toast.success(t("device.toast.restored"));
    } catch (e) {
      toast.error(t("row.toast.failed", { error: String(e) }));
    } finally {
      list.reload();
    }
  };

  const dash = <span className="text-faint">—</span>;

  const specBubble = (d: Device) => {
    const rows: [string, string | null][] = [
      [t("field.barcode"), d.barcode],
      [t("field.type"), d.type],
      [t("field.brand"), d.brand],
      [t("field.cpu"), d.cpu],
      [t("field.ram"), d.ram],
      [t("field.storage"), d.storage],
      [t("field.os"), d.os],
      [t("field.msoffice"), d.msoffice],
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
      title: t("device.col.device"),
      dataIndex: "name",
      key: "name",
      sorter: true,
      render: (name, d) => (
        <span style={{ fontWeight: 600 }}>{name ?? d.serial_number}</span>
      ),
    },
    {
      title: t("device.col.owner"),
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
      title: t("device.col.serial"),
      dataIndex: "serial_number",
      key: "serial_number",
      sorter: true,
    },
    {
      title: t("device.col.status"),
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
      title: t("device.col.buyDate"),
      dataIndex: "buy_date",
      key: "buy_date",
      sorter: true,
      render: (v) => (v ? formatDate(v) : dash),
    },
    {
      title: "",
      key: "options",
      width: 132,
      render: (_, d) => {
        // Every row renders the same icons, so the accessible name has to name
        // the row too — otherwise a screen reader hears "button" twenty times.
        const label = d.name ?? d.serial_number;
        return list.trashed ? (
          <div className="flex items-center gap-1">
            <Button size="small" onClick={() => handleRestore(d.serial_number)}>
              {t("row.action.restore")}
            </Button>
            <Button
              type="text"
              danger
              aria-label={t("row.action.deleteForever", { label })}
              title={t("row.action.deleteForever", { label })}
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(d)}
            />
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Popover
              title={label}
              content={specBubble(d)}
              trigger={["hover", "focus"]}
              placement="left"
            >
              <span
                className="info-trigger"
                tabIndex={0}
                aria-label={t("row.action.specs", { label })}
              >
                <InfoIcon size={18} />
              </span>
            </Popover>
            <Button
              type="text"
              aria-label={t("row.action.edit", { label })}
              title={t("row.action.edit", { label })}
              icon={<EditIcon size={18} />}
              onClick={() => setEditTarget(d)}
            />
            <Button
              type="text"
              danger
              aria-label={t("row.action.trash", { label })}
              title={t("row.action.trash", { label })}
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(d)}
            />
          </div>
        );
      },
    },
  ];

  const statusChips: StatusFilter[] = ["all", ...DEVICE_STATUS_ORDER];

  return (
    <>
      <div className="screen-toolbar">
        <SearchBox placeholder={t("search.device")} {...list.searchProps} />
        <div className="toolbar-actions">
          <Button
            icon={<DownloadIcon size={16} />}
            loading={exporting}
            onClick={runExport}
            title={t("export.title")}
          >
            {t("export.button")}
          </Button>
          <TrashToggle trashed={list.trashed} onToggle={list.toggleTrash} />
          <Button icon={<RefreshIcon size={16} />} onClick={list.reload}>
            {t("device.refresh")}
          </Button>
          <Button type="primary" icon={<PlusIcon size={16} />} onClick={onAdd}>
            {t("device.add")}
          </Button>
        </div>
      </div>

      {!list.trashed && (
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
              {s === "all" ? t("device.chip.all") : DEVICE_STATUS_META[s].label}
            </button>
          ))}
        </div>
      )}

      <div className="panel">
        <PanelHead
          title="device.panel"
          trashed={list.trashed}
          total={list.total}
          selectedCount={selectedKeys.length}
          onBulkDelete={() => setBulkConfirm(true)}
          onClearSelection={clear}
        />
        <div className="table-wrap">
          <Table<Device>
            rowKey="serial_number"
            columns={columns}
            scroll={TABLE_SCROLL}
            rowSelection={rowSelection}
            {...list.tableProps}
          />
        </div>
      </div>

      {editTarget && (
        <CreateDeviceModal
          key={editTarget.serial_number}
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
            t(list.trashed ? "device.confirm.delete" : "device.confirm.trash", {
              name: deleteTarget.name ?? deleteTarget.serial_number,
            })
          }
          onConfirm={() => handleDelete(deleteTarget.serial_number, list.trashed)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {bulkConfirm && (
        <ConfirmModal
          message={
            t(
              list.trashed
                ? "device.confirm.bulkDelete"
                : "device.confirm.bulkTrash",
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
