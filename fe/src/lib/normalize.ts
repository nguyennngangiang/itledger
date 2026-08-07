// Tidy up spec values people type in a hurry.
//
// The team types "8" in RAM and "256" in Storage, and until now that is exactly
// what got stored — so the fleet holds "8", "8gb", "8 GB" and "8GB" as four
// different RAM values, which makes every count and every filter lie a little.
//
// Two rules govern this:
//
//  1. **Never change a value silently.** Every correction is applied on blur and
//     reported back to the caller, which shows "đã tự sửa từ …" with an undo. A
//     spec you did not type is worse than a spec you typed badly.
//  2. **Prefer a value the fleet already uses.** Snapping "win 11" to the exact
//     "Windows 11 Pro" already in the data keeps one spelling per thing, instead
//     of inventing a fifth. Same idea as _closest_team() in be/routers/imports.py.

export type Normalized = {
  value: string;
  /** The original text, when it was changed. null when nothing was touched. */
  changedFrom: string | null;
};

const unchanged = (value: string): Normalized => ({ value, changedFrom: null });

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * An existing fleet value to snap to, or null.
 *
 * Only unambiguous matches count: exactly one suggestion may start with what was
 * typed. "win" matching both "Windows 10 Pro" and "Windows 11 Pro" is a real
 * ambiguity, and picking either would be a guess dressed up as help.
 */
function snapToFleet(value: string, suggestions: string[]): string | null {
  const typed = fold(value);
  if (!typed) return null;
  const exact = suggestions.find((s) => fold(s) === typed);
  if (exact) return exact === value ? null : exact;
  const prefixed = suggestions.filter((s) => fold(s).startsWith(typed));
  if (prefixed.length === 1) return prefixed[0];
  return null;
}

/** "8" → "8GB", "16 gb" → "16GB", "32GB" → unchanged. */
function normalizeRam(value: string): Normalized {
  const t = value.trim();
  const bare = t.match(/^(\d{1,3})$/);
  if (bare) return { value: `${bare[1]}GB`, changedFrom: t };
  const withUnit = t.match(/^(\d{1,3})\s*(gb|g|tb)$/i);
  if (withUnit) {
    const unit = withUnit[2].toLowerCase() === "tb" ? "TB" : "GB";
    const next = `${withUnit[1]}${unit}`;
    return next === t ? unchanged(t) : { value: next, changedFrom: t };
  }
  return unchanged(t);
}

/** "256" → "256GB SSD", "512 ssd" → "512GB SSD", "1tb hdd" → "1TB HDD". */
function normalizeStorage(value: string): Normalized {
  const t = value.trim();
  const m = t.match(/^(\d{1,4})\s*(gb|g|tb)?\s*(ssd|hdd|nvme|emmc)?$/i);
  if (!m) return unchanged(t);
  const [, size, rawUnit, rawKind] = m;
  // A bare number is GB unless it is small enough to only make sense as TB.
  const unit = rawUnit
    ? rawUnit.toLowerCase() === "tb"
      ? "TB"
      : "GB"
    : Number(size) <= 8
      ? "TB"
      : "GB";
  const kind = (rawKind ?? "SSD").toUpperCase();
  const next = `${size}${unit} ${kind}`;
  return next === t ? unchanged(t) : { value: next, changedFrom: t };
}

/** "i5" → "Core i5", "core i7" → "Core i7". Leaves full model names alone. */
function normalizeCpu(value: string): Normalized {
  const t = value.trim();
  const m = t.match(/^(?:core\s*)?(i[3579])$/i);
  if (!m) return unchanged(t);
  const next = `Core ${m[1].toLowerCase()}`;
  return next === t ? unchanged(t) : { value: next, changedFrom: t };
}

/** Fields we touch at all. Anything else is left exactly as typed. */
const RULES: Record<string, (v: string) => Normalized> = {
  ram: normalizeRam,
  storage: normalizeStorage,
  cpu: normalizeCpu,
};

/**
 * Normalize one field's value on blur.
 *
 * `suggestions` is that field's existing fleet values (GET /<resource>/suggestions).
 * Snapping to one of those wins over the shape rules, because matching what the
 * data already says is always better than inventing a new spelling.
 */
export function normalizeField(
  field: string,
  value: string,
  suggestions: string[] = [],
): Normalized {
  const t = (value ?? "").trim();
  if (!t) return unchanged(t);

  const snapped = snapToFleet(t, suggestions);
  if (snapped) return { value: snapped, changedFrom: t };

  const rule = RULES[field];
  if (!rule) return unchanged(t);

  const result = rule(t);
  if (result.changedFrom === null) return result;

  // The rule invented a shape; if the fleet already spells that shape a
  // particular way, defer to the fleet.
  const snappedAfter = snapToFleet(result.value, suggestions);
  return snappedAfter
    ? { value: snappedAfter, changedFrom: t }
    : result;
}
