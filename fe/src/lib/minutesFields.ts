// Turning the text lines of one camera frame of a handover record into form
// fields — the live half of "scan a biên bản". Pure functions; no DOM.
//
// Input is one frame's lines (text + box), grouped here into rows. Labels are
// matched on a diacritic-free, lower-cased copy of the text; values are cut
// from the ORIGINAL text at the same offsets, so "Hồ Thị Thu Thủy" keeps its
// marks. Label wording follows the company template (be/handover_sheet.py:
// "Bên/Party", "Mã NV/Code", "Bộ phận/Dept", "Chức vụ/Position") plus what the
// supplier forms print ("BÊN A (BÊN MUA)", "Người nhận hàng", "Địa chỉ").
//
// What this gets wrong, Claude's read ("Claude đọc kỹ") fixes; what a person
// typed is never overwritten by either (see mergeFields).
import { serialCandidates } from "./serialCandidates.ts";

export type Cell = { text: string; x: number; y: number; w: number; h: number; conf: number };
export type Row = { cells: Cell[]; text: string; folded: string; conf: number };

export type PartyRole = "giver" | "receiver" | "buyer" | "seller" | "unknown";
export type PartyFields = {
  label: string;
  role: PartyRole;
  name?: string;
  code?: string;
  dept?: string;
  position?: string;
  company?: string;
  address?: string;
  phone?: string;
};
export type ItemFields = { item: string; serials: string[]; quantity?: number; note?: string };
export type Extracted = {
  kindVotes: { internal: number; supplier: number };
  date?: string; // YYYY-MM-DD
  place?: string;
  docNumber?: string;
  docType?: string;
  reason?: string;
  parties: PartyFields[];
  items: ItemFields[];
  conf: number;
};

/** Length-preserving fold: every character maps to exactly one (base letter,
 * lower case), so an index in the folded string is an index in the original. */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const base = ch.normalize("NFD")[0] ?? ch;
    const c = ch === "đ" || ch === "Đ" ? "d" : base.toLowerCase();
    // Keep surrogate pairs (CJK ext., emoji) one-for-one too.
    out += ch.length === 2 ? (c.length === 2 ? c : c + " ") : c[0];
  }
  return out;
}

/** Cells of one frame → rows, top to bottom; a cell joins a row when its
 * vertical middle falls inside the row's band. */
export function toRows(cells: Cell[]): Row[] {
  const sorted = [...cells].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const rows: Cell[][] = [];
  for (const c of sorted) {
    const mid = c.y + c.h / 2;
    const row = rows.find((r) => {
      const top = Math.min(...r.map((x) => x.y));
      const bottom = Math.max(...r.map((x) => x.y + x.h));
      return mid > top && mid < bottom;
    });
    if (row) row.push(c);
    else rows.push([c]);
  }
  return rows.map((r) => {
    const cells = r.sort((a, b) => a.x - b.x);
    for (const c of cells) c.text = c.text.replace(/^[\s|"“”'`]+|[\s|"“”'`]+$/g, "");
    const text = cells.map((c) => c.text).filter(Boolean).join("   ");
    return { cells, text, folded: fold(text), conf: Math.min(...cells.map((c) => c.conf)) };
  });
}

// ---------------------------------------------------------------- labels

type FieldKey = "name" | "code" | "dept" | "position" | "address" | "phone" | "company";

// Order matters only for overlapping words; each is matched on folded text.
const LABELS: [FieldKey, RegExp][] = [
  ["code", /\b(ma\s*(so\s*)?(nv|nhan\s*vien)|msnv|employee\s*code|code|emp\.?\s*id)\b\.?/g],
  ["name", /\b(ho\s*(va\s*)?ten|ong\s*\/\s*ba|full\s*name|name|nguoi\s*nhan\s*hang|nguoi\s*giao\s*hang|dai\s*dien|representative)\b/g],
  ["dept", /\b(bo\s*phan|phong\s*ban|phong|dept\.?|department|don\s*vi)\b/g],
  ["position", /\b(chuc\s*vu|chuc\s*danh|position|title)\b/g],
  ["address", /\b(dia\s*chi|address)\b/g],
  ["phone", /\b(dien\s*thoai|so\s*dien\s*thoai|sdt|tel|phone|hotline)\b/g],
];

const PARTY = /\b(ben|party)\s*([abc])\b|\bben\s*(giao|ban\s*giao|nhan|mua|ban)\b/g;
const TABLE_HEAD = /\b(stt|tt|no\.?)\b.*\b(serial|so\s*seri|ten\s*hang|danh\s*muc|noi\s*dung|item|san\s*pham)\b|\b(serial|so\s*seri)\b.*\b(ten\s*hang|noi\s*dung|item)\b/;
const SIGNATURE = /\b(dai\s*dien\s*ben|ky\s*,?\s*(ghi\s*ro\s*)?ho\s*ten|ben\s*xuat|giao\s*van|thu\s*kho|ke\s*toan)\b/;

const ROLE_OF: Record<string, PartyRole> = {
  giao: "giver", "ban giao": "giver", nhan: "receiver", mua: "buyer", ban: "seller",
};

/** Cut "label: value   label2: value2" into values, by where labels start. */
function labelled(row: Row): { key: FieldKey; value: string }[] {
  const hits: { key: FieldKey; start: number; end: number }[] = [];
  for (const [key, re] of LABELS) {
    for (const m of row.folded.matchAll(re)) {
      const start = m.index!;
      // A label inside an already-claimed label ("ma nv" contains no other) is skipped.
      if (hits.some((h) => start >= h.start && start < h.end)) continue;
      hits.push({ key, start, end: start + m[0].length });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits.map((h, i) => {
    const raw = row.text.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : undefined);
    // Drop the "/ Code" half of bilingual labels and the colon.
    const value = raw.replace(/^[\s/]*[A-Za-z .]{0,14}?\s*[:：]\s*|^\s*[:：.\-–]\s*/, "").replace(/[\s/:：|]+$/, "").trim();
    return { key: h.key, value };
  }).filter((v) => v.value);
}

function firstLabel(folded: string): number {
  let min = folded.length;
  for (const [, re] of LABELS) {
    re.lastIndex = 0;
    const m = re.exec(folded);
    re.lastIndex = 0;
    if (m && m.index < min) min = m.index;
  }
  return min;
}

const CODE = /\b[A-Z]{1,6}-?\d{1,6}\b/;
const PHONE = /(\+?84|0)[\d .]{8,12}\d/;

function clean(key: FieldKey, value: string): string | undefined {
  if (key === "code") return value.toUpperCase().match(CODE)?.[0];
  if (key === "phone") return value.match(PHONE)?.[0].replace(/[ .]/g, "");
  if (key === "name") {
    // "Mr Tuấn - 0934168188": the phone goes to its own field.
    return value.replace(PHONE, "").replace(/[-–,\s]+$/, "").trim() || undefined;
  }
  return value || undefined;
}

// ---------------------------------------------------------------- one frame

const SKIP_ITEM = /\b(tem\s*(dich\s*vu|kiem\s*dinh|bao\s*hanh)|the\s*bao\s*hanh|giam\s*(gia|ngay|den)|tang\s*ma|uu\s*dai|voucher|khuyen\s*mai|qua\s*tang)\b/;

export function extract(rows: Row[], knownCodes: ReadonlySet<string> = new Set()): Extracted {
  const out: Extracted = { kindVotes: { internal: 0, supplier: 0 }, parties: [], items: [], conf: 0 };
  let party: PartyFields | null = null;
  let inTable = false;
  let serialCol: { x0: number; x1: number } | null = null;
  let confSum = 0;

  for (const row of rows) {
    const f = row.folded;
    confSum += row.conf;

    // Kind votes.
    if (/\bma\s*(nv|nhan\s*vien)\b|\bemployee\s*code\b/.test(f)) out.kindVotes.internal += 2;
    if (/\bben\s*(mua|ban)\b|\bphieu\s*(xuat\s*kho|giao\s*hang)\b|\bhoa\s*don\b|\bnha\s*cung\s*cap\b/.test(f)) out.kindVotes.supplier += 2;

    // Title.
    if (!out.docType && /\b(bien\s*ban|phieu)\b/.test(f) && row.text.length < 90) out.docType = row.text.trim();

    // Date and place.
    const d =
      f.match(/ngay\s*(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{4})/) ??
      f.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
    const iso = f.match(/\[(\d{4})-(\d{2})-(\d{2})\]/);
    if (iso) out.date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    else if (d && !out.date) {
      const [dd, mm, yy] = [d[1], d[2], d[3]].map(Number);
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) out.date = `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
    const at = f.match(/\btai\s+([^,.;]+?)(\s+chung\s*toi|\s+gom|[,.;]|$)/);
    if (at && !out.place && /ngay|hom\s*nay/.test(f)) {
      out.place = row.text.slice(at.index! + at[0].indexOf(at[1]), at.index! + at[0].indexOf(at[1]) + at[1].length).trim();
    }
    const num = f.match(/\b(so\s*phieu|so\s*bien\s*ban|ma\s*xuat\s*kho|so\s*hoa\s*don)\s*[:：]?\s*/);
    if (num && !out.docNumber) out.docNumber = row.text.slice(num.index! + num[0].length).split(/\s{2,}/)[0].trim() || undefined;
    const why = f.match(/\b(ly\s*do|noi\s*dung)\s*[:：]\s*/);
    if (why && !out.reason && !inTable) out.reason = row.text.slice(why.index! + why[0].length).trim();

    if (SIGNATURE.test(f)) {
      party = null;
      inTable = false;
      continue;
    }

    // Party headers. "BÊN A (BÊN MUA): CÔNG TY TNHH YIC ONE" names side, role
    // and company in one row.
    const heads = [...f.matchAll(PARTY)];
    if (heads.length) {
      const label = heads.map((m) => m[2]).find(Boolean)?.toUpperCase();
      const roleWord = heads.map((m) => m[3]).find(Boolean);
      const role = roleWord ? ROLE_OF[roleWord.replace(/\s+/g, " ")] ?? "unknown" : "unknown";
      const key = label ?? (role === "giver" || role === "buyer" ? "A" : "B");
      party = out.parties.find((p) => p.label === key) ?? { label: key, role };
      if (role !== "unknown") party.role = role;
      if (!out.parties.includes(party)) out.parties.push(party);
      const last = heads[heads.length - 1];
      const rest = row.text.slice(last.index! + last[0].length).replace(/^[\s)/:：(]*(\(?[^)]*\))?[\s:：]*/, "").trim();
      const fields = labelled({ ...row, text: rest, folded: fold(rest) });
      if (fields.length) {
        for (const { key: k, value } of fields) setParty(party, k, value);
        // "Ngô Minh Tuấn.  Mã NV/ Code: VPHN291" — the name is what precedes
        // the first label.
        const before = rest.slice(0, firstLabel(fold(rest))).replace(/[\s.,;:–-]+$/, "").trim();
        if (before) {
          if (/^\s*cong\s*ty\b/.test(fold(before)) || party.role === "buyer" || party.role === "seller") party.company ??= before;
          else if (!party.name && /^[\p{L} .'-]{3,}$/u.test(before)) party.name = before;
        }
      } else if (rest) {
        if (/^\s*cong\s*ty\b/.test(fold(rest)) || party.role === "buyer" || party.role === "seller") party.company = rest;
        else if (!party.name) party.name = rest;
      }
      inTable = false;
      continue;
    }

    if (TABLE_HEAD.test(f)) {
      party = null;
      inTable = true;
      // Where the SERIAL column is, when the header says so: a short code is
      // only a serial if it sits in that column.
      const head = row.cells.find((c) => /\b(serial|so\s*seri|s\/n)\b/.test(fold(c.text)));
      serialCol = head ? { x0: head.x - head.w * 0.6, x1: head.x + head.w * 1.6 } : null;
      continue;
    }

    if (!inTable && party) {
      for (const { key, value } of labelled(row)) setParty(party, key, value);
      continue;
    }

    // Item rows: anything carrying a serial, or an "SN:" continuation of the
    // row above.
    if (inTable || /\bs\/?n\b/.test(f)) {
      // A serial is either labelled ("SN: …") or a whole cell by itself — a
      // code inside a product description ("ZenBook UX3405CA", "255H/32GB") is
      // part of the name, not a serial.
      const serials: string[] = [];
      for (const c of row.cells) {
        // "Whole cell" means the cell IS one ASCII token — "Mới 100%" or
        // "24 tháng" squeezed to letters would otherwise look like codes.
        const bare = c.text.replace(/^\s*S\/?N\s*[:：.]?\s*/i, "").trim();
        const whole = /^[A-Za-z0-9\-/]+$/.test(bare) ? bare.toUpperCase() : "";
        for (const cand of serialCandidates([c.text])) {
          if (knownCodes.has(cand.value)) continue;
          if (cand.labelled || (cand.value === whole && cand.value.length >= 5)) {
            if (!serials.includes(cand.value)) serials.push(cand.value);
          }
        }
        // Short codes like "YOD-001" fail the generic 8-char rule; a whole
        // cell in the item table is still a serial.
        const inSerialCol = serialCol ? c.x + c.w / 2 >= serialCol.x0 && c.x + c.w / 2 <= serialCol.x1 : false;
        // In the SERIAL column every token counts — the quantity is often
        // read into the same cell ("1 YOD-001").
        if (inTable && inSerialCol) {
          for (const tok of c.text.toUpperCase().split(/\s+/)) {
            if (/^[A-Z0-9][A-Z0-9-]{4,24}$/.test(tok) && /\d/.test(tok) && /[A-Z]/.test(tok) && !knownCodes.has(tok) && !serials.includes(tok)) serials.push(tok);
          }
        }
        if (inTable && inSerialCol && whole && !serials.includes(whole) && /^[A-Z0-9][A-Z0-9-]{4,7}$/.test(whole) && /\d/.test(whole) && /[A-Z]/.test(whole) && !knownCodes.has(whole)) serials.push(whole);
      }
      // The item name: the text cell just above an "SN:" cell (Hacom prints
      // serials under the name), else the longest text cell that is not a
      // unit, a status or a number.
      const textual = row.cells.filter(
        (c) =>
          /\p{L}{2,}/u.test(c.text) &&
          !serials.some((s) => c.text.toUpperCase().replace(/\s/g, "").includes(s) && c.text.replace(/\bS\/?N\b\s*[:：]?/i, "").trim().length <= s.length + 2) &&
          !/^(chiec|cai|bo|hop|thung|moi\s*100|hoat\s*dong|\d+\s*thang|vnd|cai\s*\d)/.test(fold(c.text.trim())),
      );
      const sn = row.cells.find((c) => /\bS\/?N\s*[:：]/i.test(c.text));
      // A name wrapped over several lines above the SN line is joined in order.
      const above = sn ? textual.filter((c) => c.y + c.h <= sn.y + sn.h / 2 && c.x <= sn.x + sn.w && c.x + c.w >= sn.x).sort((a, b) => a.y - b.y) : [];
      const nameText = above.length ? above.map((c) => c.text).join(" ") : (textual.sort((a, b) => b.text.length - a.text.length)[0]?.text ?? "");
      const name = nameText.replace(/\bS\/?N\s*[:：].*$/i, "").replace(/^\s*\d{1,3}[.)]?\s+/, "").replace(/-\s+/g, "-").trim();
      if (SKIP_ITEM.test(fold(name))) continue;
      const continuation = /^\s*s\/?n\b/.test(f) || (!name && serials.length);
      const prev = out.items[out.items.length - 1];
      if (continuation && prev) {
        for (const s of serials) if (!prev.serials.includes(s)) prev.serials.push(s);
      } else if (serials.length || (inTable && name.length > 3 && /^\s*\d{1,3}\b/.test(row.text))) {
        const qty = row.cells.map((c) => c.text.trim()).find((t) => /^\d{1,3}$/.test(t) && t !== row.cells[0].text.trim());
        out.items.push({ item: name, serials, quantity: qty ? Number(qty) : undefined });
      }
    }
  }

  // Employee codes anywhere decide an internal record.
  if (out.parties.some((p) => p.code)) out.kindVotes.internal += 3;
  if (out.parties.some((p) => p.company)) out.kindVotes.supplier += 1;
  out.conf = rows.length ? confSum / rows.length : 0;
  return out;
}

function setParty(p: PartyFields, key: FieldKey, value: string) {
  const v = clean(key, value);
  if (!v) return;
  if (key === "name") {
    const phone = value.match(PHONE)?.[0];
    if (phone && !p.phone) p.phone = phone.replace(/[ .]/g, "");
  }
  if (!p[key]) p[key] = v;
}

// ---------------------------------------------------------------- the form

export type Source = "ocr" | "db" | "claude" | "user";
export type Field = { value: string; source: Source; conf: number };

/** Whether a reading may replace what a field holds. A person's edit and a
 * database match are final; Claude beats the camera; a more confident camera
 * read beats a less confident one. */
export function mayReplace(current: Field | undefined, incoming: Field): boolean {
  if (!incoming.value) return false;
  if (!current || !current.value) return true;
  if (current.source === "user" || current.source === "db") return false;
  if (incoming.source === "claude") return current.source !== "claude" || incoming.conf >= current.conf;
  if (current.source === "claude") return false;
  return incoming.conf > current.conf + 0.05;
}

export function put(f: Field | undefined, value: string | undefined, source: Source, conf: number): Field | undefined {
  if (!value) return f;
  const next = { value, source, conf };
  return mayReplace(f, next) ? next : f;
}
