// Import a handover record (biên bản bàn giao) — read it, reconcile it, apply it.
//
// Three steps, and nothing is written until the last one. The middle step is the
// point of the whole screen: for every movement it shows which way the machine is
// going and WHY, because the record itself often cannot say. A record is N parties
// and M movements — one record hands a new machine out and takes an old one back in
// the same table, plenty only hand one out, and a three-party record moves each row
// between a different pair. So direction is resolved per movement from ranked
// evidence (be/handover_direction.py) and every row can be corrected by hand: two
// parties get a flip button, three or more get From/To pickers.
//
// The review step shows what needs a DECISION, not everything it is about to do.
// It used to lay every line and both parties out as equal cards and open a modal on
// top of the modal to settle a field, so a fifteen-line record was seventeen cards
// deep and the primary button read "Import (3 việc để lại sau)". Now the summary is
// one strip, the rows that are fine are folded away, and a conflict is settled in
// place.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Button, Progress, Select, Spin, Steps, Tag, Tooltip } from "antd";
import { toast } from "react-toastify";
import {
  applyHandoverImport,
  planHandoverImport,
  readHandoverMinutesStreaming,
} from "../../api/imports";
import type {
  ApplyResult,
  DirectionSource,
  Flow,
  HandoverPlan,
  ItemDecision,
  ItemPlan,
  ParsedMinutes,
  PlanIssue,
  ReadProgress,
  ReadResult,
  UserDecision,
  UserPlan,
} from "../../api/imports";
import { ApiError } from "../../api/client";
import { fileToAttachment } from "../../lib/files";
import { fileToSheetText } from "../../lib/sheetText";
import { newId } from "../../lib/id";
import { conflictFields, describeIssue } from "../../lib/issues";
import { GHOST_USER_CODE } from "../../types";
import { useT } from "../../i18n/useT";
import type { Key } from "../../i18n/catalog";
import { ChevronDownIcon, UploadIcon } from "../icons";
import { Modal } from "./Modal";
import { CodeChoiceField, ConflictFields } from "./ResolveConflictModal";
import type { Resolution } from "./ResolveConflictModal";

const SHEET_EXT = ["xlsx", "xls", "csv"];
const ACCEPT = ".xlsx,.xls,.csv,.pdf,image/*";

// The caption sitting on the arrow between giver and receiver.
const FLOW_LABEL: Record<Flow, Key> = {
  return: "hi.flow.return",
  issue: "hi.flow.issue",
  transfer: "hi.flow.transfer",
};

// Where the direction came from, as a short badge. The full sentence the resolver
// wrote lives in the tooltip — fifteen rows of prose is not a review screen.
const SOURCE_LABEL: Record<DirectionSource, Key> = {
  recorded: "hi.src.recorded",
  note: "hi.src.note",
  transfer: "hi.src.transfer",
  holder: "hi.src.holder",
  owner: "hi.src.owner",
  it: "hi.src.it",
  unknown: "hi.src.unknown",
};

const show = (v: unknown) =>
  v === null || v === undefined || v === "" ? "—" : String(v);

/** A copy without one key. */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

/** A stable key per issue. `label` is in it because both parties can raise the
 * same kind with no code at all — keying on kind+item_id alone made settling one
 * silently settle the other, and the second was then never logged. `row` is in it
 * for the same reason on the item side: one record can move a device twice, and
 * both movements name the same serial. */
const issueKey = (i: PlanIssue) =>
  `${i.kind}:${i.item_id ?? ""}:${i.payload.label ?? ""}:${i.payload.row ?? ""}`;

/** A movement's identity. Its row, never its serial — see MinutesItem.row. */
const rowKey = (i: { row: number; serial: string }) => `${i.row}:${i.serial}`;

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
  // Where the read has got to, straight from the server. Null between reads.
  const [progress, setProgress] = useState<ReadProgress | null>(null);
  // Which reader answered — the plain-code form parser or the model.
  const [reader, setReader] = useState<ReadResult["reader"] | null>(null);

  // Decisions layered over the plan.
  const [flowOverride, setFlowOverride] = useState<Record<string, Flow | "skip">>({});
  // Who gave and who received, when the operator names them outright. Only three
  // or more parties need this — with two, naming the flow still pins the pair down.
  const [pairOverride, setPairOverride] = useState<
    Record<string, { from: string | null; to: string | null }>
  >({});
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
          (plan?.parties ?? [])
            .map((u) => u.current?.team)
            .concat((plan?.parties ?? []).map((u) => u.team_suggestion))
            .filter((name): name is string => !!name),
        ),
      ),
    [plan],
  );

  const pick = async (picked: File, text?: string) => {
    setError(null);
    setFileName(picked.name);
    setBusy(t("hi.busy.read"));
    setProgress(null);
    try {
      // Already extracted upstream? Send the text and skip the extract entirely.
      const ext = picked.name.split(".").pop()?.toLowerCase() ?? "";
      const source = text
        ? { sheet_text: text }
        : SHEET_EXT.includes(ext)
          ? { sheet_text: await fileToSheetText(picked) }
          : { attachment: await fileToAttachment(picked) };
      const result = await readHandoverMinutesStreaming(source, setProgress);
      setParsed(result.parsed);
      setWarnings(result.warnings);
      setReader(result.reader);
      setStep("read");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("hi.err.read"));
    } finally {
      setBusy(null);
      setProgress(null);
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
    flowOverride[rowKey(item)] ?? item.flow;

  const toggleFlow = (item: ItemPlan) => {
    const now = flowOf(item);
    const next: Flow | "skip" =
      now === "return" ? "issue" : now === "issue" ? "return" : "transfer";
    setFlowOverride((f) => ({ ...f, [rowKey(item)]: next }));
  };

  /** Three or more parties: "the flow" no longer says who is at each end. */
  const manyParties = (plan?.parties.length ?? 0) > 2;

  const setPair = (item: ItemPlan, side: "from" | "to", code: string | null) =>
    setPairOverride((p) => {
      const now = p[rowKey(item)] ?? {
        from: item.from_user_id,
        to: item.to_user_id,
      };
      return { ...p, [rowKey(item)]: { ...now, [side]: code } };
    });

  /** Effective employee code for a party, after a code-mismatch decision. */
  const codeOf = (user: UserPlan) =>
    (user.code && codeChoice[user.code]) || user.code;

  /** The IT side, and — only meaningful with two parties — the other one. Both
   * read through `codeOf`, so a code the operator remapped stays remapped. */
  const itCode =
    plan && plan.it_index !== null
      ? (codeOf(plan.parties[plan.it_index]) ?? null)
      : null;
  const otherCode =
    (plan?.parties ?? []).map(codeOf).find((c) => c && c !== itCode) ?? null;

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
      ...plan.parties.flatMap((u) => u.issues),
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
      const users: UserDecision[] = plan.parties
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

      // Every movement carries its own pair. The record-level pair is gone: it is
      // what wrote all of a three-party record between the same two people.
      const items: ItemDecision[] = plan.items.map((item) => {
        const flow = flowOf(item);
        const after = effectiveState(
          item, flow, pairOverride[rowKey(item)], itCode, otherCode,
        );
        return {
          row: item.row,
          serial: item.serial,
          flow,
          from_user_id: flow === "skip" ? undefined : after.from,
          to_user_id: flow === "skip" ? undefined : after.to,
          handover_id: newId(),
          handover_date: plan.handover_date,
          reason: item.note || undefined,
          create_device: item.device_action === "create",
          device_fields: {
            ...item.device_fills,
            ...(deviceFixes[item.serial] ?? {}),
          },
        };
      });

      const result = await applyHandoverImport({
        source_file: fileName,
        handover_date: plan.handover_date,
        party_codes: plan.parties.map((p) => codeOf(p) ?? null),
        it_code: itCode,
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

  /** Code → the person behind it. The plan already carries everyone's name; the
   * review used to show bare employee codes anyway, which reads as a foreign
   * language to a manager and as a lookup task to everyone else. */
  const peopleByCode = useMemo(() => {
    const map = new Map<string, { label: string; name: string; isIt: boolean }>();
    (plan?.parties ?? []).forEach((p, i) => {
      const code = (p.code && codeChoice[p.code]) || p.code;
      if (!code) return;
      map.set(code, {
        label: p.label,
        name: p.current?.name ?? p.proposed.name ?? code,
        isIt: plan?.it_index === i,
      });
    });
    return map;
  }, [plan, codeChoice]);

  /** Every party, as options for the From/To pickers — by name, not by code. */
  const partyOptions = (plan?.parties ?? [])
    .map((p) => ({ party: p, code: codeOf(p) }))
    .filter((o): o is { party: UserPlan; code: string } => !!o.code)
    .map((o) => ({
      value: o.code,
      label: peopleByCode.get(o.code)?.name ?? o.code,
    }));

  /** One end of a movement: who they are on top, what they are underneath. */
  const personNode = (
    item: ItemPlan,
    side: "from" | "to",
    code: string | null,
    editable: boolean,
  ) => {
    const person = code ? peopleByCode.get(code) : undefined;
    // Someone outside the record — a device standing in a third party's name —
    // has no name to show, so the code IS the name and the sub-line stays empty
    // rather than printing it twice.
    const sub = person
      ? [code, t("hi.party.label", { letter: person.label })]
          .concat(person.isIt ? [t("hi.cast.it")] : [])
          .join(" · ")
      : "";
    return (
      <div className={`import-node${code ? "" : " is-empty"}`}>
        <div className="import-node-label">
          {t(side === "from" ? "hi.dir.from" : "hi.dir.to")}
        </div>
        {editable ? (
          <Select
            size="small"
            variant="borderless"
            className="import-node-pick"
            options={partyOptions}
            value={code ?? undefined}
            placeholder={t("hi.dir.pick")}
            onChange={(v) => setPair(item, side, v ?? null)}
            popupMatchSelectWidth={false}
          />
        ) : (
          <div className="import-node-name">
            {code === GHOST_USER_CODE ? store : (person?.name ?? show(code))}
          </div>
        )}
        {sub && <div className="import-node-sub">{sub}</div>}
      </div>
    );
  };

  /** One movement: what moved, and — the point of the whole screen — which way.
   *
   * The direction is a drawn edge rather than a sentence. It used to be a line of
   * 12px muted text under everything else, which put the one thing a reviewer is
   * here to check at the bottom of the visual order. */
  const itemCard = (item: ItemPlan) => {
    const flow = flowOf(item);
    const skipped = flow === "skip";
    const override = pairOverride[rowKey(item)];
    const after = effectiveState(item, flow, override, itCode, otherCode);
    const needs = !!item.issues.length || item.ambiguous;
    const title =
      item.proposed_device?.name ?? item.current_device?.name ?? item.detail;
    // A machine handed back to IT parks in the store rather than on the person who
    // signed for it — the one consequence the edge itself does not show.
    const toStore =
      !skipped && after.owner === GHOST_USER_CODE && after.to !== GHOST_USER_CODE;
    return (
      <div
        className={`import-move${needs ? " needs" : ""}${skipped ? " is-skipped" : ""}`}
        key={rowKey(item)}
      >
        <div className="import-move-no" title={t("hi.row.header", { no: show(item.no) })}>
          {show(item.no ?? item.row)}
        </div>
        <div className="import-move-body">
          <div className="import-move-top">
            {title && <span className="import-move-name">{title}</span>}
            <code className="import-move-sn">{item.serial}</code>
            {!skipped && (
              <Tooltip title={item.flow_reason}>
                <span className={`import-prov${item.confident ? "" : " is-ask"}`}>
                  {t(SOURCE_LABEL[item.direction_source] ?? "hi.src.unknown")}
                </span>
              </Tooltip>
            )}
            {skipped && <Tag>{t("hi.row.skipped")}</Tag>}
            <span className="import-move-acts">
              {!manyParties && !skipped && plan?.it_index !== null && (
                <Button size="small" type="text" onClick={() => toggleFlow(item)}>
                  {t("hi.flow.flip")}
                </Button>
              )}
              <Button
                size="small"
                type="text"
                onClick={() =>
                  setFlowOverride((f) => ({
                    ...f,
                    [rowKey(item)]: skipped ? item.flow : "skip",
                  }))
                }
              >
                {t(skipped ? "hi.flow.unskip" : "hi.flow.skip")}
              </Button>
            </span>
          </div>

          {!skipped && (
            <div className="import-edge">
              {personNode(item, "from", after.from, manyParties)}
              <div className={`import-arrow is-${flow}`}>
                <span className="import-arrow-cap">{t(FLOW_LABEL[flow])}</span>
                <span className="import-arrow-bar" />
              </div>
              {personNode(item, "to", after.to, manyParties)}
            </div>
          )}

          {!skipped && (item.device_action === "create" || toStore) && (
            <div className="import-move-note">
              {item.device_action === "create" && (
                <span className="import-chip-new">{t("hi.row.newDevice")}</span>
              )}
              {toStore && <span>{t("hi.row.toStore", { store })}</span>}
            </div>
          )}

          {item.issues.map(issueBlock)}
        </div>
      </div>
    );
  };

  const pending = openIssues().length;
  const writeCount = (plan?.items ?? []).filter((i) => flowOf(i) !== "skip").length;
  const newDeviceCount = (plan?.items ?? []).filter(
    (i) => i.device_action === "create",
  ).length;
  const newPeopleCount = (plan?.parties ?? []).filter(
    (u) => u.action === "create",
  ).length;
  const needsAttention = (plan?.items ?? []).filter(
    (i) => i.issues.length || i.ambiguous,
  );
  const clean = (plan?.items ?? []).filter(
    (i) => !i.issues.length && !i.ambiguous,
  );
  const userCards = (plan?.parties ?? []).filter((u) => u.issues.length);

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

      {busy && <ReadProgressBar progress={progress} fallback={busy} />}
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
              {/* Which reader answered. Worth one tag: a form parsed in plain code
                  and a form read by an 8B model do not deserve the same trust, and
                  the fast one is the one that needs saying — otherwise an import
                  that took a second reads as an import that did not happen. */}
              {reader && (
                <Tooltip title={t(`hi.reader.${reader}.why` as Key)}>
                  <Tag color={reader === "sheet" ? "green" : "purple"}>
                    {t(`hi.reader.${reader}` as Key)}
                  </Tag>
                </Tooltip>
              )}
            </div>
            <div className="import-parties">
              {parsed.parties.map((party, i) => (
                <PartyCard
                  key={`${party.label}-${i}`}
                  label={t("hi.party.label", { letter: party.label })}
                  party={party}
                  detail={t("hi.party.detail", {
                    dept: show(party.dept),
                    position: show(party.position),
                  })}
                />
              ))}
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
                  <tr key={rowKey(it)}>
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
          {/* Who is in this record — all of them, always. This used to render only
              the parties that had a disagreement, so a three-party record showed
              two people and silently omitted the third. */}
          <div className="import-cast">
            {plan.parties.map((party, i) => {
              const code = codeOf(party);
              const isIt = plan.it_index === i;
              const chip = (
                <span
                  className={`import-who${isIt ? " is-it" : ""}`}
                  key={`${party.label}-${i}`}
                >
                  <span className="import-who-av">{party.label}</span>
                  <span className="import-who-name">
                    {party.current?.name ?? show(party.proposed.name)}
                  </span>
                  <span className="import-who-code">
                    {show(code)}
                    {isIt ? ` · ${t("hi.cast.it")}` : ""}
                  </span>
                  {party.action === "create" && (
                    <span className="import-who-new">{t("hi.cast.new")}</span>
                  )}
                </span>
              );
              return isIt ? (
                <Tooltip title={plan.it_reason} key={`${party.label}-${i}`}>
                  {chip}
                </Tooltip>
              ) : (
                chip
              );
            })}
          </div>

          {plan.it_index === null && (
            <Alert type="info" showIcon message={t("hi.it.unknownSide", {
              reason: plan.it_reason,
            })} />
          )}

          {/* One number leads. The other three counts are consequences, not
              decisions, and four equal tiles flattened the only one that mattered. */}
          <div className={`import-verdict${pending ? "" : " is-clear"}`}>
            <span className="import-verdict-n">{pending || writeCount}</span>
            <span className="import-verdict-text">
              <b>{t(pending ? "hi.stat.decisions" : "hi.verdict.ready")}</b>
              <span className="import-verdict-sub">
                {[
                  `${writeCount} ${t("hi.stat.handovers")}`,
                  `${newDeviceCount} ${t("hi.stat.newDevices")}`,
                  `${newPeopleCount} ${t("hi.stat.newPeople")}`,
                ].join(" · ")}
              </span>
            </span>
          </div>

          {userCards.map((user) => (
            <div className="import-ask" key={user.label}>
              <div className="import-ask-who">
                <b>{user.label}</b> · {show(user.proposed.name)}{" "}
                <code>{show(codeOf(user))}</code>
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
              {/* The button says what pressing it does, not what screen it is on. */}
              <Button type="primary" onClick={runImport} disabled={!!busy}>
                {writeCount
                  ? t("hi.action.importN", { n: writeCount })
                  : t("hi.action.import")}
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

/** How far along each phase is, and what to call it.
 *
 * The numbers are a claim about how the wait is actually spent, not decoration.
 * `reading` owns the widest band because it is the only phase whose progress is
 * COUNTED — the file's own table says how many rows there are, and the server
 * reports each one as the model finishes it. The rest are milestones: they step the
 * bar when they are reached and never creep between events, because a bar that
 * moves on a timer is telling the user something nobody measured. */
const READ_PHASE: Record<
  Exclude<ReadProgress["phase"], "done" | "error">,
  { key: Key; at: number }
> = {
  extract: { key: "hi.read.extracting", at: 8 },
  scanning: { key: "hi.read.scanning", at: 20 },
  loading: { key: "hi.read.loadingModel", at: 26 },
  reading: { key: "hi.read.reading", at: 30 },
  verifying: { key: "hi.read.verifying", at: 96 },
};

/** A ticking seconds count, rendered by `render`.
 *
 * Only the model-loading phase uses it: that phase produces no output for the
 * better part of a minute, so the one honest thing to show is how long it has been
 * at it. Mount it with a `key` per phase — the count then resets by remounting,
 * rather than by writing state inside an effect. */
function Elapsed({ render }: { render: (seconds: number) => string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <>{render(seconds)}</>;
}

/** The read step's wait, made legible.
 *
 * This replaced a spinner and a sentence, which is fine for the ~1s a spreadsheet
 * now takes and a lie for the rest: a scanned record is OCR'd for tens of seconds
 * and a cold model spends ~44s loading before it writes one character. Nothing here
 * is inferred — every number came from the server. */
function ReadProgressBar({
  progress,
  fallback,
}: {
  progress: ReadProgress | null;
  fallback: string;
}) {
  const { t } = useT();
  const phase = progress && progress.phase !== "done" && progress.phase !== "error"
    ? progress
    : null;

  if (!phase) {
    return (
      <div className="import-busy">
        <Spin /> <span>{fallback}</span>
      </div>
    );
  }

  const step = READ_PHASE[phase.phase];
  const total = "total" in phase ? phase.total : 0;
  const read = phase.phase === "reading" ? phase.items : 0;
  // A counted phase earns a real fraction. Without a total — a file whose table
  // could not be located — the rows read are still shown, but as a count, and the
  // bar advances a notch per row rather than pretending to know the end.
  const percent =
    phase.phase === "reading"
      ? total > 0
        ? step.at + Math.round((66 * Math.min(read, total)) / total)
        : Math.min(90, step.at + read * 4)
      : step.at;

  const detail: ReactNode =
    phase.phase === "reading" && total > 0
      ? t("hi.read.rows", { read: Math.min(read, total), total })
      : phase.phase === "reading"
        ? t("hi.read.rowsUnknown", { read })
        : phase.phase === "extract"
          ? phase.name
          : phase.phase === "loading"
            ? (
                <Elapsed
                  key={phase.phase}
                  render={(seconds) => t("hi.read.loadingHint", { seconds })}
                />
              )
            : total > 0
              ? t("hi.read.rowsFound", { total })
              : "";

  return (
    <div className="import-progress">
      <div className="import-progress-head">
        <span className="import-progress-label">{t(step.key)}</span>
        {detail && <span className="import-progress-detail">{detail}</span>}
      </div>
      <Progress
        percent={percent}
        showInfo={false}
        // "active" is the shimmer, and it is on for exactly the phases whose
        // remaining time is genuinely unknown. A counted read gets a still bar,
        // because the number beside it is the real answer.
        status={phase.phase === "reading" && total > 0 ? "normal" : "active"}
        strokeColor="var(--accent)"
      />
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
  party: ParsedMinutes["parties"][number];
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

// What this movement will actually write. Three cases, in order: the operator
// named the pair outright (three or more parties), they flipped the flow (two
// parties — where naming the flow still pins the pair down), or the plan's own
// resolution stands. A flip has to derive from/to the way the server would.
function effectiveState(
  item: ItemPlan,
  flow: Flow | "skip",
  override: { from: string | null; to: string | null } | undefined,
  itCode: string | null,
  otherCode: string | null,
) {
  if (override) {
    // Handed back to IT means the store, not the person who signed for it.
    const owner =
      override.to && override.to === itCode ? GHOST_USER_CODE : override.to;
    return {
      from: override.from,
      to: override.to,
      owner,
      status: (owner && owner !== GHOST_USER_CODE
        ? "active"
        : "in_stock") as ItemPlan["device_status_after"],
    };
  }
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
    from: back ? otherCode : itCode,
    to: back ? itCode : otherCode,
    owner: back ? GHOST_USER_CODE : otherCode,
    status: (back ? "in_stock" : "active") as ItemPlan["device_status_after"],
  };
}
