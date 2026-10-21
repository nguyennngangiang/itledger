// Which of the text lines OCR read off a sticker are serial numbers.
//
// A device label carries a dozen strings — model, P/N, rated power, "Made in…".
// The serial is the one that is (a) usually printed after an S/N label, and (b)
// shaped like a serial: one alphanumeric run, 6–25 long, at least one digit.
// Stripping the label follows `clean_serial` in be/scan.py, so a serial read
// here and the same serial read by Claude come out identical.

export type Candidate = {
  value: string;
  // Printed after "S/N", "SN:", "Serial No." — the label says this is THE serial,
  // so "Save" takes it without asking.
  labelled: boolean;
  line: number; // index of the OCR line it came from
};

// Same rule as be/scan.py `_SERIAL_JUNK`: only a LABEL is stripped, never the
// letters themselves — real serials start with SN too ("SN242550042406").
const LABEL = /^(S\/?N|SERIAL(\s*NO\.?)?|SỐ SERI)(\s*[:#.]\s*|\s+)/i;
const SERIAL = /^[A-Z0-9][A-Z0-9\-/]{5,24}$/;
// Strings that look like serials but describe the device: power ratings,
// capacities, dates, plain words.
const NOT_SERIAL = /^(\d+(V|W|A|HZ|MAH|GB|TB|MB)|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|[A-Z]+)$/;
// Spec fragments off a product line: "255H/32GB", "16GB/512GB". Only a whole
// slash-separated part that is digits + unit counts — "5CD0337TB" is an HP
// serial that merely ends in TB.
const SPEC = /(^|\/)\d+(GB|TB|MB|GHZ|MHZ|HZ)($|\/)/;

export function serialCandidates(lines: string[], exclude: ReadonlySet<string> = new Set()): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  lines.forEach((raw, line) => {
    const text = raw.trim().toUpperCase();
    const labelled = LABEL.test(text);
    // A label on its own line ("S/N") and the value on the next is common too.
    const prevLabel = line > 0 && /^(S\/?N|SERIAL(\s*NO\.?)?)\s*[:#.]?$/i.test(lines[line - 1].trim());
    const body = text.replace(LABEL, "");
    for (const tok of body.split(/[\s,;|]+/)) {
      const v = tok.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, "");
      if (!SERIAL.test(v) || !/\d/.test(v) || NOT_SERIAL.test(v) || SPEC.test(v) || exclude.has(v) || seen.has(v)) continue;
      // Without an S/N label, short codes are mostly model fragments
      // ("UX3405CA" read as "ZBUX5CA"); real serials run 8+ characters.
      if (!(labelled || prevLabel) && v.length < 8) continue;
      seen.add(v);
      out.push({ value: v, labelled: labelled || prevLabel, line });
    }
  });
  return out;
}

/**
 * Frame-to-frame agreement. OCR on a moving phone flickers between near
 * misses; a value is only shown once it has been read the same way in
 * `need` consecutive frames.
 */
export class Stabilizer {
  private streak = new Map<string, number>();
  private need: number;
  constructor(need = 2) {
    this.need = need;
  }

  push(values: string[]): string[] {
    const next = new Map<string, number>();
    for (const v of values) next.set(v, (this.streak.get(v) ?? 0) + 1);
    this.streak = next;
    return [...next].filter(([, n]) => n >= this.need).map(([v]) => v);
  }

  reset() {
    this.streak.clear();
  }
}
