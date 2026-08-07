// Shared helpers for the spreadsheet importers (devices, maintenance).
//
// The header normaliser is the reason this file exists. The devices importer used
// `h.toLowerCase().replace(/[^a-z0-9]/g, "")`, which does not just drop
// punctuation — it drops every accented letter, so a Vietnamese header came out
// mangled ("Ngày sửa" → "ngysa") and could never be aliased in readable form.
// Folding the diacritics first turns it into "ngaysua", so alias tables can be
// written the way a person would type the column name.

/** Lowercase, strip Vietnamese diacritics, then drop everything but a–z0–9. */
export function norm(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining accents
    .replace(/[đĐ]/g, "d") // no NFD decomposition of its own
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Trim, and treat blank as absent. */
export function clean(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * Spreadsheet cell → ISO date. Accepts real Date cells (xlsx `cellDates`), an
 * ISO prefix, and DD/MM/YYYY or DD-MM-YYYY — day-first, because that is how the
 * team writes dates.
 */
export function toIsoDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    // Local-time parts: toISOString() would shift a midnight date back a day for
    // any timezone east of UTC, which is every date this app sees.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const yyyy = y.length === 2 ? `20${y}` : y;
    return `${yyyy}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

/** Money cell → a plain number, tolerating "1.200.000", "1,200,000" and " ₫". */
export function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const digits = String(value).replace(/[^\d.,-]/g, "");
  // Thousands separators, either convention — strip anything that isn't a digit
  // once we know there is no fractional part to protect (VND has none in practice).
  const plain = digits.replace(/[.,]/g, "");
  if (!plain || !/^-?\d+$/.test(plain)) return null;
  return Number(plain);
}

/** Build a header→field map for one sheet from an alias table. */
export function mapHeaders<F extends string>(
  headers: string[],
  aliases: Record<string, F>,
): Record<string, F> {
  const out: Record<string, F> = {};
  for (const header of headers) {
    const field = aliases[norm(header)];
    if (field) out[header] = field;
  }
  return out;
}
