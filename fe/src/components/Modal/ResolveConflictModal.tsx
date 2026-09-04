// The "which value do we keep?" dialog.
//
// Used from two places with the same shape: the import wizard, when the minutes
// disagree with the ledger, and the Notifications screen, when someone works
// through a disagreement that was left open. Every row is a choice — the importer
// never picks a side on its own.
import { useEffect, useMemo, useState } from "react";
import { Button, Radio, Select, Input, Alert, Tag } from "antd";
import type { FieldConflict, PlanIssue } from "../../api/imports";
import { conflictFields, fieldLabel } from "../../lib/issues";
import { useT } from "../../i18n/useT";
import { Modal } from "./Modal";

export type Choice = "keep" | "take" | "manual";

// What the caller gets back: the value to write per field, or null to leave it.
export type Resolution = Record<string, string | null>;

const show = (v: string | null | undefined) =>
  v == null || v === "" ? "—" : v;

/** Turn per-field choices into the values to write, dropping "keep". */
function resolutionFrom(
  fields: FieldConflict[],
  choices: Record<string, Choice>,
  manual: Record<string, string>,
): Resolution {
  const out: Resolution = {};
  for (const f of fields) {
    const choice = choices[f.field];
    const value =
      choice === "keep"
        ? null
        : choice === "manual"
          ? manual[f.field]?.trim() || null
          : f.proposed;
    if (value !== null) out[f.field] = value;
  }
  return out;
}

/**
 * The rows of the choice. Rendered inline inside the import wizard's item card and
 * inside the Notifications dialog — the wizard used to stack an antd Modal on top
 * of an antd Modal to ask this, which is a lot of ceremony for three radio buttons.
 */
export function ConflictFields({
  issue,
  teams = [],
  value,
  onChange,
}: {
  issue: PlanIssue;
  teams?: string[];
  /** Controlled: the resolution so far. */
  value: Resolution | undefined;
  onChange: (resolution: Resolution) => void;
}) {
  const { t } = useT();
  const fields = useMemo(() => conflictFields(issue.payload), [issue]);
  const suggestion = issue.payload.team_suggestion ?? null;

  // Default: take the minutes' value, except for a team that already has an
  // established spelling — there, offer the spelling in use as a manual value.
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.field,
        f.field === "team" && suggestion && suggestion !== f.proposed
          ? "manual"
          : "take",
      ]),
    ),
  );
  const [manual, setManual] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.field,
        (f.field === "team" ? suggestion : null) ?? f.proposed ?? "",
      ]),
    ),
  );

  const emit = (
    nextChoices: Record<string, Choice>,
    nextManual: Record<string, string>,
  ) => onChange(resolutionFrom(fields, nextChoices, nextManual));

  const setChoice = (field: string, choice: Choice) => {
    const next = { ...choices, [field]: choice };
    setChoices(next);
    emit(next, manual);
  };
  const setManualValue = (field: string, v: string) => {
    const next = { ...manual, [field]: v };
    setManual(next);
    emit(choices, next);
  };

  // The parent holds the resolution, so hand it the defaults once on mount —
  // otherwise Apply without touching a radio would write nothing.
  const empty = value === undefined;
  useEffect(() => {
    if (fields.length && empty) emit(choices, manual);
    // Defaults only, and only while the parent still has nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, empty]);

  if (!fields.length) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t("conflict.none")}
      />
    );
  }

  return (
    <div className="conflict-rows">
      {fields.map((f) => (
        <div className="conflict-row" key={f.field}>
          <div className="conflict-field">{fieldLabel(f.field, t)}</div>
          <Radio.Group
            value={choices[f.field]}
            onChange={(e) => setChoice(f.field, e.target.value)}
          >
            <Radio value="keep">{t("conflict.keep", { value: show(f.current) })}</Radio>
            <Radio value="take">{t("conflict.take", { value: show(f.proposed) })}</Radio>
            <Radio value="manual">{t("conflict.manual")}</Radio>
          </Radio.Group>
          {choices[f.field] === "manual" && (
            <div className="conflict-manual">
              {f.field === "team" && teams.length ? (
                <Select
                  showSearch
                  allowClear
                  style={{ width: 260 }}
                  placeholder={t("conflict.pickTeam")}
                  value={manual[f.field] || undefined}
                  options={teams.map((name) => ({ value: name, label: name }))}
                  onChange={(v) => setManualValue(f.field, v ?? "")}
                />
              ) : (
                <Input
                  style={{ width: 260 }}
                  value={manual[f.field] ?? ""}
                  onChange={(e) => setManualValue(f.field, e.target.value)}
                />
              )}
              {f.field === "team" && suggestion && (
                <span className="text-faint">
                  {t("conflict.teamInUse")} <Tag>{suggestion}</Tag>
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

type Props = {
  title: string;
  issue: PlanIssue;
  /** Team names already in use, so a new spelling isn't started by accident. */
  teams?: string[];
  onClose: () => void;
  onResolve: (resolution: Resolution) => void;
};

export function ResolveConflictModal({
  title,
  issue,
  teams = [],
  onClose,
  onResolve,
}: Props) {
  const { t } = useT();
  const fields = useMemo(() => conflictFields(issue.payload), [issue]);
  const [resolution, setResolution] = useState<Resolution | undefined>();

  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-form">
        {issue.kind === "device_field_conflict" && (
          <Alert
            type="info"
            showIcon
            message={t("conflict.specNote")}
          />
        )}

        <ConflictFields
          issue={issue}
          teams={teams}
          value={resolution}
          onChange={setResolution}
        />

        <div className="modal-actions">
          <Button onClick={onClose}>{t("conflict.cancel")}</Button>
          <Button
            type="primary"
            onClick={() => onResolve(resolution ?? {})}
            disabled={!fields.length}
          >
            {t("conflict.apply")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The code-mismatch choice: which employee code this record should use. A
 * record-level decision, not a field one — the same person appears to exist under
 * a code that differs from the minutes' by a character or two. Merging is
 * deliberately not offered: devices and handovers both point at a code, so a
 * merge is its own job with its own review.
 */
export function CodeChoiceField({
  issue,
  value,
  onChange,
}: {
  issue: PlanIssue;
  value: string | undefined;
  onChange: (code: string) => void;
}) {
  const { t } = useT();
  const proposed = issue.payload.code ?? "";
  const candidates = issue.payload.candidates ?? [];
  return (
    <Radio.Group
      value={value ?? proposed}
      onChange={(e) => onChange(e.target.value)}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <Radio value={proposed}>
        {t("conflict.code.keep", { code: proposed })}
      </Radio>
      {candidates.map((c) => (
        <Radio key={c.employee_code} value={c.employee_code}>
          {t("conflict.code.use", { code: c.employee_code })}
          <span className="text-faint">
            {" "}
            — {show(c.name)} · {show(c.team)}
          </span>
        </Radio>
      ))}
    </Radio.Group>
  );
}

/** The same choice as its own dialog, for the Notifications screen — there it is
 * opened deliberately from a table row, so a modal is the right shape. */
export function ResolveCodeMismatchModal({
  issue,
  onClose,
  onChoose,
}: {
  issue: PlanIssue;
  onClose: () => void;
  onChoose: (useCode: string) => void;
}) {
  const { t } = useT();
  const [picked, setPicked] = useState(issue.payload.code ?? "");

  return (
    <Modal title={t("conflict.code.title")} onClose={onClose}>
      <div className="modal-form">
        <Alert
          type="warning"
          showIcon
          message={t("conflict.code.message", { name: issue.payload.name ?? "?" })}
          description={t("conflict.code.description")}
        />
        <CodeChoiceField issue={issue} value={picked} onChange={setPicked} />
        <div className="modal-actions">
          <Button onClick={onClose}>{t("conflict.cancel")}</Button>
          <Button type="primary" onClick={() => onChoose(picked)}>
            {t("conflict.code.choose")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
