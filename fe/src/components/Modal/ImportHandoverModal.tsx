// Import a handover record (biên bản bàn giao) — read it, reconcile it, apply it.
//
// Three steps, and nothing is written until the last one. The middle step is the
// point of the whole screen: for every line item it shows which way the machine is
// moving and WHY, because the record itself cannot say. Bên A / Bên B are just the
// two parties — one record often hands a new machine out and takes an old one back
// in the same table, and plenty of records only hand one out. So direction is
// inferred per line from the ledger's own history (be/handover_import.decide_flow)
// and every line can be flipped by hand.
//
// The review step shows what needs a DECISION, not everything it is about to do.
// It used to lay every line and both parties out as equal cards and open a modal on
// top of the modal to settle a field, so a fifteen-line record was seventeen cards
// deep and the primary button read "Import (3 việc để lại sau)". Now the summary is
// one strip, the rows that are fine are folded away, and a conflict is settled in
// place.
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Spin, Steps, Tag, Tooltip } from "antd";
import { toast } from "react-toastify";
import {
  applyHandoverImport,
  planHandoverImport,
  readHandoverMinutes,
} from "../../api/imports";
import type {
  ApplyResult,
  Flow,
  HandoverPlan,
  ItemDecision,
  ItemPlan,
  ParsedMinutes,
  PlanIssue,
  UserDecision,
  UserPlan,
} from "../../api/imports";
import { ApiError } from "../../api/client";
import { fileToAttachment } from "../../lib/files";
import { fileToSheetText } from "../../lib/sheetText";
import { newId } from "../../lib/id";
import { conflictFields, describeIssue } from "../../lib/issues";
import { GHOST_USER_CODE, DEVICE_STATUS_META } from "../../types";
import { useT } from "../../i18n/useT";
import type { Key } from "../../i18n/catalog";
import { ChevronDownIcon, UploadIcon } from "../icons";
import { Modal } from "./Modal";
import { CodeChoiceField, ConflictFields } from "./ResolveConflictModal";
import type { Resolution } from "./ResolveConflictModal";

const SHEET_EXT = ["xlsx", "xls", "csv"];
const ACCEPT = ".xlsx,.xls,.csv,.pdf,image/*";

const FLOW_LABEL: Record<Flow, Key> = {
  return: "hi.flow.return",
  issue: "hi.flow.issue",
  transfer: "hi.flow.transfer",
};
const FLOW_COLOR: Record<Flow, string> = {
  return: "orange",
  issue: "green",
  transfer: "blue",
};

const show = (v: unknown) =>
  v === null || v === undefined || v === "" ? "—" : String(v);

/** A copy without one key. */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

/** Who a code belongs to, in words. `IT-STORE` is a ghost row, not a person. */
const personLabel = (code: string | null | undefined, store: string) =>
  !code ? "—" : code === GHOST_USER_CODE ? store : code;

/** A stable key per issue. `label` is in it because both parties can raise the
 * same kind with no code at all — keying on kind+item_id alone made settling one
 * silently settle the other, and the second was then never logged. */
const issueKey = (i: PlanIssue) =>
  `${i.kind}:${i.item_id ?? ""}:${i.payload.label ?? ""}`;

type Step = "pick" | "read" | "plan";

export function ImportHandoverModal({
  onClose,
  onDone,
  file,
  sourceText,
  embedded = false,
  queueLabel,
}: {
  onClose: () => void;
  onDone?: (result?: ApplyResult) => void;
  /** Pre-picked file (from the auto-detecting ImportModal) — skips the picker. */
  file?: File;
  /** Text already extracted while detecting the file's kind. Reusing it skips a
   * second OCR/extract round trip, which for a scanned record is most of the wait. */
  sourceText?: string;
  /** Rendered inside the queue modal rather than as its own dialog. */
  embedded?: boolean;
  /** e.g. "File 2/5" — shown next to the step bar when part of a bulk run. */
  queueLabel?: string;
}) {
  const { t } = useT();
  const store = t("hi.owner.store");
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("pick");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedMinutes | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showWarnings, setShowWarnings] = useState(false);
  const [plan, setPlan] = useState<HandoverPlan | null>(null);
  const [showClean, setShowClean] = useState(false);

  // Decisions layered over the plan.
  const [flowOverride, setFlowOverride] = useState<Record<string, Flow | "skip">>({});
  // Two maps per resource on purpose. `draft` is what the radio buttons are
  // showing; `fixes` is what will actually be written. The rows default to "take
  // from the record", so if the draft were applied directly, a conflict nobody
  // looked at would be resolved in the record' favour AND logged as a question —
  // the Notifications screen would then ask about a value it had already
  // overwritten. Only pressing Done promotes a draft into `fixes`.
  const [userDraft, setUserDraft] = useState<Record<string, Resolution>>({});
  const [deviceDraft, setDeviceDraft] = useState<Record<string, Resolution>>({});
  const [userFixes, setUserFixes] = useState<Record<string, Resolution>>({});
  const [deviceFixes, setDeviceFixes] = useState<Record<string, Resolution>>({});
  const [codeDraft, setCodeDraft] = useState<Record<string, string>>({});
  const [codeChoice, setCodeChoice] = useState<Record<string, string>>({});
  const [settled, setSettled] = useState<Set<string>>(new Set());

  const teams = useMemo(
    () =>
      Array.from(
        new Set(
          (plan?.users ?? [])
            .map((u) => u.current?.team)
            .concat((plan?.users ?? []).map((u) => u.team_suggestion))
            .filter((name): name is string => !!name),
        ),
      ),
    [plan],
  );

  const pick = async (picked: File, text?: string) => {
    setError(null);
    setFileName(picked.name);
    setBusy(t("hi.busy.read"));
    try {
      // Already extracted upstream? Send the text and skip the extract entirely.
      const ext = picked.name.split(".").pop()?.toLowerCase() ?? "";
      const source = text
        ? { sheet_text: text }
        : SHEET_EXT.includes(ext)
          ? { sheet_text: await fileToSheetText(picked) }
          : { attachment: await fileToAttachment(picked) };
      const result = await readHandoverMinutes(source);
      setParsed(result.parsed);
      setWarnings(result.warnings);
      setStep("read");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("hi.err.read"));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    // The file identity is the trigger; `pick` is recreated every render, so
    // depending on it would re-read the same file on every keystroke elsewhere.
    if (file) pick(file, sourceText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, sourceText]);

  const reconcile = async () => {
    if (!parsed) return;
    setError(null);
    setBusy(t("hi.busy.reconcile"));
    try {
      setPlan(await planHandoverImport(parsed, fileName));
      setStep("plan");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("hi.err.reconcile"));
    } finally {
      setBusy(null);
    }
  };

  const flowOf = (item: ItemPlan): Flow | "skip" =>
    flowOverride[item.serial] ?? item.flow;

  const toggleFlow = (item: ItemPlan) => {
    const now = flowOf(item);
    const next: Flow | "skip" =
      now === "return" ? "issue" : now === "issue" ? "return" : "transfer";
    setFlowOverride((f) => ({ ...f, [item.serial]: next }));
  };

  /** Effective employee code for a party, after a code-mismatch decision. */
  const codeOf = (user: UserPlan) =>
    (user.code && codeChoice[user.code]) || user.code;

  /** Codes the minutes named that the operator decided NOT to use. Nothing is
   * created under them, so an issue naming one would point at an employee code
   * with no record — which is exactly the dead row the Notifications screen used
   * to offer a "fix" for. */
  const abandonedCodes = useMemo(
    () =>
      new Set(
        Object.entries(codeChoice)
          .filter(([from, to]) => from !== to)
          .map(([from]) => from),
      ),
    [codeChoice],
  );

  const openIssues = (): PlanIssue[] => {
    if (!plan) return [];
    const all = [
      ...plan.users.flatMap((u) => u.issues),
      ...plan.items.flatMap((i) => i.issues),
    ];
    return all.filter(
      (i) =>
        !settled.has(issueKey(i)) &&
        !(i.resource === "users" && i.item_id && abandonedCodes.has(i.item_id)),
    );
  };

  /** Promote the draft into what will be written, and mark the issue answered. */
  const settleFields = (issue: PlanIssue) => {
    const id = issue.item_id ?? "";
    const isUser = issue.resource === "users";
    const draft = (isUser ? userDraft : deviceDraft)[id] ?? {};
    (isUser ? setUserFixes : setDeviceFixes)((f) => ({ ...f, [id]: draft }));
    setSettled((s) => new Set(s).add(issueKey(issue)));
  };

  const settleCode = (issue: PlanIssue) => {
    const from = issue.payload.code ?? "";
    setCodeChoice((c) => ({ ...c, [from]: codeDraft[from] ?? from }));
    setSettled((s) => new Set(s).add(issueKey(issue)));
  };

  const unsettleCode = (issue: PlanIssue) => {
    const from = issue.payload.code ?? "";
    setCodeChoice((c) => omit(c, from));
    setSettled((s) => {
      const next = new Set(s);
      next.delete(issueKey(issue));
      return next;
    });
  };

  /** Undo a settle, so a wrong choice does not have to be lived with. */
  const unsettle = (issue: PlanIssue) => {
    const id = issue.item_id ?? "";
    (issue.resource === "users" ? setUserFixes : setDeviceFixes)((f) => omit(f, id));
    setSettled((s) => {
      const next = new Set(s);
      next.delete(issueKey(issue));
      return next;
    });
  };

  const runImport = async () => {
    if (!plan) return;
    setError(null);
    setBusy(t("hi.busy.write"));
    try {
      const users: UserDecision[] = plan.users
        .filter((u) => u.code && u.action !== "skip")
        .map((u) => {
          const code = codeOf(u)!;
          // Picking an existing code means reusing that person, not writing the
          // minutes' values over them.
          const reusingAnother = code !== u.code;
          // `fills` only, plus whatever conflicts the operator ruled on. Sending
          // `proposed` wholesale used to overwrite a contradicting value with the
          // minutes' one AND log an issue asking which to keep — by the time
          // anyone read the issue the answer had already been applied. `fills`
          // already carries every value for a create, so nothing is lost.
          const fix = { ...u.fills, ...(userFixes[u.code!] ?? {}) };
          return {
            code,
            action: reusingAnother ? "reuse" : (u.action as UserDecision["action"]),
            name: reusingAnother ? undefined : fix.name,
            team: reusingAnother ? undefined : fix.team,
          };
        })
        // A "reuse" needs no write at all — drop it from the payload.
        .filter((u) => u.action === "create" || u.action === "update");

      const items: ItemDecision[] = plan.items.map((item) => ({
        serial: item.serial,
        flow: flowOf(item),
        handover_id: newId(),
        handover_date: plan.handover_date,
        reason: item.note || undefined,
        create_device: item.device_action === "create",
        device_fields: {
          ...item.device_fills,
          ...(deviceFixes[item.serial] ?? {}),
        },
      }));

      const partyA = plan.users[0];
      const partyB = plan.users[1];
      const result = await applyHandoverImport({
        source_file: fileName,
        handover_date: plan.handover_date,
        party_a_code: codeOf(partyA) ?? null,
        party_b_code: codeOf(partyB) ?? null,
        it_side: plan.it_side,
        users,
        items,
        issues: openIssues(),
      });
      if (!embedded) {
        toast.success(
          t(result.issues_logged ? "hi.toast.doneIssues" : "hi.toast.done", {
            handovers: result.handovers_created,
            devices: result.devices_created,
            users: result.users_created,
            issues: result.issues_logged,
          }),
        );
      }
      onDone?.(result);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("hi.err.import"));
    } finally {
      setBusy(null);
    }
  };

  // ---------------------------------------------------------------- rendering

  const issueBlock = (issue: PlanIssue) => {
    const done = settled.has(issueKey(issue));
    const fields = conflictFields(issue.payload);
    return (
      <div className={`import-issue${done ? " is-settled" : ""}`} key={issueKey(issue)}>
        <div className="import-issue-head">
          <span className="import-issue-text">{describeIssue(issue, t)}</span>
          {issue.kind === "user_code_mismatch" && done && (
            <>
              <Tag color="green">
                {t("hi.settled.code", {
                  code: codeChoice[issue.payload.code ?? ""] ?? "",
                })}
              </Tag>
              <Button size="small" type="link" onClick={() => unsettleCode(issue)}>
                {t("hi.action.redo")}
              </Button>
            </>
          )}
          {done && issue.kind !== "user_code_mismatch" && (
            <>
              <Tag color="green">{t("hi.settled")}</Tag>
              <Button size="small" type="link" onClick={() => unsettle(issue)}>
                {t("hi.action.redo")}
              </Button>
            </>
          )}
        </div>
        {/* Settled in place — no dialog stacked on the dialog. */}
        {issue.kind === "user_code_mismatch" && !done && (
          <>
            <CodeChoiceField
              issue={issue}
              value={codeDraft[issue.payload.code ?? ""]}
              onChange={(code) =>
                setCodeDraft((c) => ({ ...c, [issue.payload.code ?? ""]: code }))
              }
            />
            <div className="import-issue-confirm">
              <Button size="small" type="primary" onClick={() => settleCode(issue)}>
                {t("hi.action.done")}
              </Button>
            </div>
          </>
        )}
        {!!fields.length && !done && (
          <>
            <ConflictFields
              issue={issue}
              teams={teams}
              value={
                (issue.resource === "users" ? userDraft : deviceDraft)[
                  issue.item_id ?? ""
                ]
              }
              onChange={(resolution) => {
                const id = issue.item_id ?? "";
                (issue.resource === "users" ? setUserDraft : setDeviceDraft)((f) => ({
                  ...f,
                  [id]: resolution,
                }));
              }}
            />
            <div className="import-issue-confirm">
              <Button size="small" type="primary" onClick={() => settleFields(issue)}>
                {t("hi.action.done")}
              </Button>
              <span className="text-faint">
                {t("hi.issue.leftover")}
              </span>
            </div>
          </>
        )}
      </div>
    );
  };

  const itemCard = (item: ItemPlan) => {
    const flow = flowOf(item);
    const skipped = flow === "skip";
    const after = effectiveState(item, flow, plan!);
    return (
      <div
        className={`import-item-card${skipped ? " is-skipped" : ""}`}
        key={item.serial}
      >
        <div className="import-item-head">
          <span>
            <b>{t("hi.row.header", { no: show(item.no) })}</b> ·{" "}
            <code>{item.serial}</code>
          </span>
          {skipped ? (
            <Tag>{t("hi.row.skipped")}</Tag>
          ) : (
            <Tag color={FLOW_COLOR[flow]}>{t(FLOW_LABEL[flow])}</Tag>
          )}
          {item.ambiguous && !skipped && (
            <Tooltip title={t("hi.row.confirmTip")}>
              <Tag color="red">{t("hi.row.confirm")}</Tag>
            </Tooltip>
          )}
          <span className="import-item-actions">
            {plan?.it_side && (
              <Button size="small" onClick={() => toggleFlow(item)}>
                {t("hi.flow.flip")}
              </Button>
            )}
            <Button
              size="small"
              onClick={() =>
                setFlowOverride((f) => ({
                  ...f,
                  [item.serial]: skipped ? item.flow : "skip",
                }))
              }
            >
              {t(skipped ? "hi.flow.unskip" : "hi.flow.skip")}
            </Button>
          </span>
        </div>
        <div className="import-item-reason">{item.flow_reason}</div>
        {!skipped && (
          <div className="import-item-effect">
            {t("hi.row.effect", {
              from: personLabel(after.from, store),
              to: personLabel(after.to, store),
              owner: personLabel(after.owner, store),
              status: DEVICE_STATUS_META[after.status]?.label ?? after.status,
            })}
            {item.device_action === "create" && (
              <Tag color="purple" style={{ marginLeft: 8 }}>
                {t("hi.row.newDevice")}
              </Tag>
            )}
          </div>
        )}
        {item.issues.map(issueBlock)}
      </div>
    );
  };

  const pending = openIssues().length;
  const needsAttention = (plan?.items ?? []).filter(
    (i) => i.issues.length || i.ambiguous,
  );
  const clean = (plan?.items ?? []).filter(
    (i) => !i.issues.length && !i.ambiguous,
  );
  const userCards = (plan?.users ?? []).filter((u) => u.issues.length);

  const body = (
    <div className="modal-form">
      {step !== "pick" && (
        <div className="import-steps">
          <Steps
            size="small"
            current={step === "read" ? 0 : 1}
            items={[
              { title: t("hi.step.read") },
              { title: t("hi.step.reconcile") },
              { title: t("hi.step.write") },
            ]}
          />
          {queueLabel && <span className="text-faint">{queueLabel}</span>}
        </div>
      )}

      {busy && (
        <div className="import-busy">
          <Spin /> <span>{busy}</span>
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} />}

      {step === "pick" && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pick(f);
              e.target.value = "";
            }}
          />
          <div className="import-drop">
            <Button
              icon={<UploadIcon size={16} />}
              onClick={() => inputRef.current?.click()}
              disabled={!!busy}
            >
              {t("hi.pick.button")}
            </Button>
            <span className="import-hint">
              {fileName ?? t("hi.pick.hint")}
            </span>
          </div>
        </>
      )}

      {step === "read" && parsed && (
        <>
          {warnings.length > 0 && (
            // One line by default: a scanned record can drop a dozen cells, and a
            // dozen bullet points before anything useful reads like a failure.
            <Alert
              type="warning"
              showIcon
              message={
                <button
                  type="button"
                  className="import-warn-toggle"
                  onClick={() => setShowWarnings((v) => !v)}
                >
                  {t("hi.warn.toggle", { n: warnings.length })}
                  <ChevronDownIcon size={14} />
                </button>
              }
              description={
                showWarnings && (
                  <ul className="import-warnings">
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )
              }
            />
          )}
          <div className="import-read">
            <div className="import-read-head">
              <b>{t("hi.read.date")}</b> {show(parsed.handover_date)}
              <span className="text-faint"> · {show(parsed.place)}</span>
            </div>
            <div className="import-parties">
              <PartyCard
                label={t("hi.party.a")}
                party={parsed.party_a}
                detail={t("hi.party.detail", {
                  dept: show(parsed.party_a.dept),
                  position: show(parsed.party_a.position),
                })}
              />
              <PartyCard
                label={t("hi.party.b")}
                party={parsed.party_b}
                detail={t("hi.party.detail", {
                  dept: show(parsed.party_b.dept),
                  position: show(parsed.party_b.position),
                })}
              />
            </div>
            <table className="import-items">
              <thead>
                <tr>
                  <th>{t("hi.col.no")}</th>
                  <th>{t("hi.col.item")}</th>
                  <th>{t("hi.col.serial")}</th>
                  <th>{t("hi.col.detail")}</th>
                  <th>{t("hi.col.note")}</th>
                </tr>
              </thead>
              <tbody>
                {parsed.items.map((it) => (
                  <tr key={it.serial}>
                    <td>{show(it.no)}</td>
                    <td>{show(it.item)}</td>
                    <td>
                      <code>{it.serial}</code>
                    </td>
                    <td>{show(it.detail)}</td>
                    <td>{show(it.note)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="modal-actions">
            <Button onClick={() => (embedded ? onClose() : setStep("pick"))}>
              {t(embedded ? "hi.action.dropFile" : "hi.action.otherFile")}
            </Button>
            <Button
              type="primary"
              onClick={reconcile}
              disabled={!parsed.items.length || !!busy}
            >
              {t("hi.action.reconcile")}
            </Button>
          </div>
        </>
      )}

      {step === "plan" && plan && (
        <>
          <div className="import-summary-strip">
            <Stat
              n={plan.items.filter((i) => flowOf(i) !== "skip").length}
              label={t("hi.stat.handovers")}
            />
            <Stat
              n={plan.items.filter((i) => i.device_action === "create").length}
              label={t("hi.stat.newDevices")}
            />
            <Stat
              n={plan.users.filter((u) => u.action === "create").length}
              label={t("hi.stat.newPeople")}
            />
            <Stat
              n={pending}
              label={t("hi.stat.decisions")}
              tone={pending ? "warn" : "ok"}
            />
          </div>

          <div className="import-it-line">
            {t(plan.it_side ? "hi.it.knownSide" : "hi.it.unknownSide", {
              reason: plan.it_reason,
            })}
          </div>

          {userCards.map((user) => (
            <div className="import-item-card" key={user.label}>
              <div className="import-item-head">
                <span>
                  <b>{user.label}</b> · <code>{show(codeOf(user))}</code>{" "}
                  {show(user.proposed.name)}
                </span>
                <Tag color={user.action === "create" ? "purple" : "gold"}>
                  {t(user.action === "create" ? "hi.user.create" : "hi.user.update")}
                </Tag>
              </div>
              {user.issues.map(issueBlock)}
            </div>
          ))}

          {needsAttention.map(itemCard)}

          {clean.length > 0 && (
            <>
              <button
                type="button"
                className="import-fold"
                onClick={() => setShowClean((v) => !v)}
              >
                <ChevronDownIcon size={14} />
                {t(showClean ? "hi.fold.hide" : "hi.fold.show", { n: clean.length })}
              </button>
              {showClean && clean.map(itemCard)}
            </>
          )}

          {!needsAttention.length && !userCards.length && (
            <Alert
              type="success"
              showIcon
              message={t("hi.nothingToDecide")}
            />
          )}

          <div className="modal-actions import-plan-actions">
            <Button onClick={() => setStep("read")}>{t("hi.action.back")}</Button>
            <div className="import-plan-go">
              {pending > 0 && (
                <span className="text-faint">
                  {t("hi.pending", { n: pending })}
                </span>
              )}
              <Button type="primary" onClick={runImport} disabled={!!busy}>
                {t("hi.action.import")}
              </Button>
            </div>
          </div>
        </>
      )}

    </div>
  );

  if (embedded) return body;
  return (
    <Modal title={t("hi.title")} onClose={onClose} width={860}>
      {body}
    </Modal>
  );
}

function Stat({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone?: "warn" | "ok";
}) {
  return (
    <div className={`import-stat${tone ? ` is-${tone}` : ""}`}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}

function PartyCard({
  label,
  party,
  detail,
}: {
  label: string;
  detail: string;
  party: ParsedMinutes["party_a"];
}) {
  return (
    <div className="import-party">
      <div className="import-party-label">{label}</div>
      <div>
        <b>{show(party.name)}</b> · <code>{show(party.code)}</code>
      </div>
      <div className="text-faint">
        {detail}
      </div>
    </div>
  );
}

// The plan already carries from/to for its own guess; flipping the flow in the UI
// has to derive them the same way the server would (handover_import.apply_flow).
function effectiveState(item: ItemPlan, flow: Flow | "skip", plan: HandoverPlan) {
  if (flow === item.flow) {
    return {
      from: item.from_user_id,
      to: item.to_user_id,
      owner: item.device_owner_after,
      status: item.device_status_after,
    };
  }
  const back = flow === "return";
  return {
    from: back ? plan.user_code : plan.it_code,
    to: back ? plan.it_code : plan.user_code,
    owner: back ? GHOST_USER_CODE : plan.user_code,
    status: (back ? "in_stock" : "active") as ItemPlan["device_status_after"],
  };
}
