import { useState } from "react";
import { Table, Button } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import {
  pageUsers,
  deleteUser,
  deleteUsersBatch,
  restoreUser,
} from "../api/users";
import { ApiError } from "../api/client";
import type { User, UserStatus } from "../types";
import type { Key } from "../i18n/catalog";
import EmployeeModal from "./Modal/EmployeeModal";
import { ConfirmModal } from "./Modal/ConfirmModal";
import { PanelHead } from "./PanelHead";
import { SearchBox } from "./SearchBox";
import { TrashToggle } from "./TrashToggle";
import { PlusIcon, RefreshIcon, TrashIcon, EditIcon } from "./icons";
import { usePagedList } from "../lib/usePagedList";
import { useTableSelection } from "../lib/useTableSelection";
import { TABLE_SCROLL } from "../lib/table";
import { useT } from "../i18n/useT";

/** The message the backend sent, or a fallback. 409s here are informative
 *  ("still owns 4 device(s)"), so they are worth showing verbatim. */
function reason(e: unknown, fallback: string): string {
  return e instanceof ApiError ? String(e.message) : `${fallback}: ${e}`;
}

type EmployeeFilter = "all" | "active" | "retired" | "noTeam";

const EMPLOYEE_FILTERS: { value: EmployeeFilter; label: Key }[] = [
  { value: "all", label: "employee.filter.all" },
  { value: "active", label: "employee.status.active" },
  { value: "retired", label: "employee.status.retired" },
  { value: "noTeam", label: "employee.filter.noTeam" },
];

export const EmployeeScreen = ({
  refreshKey = 0,
  onAdd,
}: {
  refreshKey?: number;
  onAdd?: () => void;
}) => {
  const { t } = useT();
  const [editTarget, setEditTarget] = useState<User | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  // "all" | "active" | "retired" | "noTeam". The last one is not a status —
  // it finds the 35 people who arrived with no department and no HR record to
  // fill one from, which is otherwise a hunt for blanks down 200 rows.
  const [filter, setFilter] = useState<EmployeeFilter>("all");

  const list = usePagedList<User>(pageUsers, {
    defaultOrderBy: "employee_code",
    defaultOrder: "asc",
    status: filter === "active" || filter === "retired" ? filter : undefined,
    noTeam: filter === "noTeam",
    refreshKey,
  });
  // The rows about to be shown are a different set, so carrying keys over is a
  // trap. This used to be done by hand in the TrashToggle and chip handlers,
  // which missed every other way the view could change.
  const { selectedKeys, setSelectedKeys, clear, rowSelection } =
    useTableSelection(list.trashed, filter);

  const handleBulkDelete = async () => {
    setBulkConfirm(false);
    try {
      await deleteUsersBatch(selectedKeys, list.trashed);
      toast.success(
        t(list.trashed ? "row.bulk.deleted" : "row.bulk.trashed", {
          n: selectedKeys.length,
        }),
      );
      setSelectedKeys([]);
    } catch (e) {
      toast.error(reason(e, t("row.toast.failed", { error: "" })));
    } finally {
      list.reload();
    }
  };

  const handleDelete = async (code: string, permanent: boolean) => {
    setDeleteTarget(null);
    try {
      await deleteUser(code, permanent);
      toast.success(
        t(permanent ? "employee.toast.deleted" : "row.toast.trashed"),
      );
    } catch (e) {
      toast.error(reason(e, t("row.toast.failed", { error: "" })));
    } finally {
      list.reload();
    }
  };

  const handleRestore = async (code: string) => {
    try {
      await restoreUser(code);
      toast.success(t("employee.toast.restored"));
    } catch (e) {
      toast.error(reason(e, t("row.toast.failed", { error: "" })));
    } finally {
      list.reload();
    }
  };

  const dash = <span className="text-faint">—</span>;

  const columns: TableColumnsType<User> = [
    {
      title: t("employee.col.code"),
      dataIndex: "employee_code",
      key: "employee_code",
      sorter: true,
      render: (code: string) => <span style={{ fontWeight: 600 }}>{code}</span>,
    },
    {
      title: t("employee.col.name"),
      dataIndex: "name",
      key: "name",
      sorter: true,
      render: (name: string | null) => name?.trim() || dash,
    },
    {
      title: t("employee.col.team"),
      dataIndex: "team",
      key: "team",
      sorter: true,
      render: (team: string | null) =>
        team?.trim() ? <span className="pill pill-accent">{team}</span> : dash,
    },
    {
      title: t("employee.col.status"),
      dataIndex: "status",
      key: "status",
      sorter: true,
      render: (status: UserStatus | null) => (
        <span className={`pill ${status === "retired" ? "pill-neutral" : "pill-success"}`}>
          {t(status === "retired" ? "employee.status.retired" : "employee.status.active")}
        </span>
      ),
    },
    {
      title: "",
      key: "options",
      width: 132,
      render: (_, u) => {
        // Same icons on every row, so name the row in the label.
        const label = u.name?.trim() || u.employee_code;
        return list.trashed ? (
          <div className="flex items-center gap-1">
            <Button size="small" onClick={() => handleRestore(u.employee_code)}>
              {t("row.action.restore")}
            </Button>
            <Button
              type="text"
              danger
              aria-label={t("row.action.deleteForever", { label })}
              title={t("row.action.deleteForever", { label })}
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(u)}
            />
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              type="text"
              aria-label={t("row.action.edit", { label })}
              title={t("row.action.edit", { label })}
              icon={<EditIcon size={18} />}
              onClick={() => setEditTarget(u)}
            />
            <Button
              type="text"
              danger
              aria-label={t("row.action.trash", { label })}
              title={t("row.action.trash", { label })}
              icon={<TrashIcon size={18} />}
              onClick={() => setDeleteTarget(u)}
            />
          </div>
        );
      },
    },
  ];

  return (
    <>
      <div className="screen-toolbar">
        <SearchBox placeholder={t("search.employee")} {...list.searchProps} />
        <div className="toolbar-actions">
          <TrashToggle trashed={list.trashed} onToggle={list.toggleTrash} />
          <Button icon={<RefreshIcon size={16} />} onClick={list.reload}>
            {t("device.refresh")}
          </Button>
          <Button type="primary" icon={<PlusIcon size={16} />} onClick={onAdd}>
            {t("employee.add")}
          </Button>
        </div>
      </div>

      <div className="panel">
        <PanelHead
          title="employee.panel"
          trashed={list.trashed}
          total={list.total}
          selectedCount={selectedKeys.length}
          onBulkDelete={() => setBulkConfirm(true)}
          onClearSelection={clear}
        />
        <div className="status-chips">
        {EMPLOYEE_FILTERS.map((f) => (
          <button
            key={f.value}
            className={`status-chip${filter === f.value ? " active" : ""}`}
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {t(f.label)}
          </button>
        ))}
      </div>

      <div className="table-wrap">
          <Table<User>
            rowKey="employee_code"
            columns={columns}
            scroll={TABLE_SCROLL}
            rowSelection={rowSelection}
            {...list.tableProps}
          />
        </div>
      </div>

      {editTarget && (
        <EmployeeModal
          isEdit
          user={editTarget}
          onClose={() => {
            setEditTarget(null);
            list.reload();
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          message={
            t(
              list.trashed ? "employee.confirm.delete" : "employee.confirm.trash",
              { name: deleteTarget.name?.trim() || deleteTarget.employee_code },
            )
          }
          onConfirm={() => handleDelete(deleteTarget.employee_code, list.trashed)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {bulkConfirm && (
        <ConfirmModal
          message={
            t(
              list.trashed
                ? "employee.confirm.bulkDelete"
                : "employee.confirm.bulkTrash",
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
