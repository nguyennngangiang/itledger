// Things the handover importer would not decide on its own.
//
// The importer's rule is that it never silently picks a side: a person whose code
// looks mistyped, a field that contradicts the workbook, a device created with only
// the half of its spec a handover record carries — each is written to import_issues
// instead of guessed at. This screen is that backlog.
//
// It is deliberately a SHORT list. Filling a column the ledger left empty is not a
// disagreement and never lands here; neither does creating a person the minutes
// name. What does land here always names a row that exists and always offers a way
// to settle it — a notification you cannot act on trains people to ignore the bell.
//
// Two ways to close a row: settle it (which writes the chosen values), or dismiss
// it. Either way the row stays in the log — knowing something was waved through is
// the point of having a log. A row the ledger has since answered closes itself, via
// the recheck pass run before every load.
import { useCallback, useEffect, useState } from "react";
import { Table, Button, Tag, Alert, Empty, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { toast } from "react-toastify";
import {
  listImportIssues,
  recheckIssues,
  resolveImportIssue,
  type ImportIssue,
  type IssueKind,
} from "../api/imports";
import { getUser, listUserTeams, updateUser } from "../api/users";
import { getDevice, updateDevice } from "../api/devices";
import { ApiError } from "../api/client";
import {
  ResolveCodeMismatchModal,
  ResolveConflictModal,
  type Resolution,
} from "./Modal/ResolveConflictModal";
import { CreateDeviceModal } from "./Modal/CreateDeviceModal";
import type { Device } from "../types";
import { RefreshIcon } from "./icons";
import { TABLE_SCROLL } from "../lib/table";
import { KIND_META, conflictFields, describeIssue, isWritable } from "../lib/issues";
import { useT } from "../i18n/useT";
import type { Key } from "../i18n/catalog";

type StatusFilter = "open" | "resolved" | "dismissed";

const STATUS_TABS: { value: StatusFilter; label: Key }[] = [
  { value: "open", label: "notif.filter.open" },
  { value: "resolved", label: "notif.filter.resolved" },
  { value: "dismissed", label: "notif.filter.dismissed" },
];

export function NotificationScreen({
  refreshKey = 0,
  onChanged,
}: {
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const { t } = useT();
  const [rows, setRows] = useState<ImportIssue[]>([]);
  const [status, setStatus] = useState<StatusFilter>("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<string[]>([]);
  const [editing, setEditing] = useState<ImportIssue | null>(null);
  const [editingCode, setEditingCode] = useState<ImportIssue | null>(null);
  const [completing, setCompleting] = useState<{
    issue: ImportIssue;
    device: Device;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Whatever route someone used to fix the data — this screen, the Devices
      // editor, a later import — the row it answers closes here.
      await recheckIssues().catch(() => {});
      setRows(await listImportIssues(status));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("notif.err.load"));
    } finally {
      setLoading(false);
    }
  }, [status, t]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Team names for the conflict dialog, so settling a team picks a spelling
  // already in use instead of starting a second one.
  useEffect(() => {
    listUserTeams()
      .then(setTeams)
      .catch(() => {});
  }, []);

  const close = async (
    issue: ImportIssue,
    next: "resolved" | "dismissed",
    resolution?: Record<string, unknown>,
  ) => {
    try {
      await resolveImportIssue(issue.id, next, resolution);
      toast.success(t(next === "resolved" ? "notif.toast.resolved" : "notif.toast.dismissed"));
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("notif.err.update"));
    }
  };

  /** Settling a conflict writes the chosen values, then closes the issue. */
  const settle = async (issue: ImportIssue, resolution: Resolution) => {
    if (!issue.item_id || !isWritable(issue)) return;
    if (!Object.keys(resolution).length) {
      // Every field left on "keep" — nothing to write, but the human has
      // ruled, so the row is settled rather than silently doing nothing.
      setEditing(null);
      await close(issue, "resolved", { note: t("notif.resolution.kept") });
      return;
    }
    try {
      if (issue.resource === "users") {
        await updateUser(issue.item_id, resolution);
      } else {
        await updateDevice(issue.item_id, resolution);
      }
    } catch (e) {
      const gone = e instanceof ApiError && e.status === 404;
      toast.error(
        gone
          ? t("notif.err.gone", { code: issue.item_id })
          : e instanceof ApiError
            ? e.message
            : t("notif.err.write"),
      );
      return;
    }
    setEditing(null);
    await close(issue, "resolved", resolution);
  };

  /** An incomplete device opens the normal device editor, not a bespoke form. */
  const completeDevice = async (issue: ImportIssue) => {
    if (!issue.item_id) return;
    try {
      setCompleting({ issue, device: await getDevice(issue.item_id) });
    } catch (e) {
      const gone = e instanceof ApiError && e.status === 404;
      toast.error(
        gone
          ? t("notif.err.gone", { code: issue.item_id })
          : e instanceof ApiError
            ? e.message
            : t("notif.err.deviceLoad"),
      );
    }
  };

  const reopen = async (issue: ImportIssue) => {
    try {
      await resolveImportIssue(issue.id, "open");
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("notif.err.reopen"));
    }
  };

  /** Ruling on a mistyped code. Nothing is merged — the choice is recorded and the
   * row closed, so the same pair stops being raised on every later import. */
  const settleCode = async (issue: ImportIssue, useCode: string) => {
    setEditingCode(null);
    const kept = useCode === (issue.payload.code ?? issue.item_id);
    await close(issue, "resolved", {
      use_code: useCode,
      note: kept
        ? t("notif.resolution.samePerson")
        : t("notif.resolution.useCode", { code: useCode }),
    });
  };

  const openConflict = async (issue: ImportIssue) => {
    // A row pointing at a code with no record used to offer a "fix" that PATCHed
    // a 404. Check before opening the dialog, not after the user has chosen.
    if (issue.item_id && issue.resource === "users") {
      try {
        await getUser(issue.item_id);
      } catch {
        toast.error(t("notif.err.gone", { code: issue.item_id }));
        return;
      }
    }
    setEditing(issue);
  };

  const actionsFor = (issue: ImportIssue) => {
    if (issue.status !== "open") return null;
    if (issue.kind === "user_code_mismatch") {
      return (
        <Button size="small" type="primary" onClick={() => setEditingCode(issue)}>
          {t("notif.action.pickCode")}
        </Button>
      );
    }
    if (issue.kind === "device_created_incomplete") {
      return (
        <Button size="small" type="primary" onClick={() => completeDevice(issue)}>
          {t("notif.action.complete")}
        </Button>
      );
    }
    if (conflictFields(issue.payload).length && isWritable(issue) && issue.item_id) {
      return (
        <Button size="small" type="primary" onClick={() => openConflict(issue)}>
          {t("notif.action.pickValues")}
        </Button>
      );
    }
    // Handover-scoped kinds (duplicate, unclear direction) have no single row to
    // patch — reading the record and waving it through IS the action.
    return null;
  };

  const columns: TableColumnsType<ImportIssue> = [
    {
      title: t("notif.col.kind"),
      dataIndex: "kind",
      key: "kind",
      width: 190,
      render: (kind: IssueKind) => (
        <Tag color={KIND_META[kind]?.color}>
          {KIND_META[kind] ? t(KIND_META[kind].label) : kind}
        </Tag>
      ),
    },
    {
      title: t("notif.col.item"),
      dataIndex: "item_id",
      key: "item_id",
      width: 140,
      render: (v: string | null) =>
        v ? (
          <code>{v}</code>
        ) : (
          <span className="text-faint">{t("notif.item.unreadable")}</span>
        ),
    },
    {
      title: t("notif.col.detail"),
      key: "detail",
      render: (_, issue) => describeIssue(issue, t),
    },
    {
      title: t("notif.col.source"),
      dataIndex: "source_file",
      key: "source_file",
      width: 170,
      render: (v: string | null) => (
        <Tooltip title={v ?? undefined}>
          <span className="text-faint">{v ?? "—"}</span>
        </Tooltip>
      ),
    },
    {
      title: "",
      key: "actions",
      width: 200,
      render: (_, issue) =>
        issue.status === "open" ? (
          <div className="flex items-center gap-1">
            {actionsFor(issue)}
            <Button size="small" onClick={() => close(issue, "dismissed")}>
              {t("notif.action.dismiss")}
            </Button>
          </div>
        ) : (
          // Closed rows are a log, not a queue. Reopening is the one action that
          // still makes sense — a recheck that closed something too eagerly.
          <Button size="small" onClick={() => reopen(issue)}>
            {t("notif.action.reopen")}
          </Button>
        ),
    },
  ];

  return (
    <>
      <div className="screen-toolbar">
        <div className="screen-search">
          <span className="text-faint">
            {status === "open"
              ? rows.length
                ? t("notif.count", { n: rows.length })
                : t("notif.count.none")
              : t("notif.log", { n: rows.length })}
          </span>
        </div>
        <div className="toolbar-actions">
          <Button icon={<RefreshIcon size={16} />} onClick={load}>
            {t("notif.action.refresh")}
          </Button>
        </div>
      </div>

      {/* Same chip row the Devices screen filters with — antd's Segmented is
          unthemed here and lands as a grey slab on the app's lavender wash. */}
      <div className="status-chips">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            className={`status-chip${status === tab.value ? " active" : ""}`}
            aria-pressed={status === tab.value}
            onClick={() => setStatus(tab.value)}
          >
            {t(tab.label)}
          </button>
        ))}
      </div>

      {error && <Alert type="error" showIcon message={error} />}

      <div className="table-wrap">
        <Table<ImportIssue>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          scroll={TABLE_SCROLL}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{
            emptyText: (
              <Empty
                description={
                  status === "open"
                    ? t("notif.empty.open")
                    : t("notif.empty.log")
                }
              />
            ),
          }}
        />
      </div>

      {editing && (
        <ResolveConflictModal
          title={`${
            KIND_META[editing.kind] ? t(KIND_META[editing.kind].label) : editing.kind
          } · ${editing.item_id ?? ""}`}
          issue={{
            kind: editing.kind,
            resource: editing.resource,
            item_id: editing.item_id,
            payload: editing.payload,
          }}
          teams={teams}
          onClose={() => setEditing(null)}
          onResolve={(resolution) => settle(editing, resolution)}
        />
      )}

      {editingCode && (
        <ResolveCodeMismatchModal
          issue={{
            kind: editingCode.kind,
            resource: editingCode.resource,
            item_id: editingCode.item_id,
            payload: editingCode.payload,
          }}
          onClose={() => setEditingCode(null)}
          onChoose={(useCode) => settleCode(editingCode, useCode)}
        />
      )}

      {completing && (
        <CreateDeviceModal
          isEdit
          device={completing.device}
          // Only a real save closes the issue — Cancel must leave it open.
          onSaved={() => close(completing.issue, "resolved", { completed: true })}
          onClose={() => {
            setCompleting(null);
            load();
          }}
        />
      )}
    </>
  );
}
