// Vocabulary for import issues, shared by the import wizard and the Notifications
// screen.
//
// These two used to describe the same row differently: the wizard had a proper
// sentence per kind, the Notifications screen had a thinner `summarise` that read
// `payload.fields` as an array. `user_created` writes it as an OBJECT, so those
// rows rendered as a bare employee code and a dash — a notification pointing at a
// VPHN with nothing to say and nothing to do. One vocabulary, one shape check.
//
// The label maps hold catalog KEYS rather than text: this is a plain module, so it
// cannot call the translation hook, and whoever renders resolves them instead.
import type { FieldConflict, ImportIssue, IssueKind, PlanIssue } from "../api/imports";
import type { Key } from "../i18n/catalog";
import type { Vars } from "../i18n/useT";

type Tr = (key: Key, vars?: Vars) => string;

export const KIND_META: Record<IssueKind, { label: Key; color: string }> = {
  user_created: { label: "issue.kind.user_created", color: "purple" },
  user_code_mismatch: { label: "issue.kind.user_code_mismatch", color: "red" },
  user_field_conflict: { label: "issue.kind.user_field_conflict", color: "gold" },
  device_created_incomplete: {
    label: "issue.kind.device_created_incomplete",
    color: "purple",
  },
  device_field_conflict: { label: "issue.kind.device_field_conflict", color: "gold" },
  device_owner_mismatch: { label: "issue.kind.device_owner_mismatch", color: "red" },
  handover_duplicate: { label: "issue.kind.handover_duplicate", color: "blue" },
  flow_ambiguous: { label: "issue.kind.flow_ambiguous", color: "red" },
};

const FIELD_KEYS: Record<string, Key> = {
  name: "field.name",
  team: "field.team",
  status: "field.status",
  type: "field.type",
  brand: "field.brand",
  cpu: "field.cpu",
  ram: "field.ram",
  storage: "field.storage",
  serial_number: "field.serial_number",
  barcode: "field.barcode",
  buy_date: "field.buy_date",
  os: "field.os",
  msoffice: "field.msoffice",
};

/** Column name for a person to read. Unknown columns fall through as-is rather
 * than being hidden — a missing label should look wrong, not look fine. */
export const fieldLabel = (field: string, t: Tr) =>
  FIELD_KEYS[field] ? t(FIELD_KEYS[field]) : field;

/** `payload.fields` is an array of conflicts for most kinds, but the legacy
 * `user_created` rows wrote a plain `{name, team}` object there. Anything
 * that isn't the conflict shape is not a conflict. */
export function conflictFields(
  payload: PlanIssue["payload"] | undefined,
): FieldConflict[] {
  const raw = payload?.fields;
  if (!Array.isArray(raw)) return [];
  return raw.filter((f) => f && typeof f === "object" && "field" in f);
}

const diffs = (fields: FieldConflict[], t: Tr) =>
  fields
    .map((f) => {
      const from = f.current ?? t("common.empty");
      const to = f.proposed ?? t("common.empty");
      return `${fieldLabel(f.field, t)} (${from} → ${to})`;
    })
    .join(", ");

/** One sentence a person can act on. Never returns an empty string: a row nobody
 * can read is worse than a clumsy one. Takes `t` rather than calling a hook,
 * because this module is imported from places that are not components. */
export function describeIssue(issue: PlanIssue | ImportIssue, t: Tr): string {
  const p = issue.payload ?? {};
  const fields = conflictFields(p);
  switch (issue.kind) {
    case "user_created":
      return t("issue.desc.user_created", {
        code: p.code ?? issue.item_id ?? "?",
      });
    case "user_code_mismatch":
      return t("issue.desc.user_code_mismatch", {
        name: p.name ?? "?",
        codes: (p.candidates ?? []).map((c) => c.employee_code).join(", "),
        code: p.code ?? issue.item_id ?? "?",
      });
    case "user_field_conflict":
      return fields.length
        ? t("issue.desc.user_field_conflict", { diffs: diffs(fields, t) })
        : (p.reason ?? t("issue.desc.user_field_conflict.noCode"));
    case "device_created_incomplete":
      return t("issue.desc.device_created_incomplete", {
        missing: (p.missing ?? []).map((f) => fieldLabel(f, t)).join(", "),
      });
    case "device_field_conflict":
      return fields.length
        ? t("issue.desc.device_field_conflict", { diffs: diffs(fields, t) })
        : t("issue.desc.device_field_conflict.plain");
    case "handover_duplicate":
      return t("issue.desc.handover_duplicate", {
        existing:
          (p.existing as { handover_date?: string })?.handover_date ?? "?",
        proposed: p.proposed_date ?? "?",
      });
    case "flow_ambiguous":
      return p.reason ?? t("issue.desc.flow_ambiguous");
    default:
      return p.reason ?? t(KIND_META[issue.kind]?.label ?? "issue.kind.user_created");
  }
}

/** Which resources an issue can be settled against by writing a row. Handover-scoped
 * kinds have no single row to patch — offering "Apply" there wrote nothing and
 * still marked the issue resolved. */
export const isWritable = (issue: { resource: string }) =>
  issue.resource === "users" || issue.resource === "devices";
