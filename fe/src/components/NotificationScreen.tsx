// Things the handover importer would not decide on its own.
//
// The importer's rule is that it never silently picks a side: a person whose code
// looks mistyped, a field that contradicts the workbook, a device created with only
// the half of its spec a handover record carries — each is written to import_issues
// instead of guessed at. This screen is that backlog.
//
// It is a QUEUE of decisions, not a list to read, so each job is a card and the
// decision opens right there — the two (or three) options as cards to pick from —
// instead of behind a dialog you have to open before you even know what it asks.
// Eight issue kinds are folded into three tones: needs a decision (amber),
// suspect data (red), for information (grey).
//
// Two ways to close a row: settle it (which writes the chosen values), or dismiss
// it. Either way the row stays in the log — knowing something was waved through is
// the point of having a log. A row the ledger has since answered closes itself, via
// the recheck pass run before every load.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Select } from "antd";
import dayjs from "dayjs";
import { toast } from "react-toastify";
import {
  listImportIssues,
  recheckIssues,
  resolveImportIssue,
  type FieldConflict,
  type ImportIssue,
  type IssueKind,
} from "../api/imports";
import { getUser, listUserTeams, updateUser } from "../api/users";
import { getDevice, updateDevice } from "../api/devices";
import { ApiError } from "../api/client";
import type { Choice, Resolution } from "./Modal/ResolveConflictModal";
import { CreateDeviceModal } from "./Modal/CreateDeviceModal";
import type { Device } from "../types";
import { DeviceIcon, HandoverIcon, RefreshIcon, UserIcon } from "./icons";
import { KIND_META, conflictFields, describeIssue, fieldLabel, isWritable } from "../lib/issues";
import { useT } from "../i18n/useT";
import type { Key } from "../i18n/catalog";

type StatusFilter = "open" | "resolved" | "dismissed";

const STATUS_TABS: { value: StatusFilter; label: Key }[] = [
  { value: "open", label: "notif.filter.open" },
  { value: "resolved", label: "notif.filter.resolved" },
  { value: "dismissed", label: "notif.filter.dismissed" },
];

type Tone = "decide" | "suspect" | "info";
const TONE: Record<IssueKind, Tone> = {
  user_code_mismatch: "decide",
  device_field_conflict: "decide",
  user_field_conflict: "decide",
  device_owner_mismatch: "decide",
  device_created_incomplete: "decide",
  handover_duplicate: "suspect",
  flow_ambiguous: "suspect",
  user_created: "info",
};

const show = (v: string | null | undefined) => (v == null || v === "" ? "—" : v);

/** Serials and employee codes inside a sentence, set in monospace. */
function withCodes(text: string, codes: (string | null | undefined)[]) {
  const list = [...new Set(codes.filter((c): c is string => !!c && c.length > 1))].sort((a, b) => b.length - a.length);
  if (!list.length) return text;
  const re = new RegExp(`(${list.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(re).map((part, i) =>
    list.includes(part) ? (
      <span className="mono" key={i}>
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function kindIcon(issue: ImportIssue) {
  if (issue.resource === "users") return <UserIcon size={19} />;
  if (issue.resource === "devices") return <DeviceIcon size={19} />;
  return <HandoverIcon size={19} />;
}

/** Default per-field choice — the same rule the import wizard's dialog uses:
 * take the record's value, except a team that already has a spelling in use. */
function defaultChoices(fields: FieldConflict[], suggestion: string | null) {
  return Object.fromEntries(
    fields.map((f) => [f.field, f.field === "team" && suggestion && suggestion !== f.proposed ? "manual" : "take"]),
  ) as Record<string, Choice>;
}

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
  // The one job whose decision is open in place.
  const [openId, setOpenId] = useState<number | null>(null);
  const [pickedCode, setPickedCode] = useState<string>("");
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [manual, setManual] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState<{ issue: ImportIssue; device: Device } | null>(null);

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
    // `load` raises the loading flag before it awaits, which the compiler rule
    // reads as a synchronous setState. That is what it should do: this screen
    // re-checks every open issue on the way in, which takes long enough that
    // showing nothing would look broken.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, refreshKey]);

  // Team names for the "type it" option, so settling a team picks a spelling
  // already in use instead of starting a second one.
  useEffect(() => {
    listUserTeams()
      .then(setTeams)
      .catch(() => {});
  }, []);

  const close = async (issue: ImportIssue, next: "resolved" | "dismissed", resolution?: Record<string, unknown>) => {
    setBusy(true);
    try {
      await resolveImportIssue(issue.id, next, resolution);
      toast.success(t(next === "resolved" ? "notif.toast.resolved" : "notif.toast.dismissed"));
      setOpenId(null);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("notif.err.update"));
    } finally {
      setBusy(false);
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

  /** Open a job's decision in place, with the same defaults the dialog had. */
  const expand = async (issue: ImportIssue) => {
    if (openId === issue.id) return setOpenId(null);
    // A row pointing at a code with no record used to offer a "fix" that
    // PATCHed a 404. Check before offering the choice, not after it is made.
    if (issue.kind !== "user_code_mismatch" && issue.item_id && issue.resource === "users") {
      try {
        await getUser(issue.item_id);
      } catch {
        toast.error(t("notif.err.gone", { code: issue.item_id }));
        return;
      }
    }
    const fields = conflictFields(issue.payload);
    const suggestion = issue.payload.team_suggestion ?? null;
    setPickedCode(issue.payload.code ?? issue.item_id ?? "");
    setChoices(defaultChoices(fields, suggestion));
    setManual(Object.fromEntries(fields.map((f) => [f.field, (f.field === "team" ? suggestion : null) ?? f.proposed ?? ""])));
    setOpenId(issue.id);
  };

  /** Ruling on a mistyped code. Nothing is merged — the choice is recorded and the
   * row closed, so the same pair stops being raised on every later import. */
  const settleCode = async (issue: ImportIssue) => {
    const kept = pickedCode === (issue.payload.code ?? issue.item_id);
    await close(issue, "resolved", {
      use_code: pickedCode,
      note: kept ? t("notif.resolution.samePerson") : t("notif.resolution.useCode", { code: pickedCode }),
    });
  };

  /** Settling a conflict writes the chosen values, then closes the issue. */
  const settleFields = async (issue: ImportIssue) => {
    if (!issue.item_id || !isWritable(issue)) return;
    const resolution: Resolution = {};
    for (const f of conflictFields(issue.payload)) {
      const c = choices[f.field];
      const v = c === "keep" ? null : c === "manual" ? manual[f.field]?.trim() || null : f.proposed;
      if (v !== null) resolution[f.field] = v;
    }
    if (!Object.keys(resolution).length) {
      // Every field left on "keep": nothing to write, but the human has ruled.
      await close(issue, "resolved", { note: t("notif.resolution.kept") });
      return;
    }
    setBusy(true);
    try {
      if (issue.resource === "users") await updateUser(issue.item_id, resolution);
      else await updateDevice(issue.item_id, resolution);
    } catch (e) {
      const gone = e instanceof ApiError && e.status === 404;
      toast.error(gone ? t("notif.err.gone", { code: issue.item_id }) : e instanceof ApiError ? e.message : t("notif.err.write"));
      setBusy(false);
      return;
    }
    setBusy(false);
    await close(issue, "resolved", resolution);
  };

  /** An incomplete device opens the normal device editor: that is a form to
   * fill, not a choice between two answers. */
  const completeDevice = async (issue: ImportIssue) => {
    if (!issue.item_id) return;
    try {
      setCompleting({ issue, device: await getDevice(issue.item_id) });
    } catch (e) {
      const gone = e instanceof ApiError && e.status === 404;
      toast.error(gone ? t("notif.err.gone", { code: issue.item_id }) : e instanceof ApiError ? e.message : t("notif.err.deviceLoad"));
    }
  };

  /** The action button for an open job, or null when reading it and waving it
   * through IS the action (duplicates, unclear direction). */
  const action = (issue: ImportIssue): { label: Key; run: () => void } | null => {
    if (issue.kind === "user_code_mismatch") return { label: "notif.action.pickCode", run: () => expand(issue) };
    if (issue.kind === "device_created_incomplete") return { label: "notif.action.complete", run: () => completeDevice(issue) };
    if (conflictFields(issue.payload).length && isWritable(issue) && issue.item_id) {
      return { label: "notif.action.pickValues", run: () => expand(issue) };
    }
    return null;
  };

  const counts = useMemo(() => rows.length, [rows]);

  const decision = (issue: ImportIssue) => {
    if (issue.kind === "user_code_mismatch") {
      const proposed = issue.payload.code ?? issue.item_id ?? "";
      const options = [
        { value: proposed, title: t("conflict.code.keep", { code: proposed }), sub: show(issue.payload.name) },
        ...(issue.payload.candidates ?? []).map((c) => ({
          value: c.employee_code,
          title: t("conflict.code.use", { code: c.employee_code }),
          sub: `${show(c.name)} · ${show(c.team)}`,
        })),
      ];
      return (
        <>
          <fieldset className="nt-choices">
            <legend>{t("conflict.code.message", { name: issue.payload.name ?? "?" })}</legend>
            {options.map((o) => (
              <label key={o.value} className={`nt-choice${pickedCode === o.value ? " on" : ""}`}>
                <input type="radio" name={`code-${issue.id}`} checked={pickedCode === o.value} onChange={() => setPickedCode(o.value)} />
                <span>
                  <b>{o.title}</b>
                  <small>{o.sub}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="nt-acts">
            <Button className="nt-ghost" onClick={() => setOpenId(null)}>
              {t("conflict.cancel")}
            </Button>
            <Button type="primary" loading={busy} onClick={() => settleCode(issue)}>
              {t("conflict.code.choose")}
            </Button>
          </div>
        </>
      );
    }
    const fields = conflictFields(issue.payload);
    const suggestion = issue.payload.team_suggestion ?? null;
    return (
      <>
        {fields.map((f) => (
          <fieldset className="nt-choices" key={f.field}>
            <legend>{fieldLabel(f.field, t)}</legend>
            {(["keep", "take", "manual"] as Choice[]).map((c) => (
              <label key={c} className={`nt-choice${choices[f.field] === c ? " on" : ""}`}>
                <input
                  type="radio"
                  name={`${issue.id}-${f.field}`}
                  checked={choices[f.field] === c}
                  onChange={() => setChoices((x) => ({ ...x, [f.field]: c }))}
                />
                <span>
                  <b>
                    {c === "keep"
                      ? t("conflict.keep", { value: show(f.current) })
                      : c === "take"
                        ? t("conflict.take", { value: show(f.proposed) })
                        : t("conflict.manual")}
                  </b>
                  {c === "manual" && choices[f.field] === "manual" && (
                    f.field === "team" && teams.length ? (
                      <Select
                        showSearch
                        allowClear
                        placeholder={t("conflict.pickTeam")}
                        value={manual[f.field] || undefined}
                        options={teams.map((name) => ({ value: name, label: name }))}
                        onChange={(v) => setManual((m) => ({ ...m, [f.field]: v ?? "" }))}
                      />
                    ) : (
                      <Input value={manual[f.field] ?? ""} onChange={(e) => setManual((m) => ({ ...m, [f.field]: e.target.value }))} />
                    )
                  )}
                  {c === "manual" && f.field === "team" && suggestion && (
                    <small>
                      {t("conflict.teamInUse")} {suggestion}
                    </small>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
        ))}
        <div className="nt-acts">
          <Button className="nt-ghost" onClick={() => setOpenId(null)}>
            {t("conflict.cancel")}
          </Button>
          <Button type="primary" loading={busy} onClick={() => settleFields(issue)}>
            {t("conflict.apply")}
          </Button>
        </div>
      </>
    );
  };

  return (
    <div className="nt">
      <div className="scan-modes nt-filter" role="tablist">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            role="tab"
            aria-selected={status === tab.value}
            className={status === tab.value ? "active" : ""}
            onClick={() => {
              setOpenId(null);
              setStatus(tab.value);
            }}
          >
            {t(tab.label)}
          </button>
        ))}
      </div>

      {error && <Alert type="error" showIcon message={error} />}

      {loading && !rows.length ? (
        <p className="nt-empty">{t("common.loading")}</p>
      ) : !rows.length ? (
        <p className="nt-empty">{t(status === "open" ? "notif.empty.open" : "notif.empty.log")}</p>
      ) : (
        <ul className="nt-list" aria-busy={loading}>
          {rows.map((issue) => {
            const tone = TONE[issue.kind] ?? "decide";
            const act = issue.status === "open" ? action(issue) : null;
            const isOpen = openId === issue.id;
            const codes = [issue.item_id, issue.payload.code, ...(issue.payload.candidates ?? []).map((c) => c.employee_code)];
            return (
              <li key={issue.id} className={`nt-row tone-${tone}${isOpen ? " open" : ""}`}>
                <div className="nt-head">
                  <span className="nt-kind" aria-hidden>
                    {kindIcon(issue)}
                  </span>
                  <div className="nt-main">
                    <h2>{KIND_META[issue.kind] ? t(KIND_META[issue.kind].label) : issue.kind}</h2>
                    <p>{withCodes(describeIssue(issue, t), codes)}</p>
                  </div>
                  <div className="nt-meta">
                    {issue.source_file && <span title={issue.source_file}>{issue.source_file}</span>}
                    <span>{dayjs(issue.created_at).format("DD/MM/YYYY")}</span>
                  </div>
                </div>

                {isOpen && <div className="nt-decision">{decision(issue)}</div>}

                {!isOpen && (
                  <div className="nt-acts">
                    {issue.status === "open" ? (
                      <>
                        <Button className="nt-ghost" disabled={busy} onClick={() => close(issue, "dismissed")}>
                          {t("notif.action.dismiss")}
                        </Button>
                        {act && (
                          <Button className="nt-soft" onClick={act.run}>
                            {t(act.label)}
                          </Button>
                        )}
                      </>
                    ) : (
                      // Closed rows are a log, not a queue. Reopening is the one
                      // action that still makes sense.
                      <Button className="nt-ghost" onClick={() => reopen(issue)}>
                        {t("notif.action.reopen")}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <footer className="nt-foot">
        <span>
          {status === "open"
            ? counts
              ? t("notif.count", { n: counts })
              : t("notif.count.none")
            : t("notif.log", { n: counts })}
        </span>
        <Button className="nt-ghost" icon={<RefreshIcon size={16} />} onClick={load} loading={loading}>
          {t("notif.action.refresh")}
        </Button>
      </footer>

      {completing && (
        <CreateDeviceModal
          key={completing.device.serial_number}
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
    </div>
  );
}
