// The editable record behind the Scan screen's minutes form, and how readings
// fold into it. Every field remembers where its value came from (minutesFields
// `Field`): the camera, the database, Claude, or the person — and a person's
// edit or a database match is never overwritten by a later reading.
import type { ParsedMinutes } from "../api/imports";
import type { MinutesReading, ScanGroup } from "../api/scan";
import { fold, put, type Extracted, type Field, type PartyRole, type Source } from "./minutesFields.ts";

export type PartyKey = "name" | "code" | "dept" | "position" | "company" | "address" | "phone";
export const PARTY_KEYS: PartyKey[] = ["code", "name", "dept", "position", "company", "address", "phone"];
export type ItemKey = "item" | "type" | "brand" | "cpu" | "ram" | "storage" | "note";
export const ITEM_KEYS: ItemKey[] = ["item", "type", "brand", "cpu", "ram", "storage", "note"];

export type FormParty = { label: string; role: PartyRole } & Partial<Record<PartyKey, Field>>;
export type FormItem = {
  id: number;
  serials: string[];
  // Serials that came only from the camera. Those can still be withdrawn when
  // later frames stop showing them; Claude's and a person's cannot.
  fromCamera?: string[];
} & Partial<Record<ItemKey, Field>>;
export type MinutesForm = {
  kind?: Field; // "internal" | "supplier"
  date?: Field;
  place?: Field;
  docNumber?: Field;
  docType?: Field;
  reason?: Field;
  parties: FormParty[];
  items: FormItem[];
};

export type KnownUser = { name: string | null; team: string | null };

let nextId = 1;
export const emptyForm = (): MinutesForm => ({
  parties: [
    { label: "A", role: "unknown" },
    { label: "B", role: "unknown" },
  ],
  items: [],
});
export const newItem = (): FormItem => ({ id: nextId++, serials: [] });

const keyOf = (s: string) => fold(s).replace(/[^a-z0-9]/g, "");

/** A code that is in the user table settles the person: name and team come
 * from the database, which spells them right. */
function applyKnown(p: FormParty, users: ReadonlyMap<string, KnownUser>): FormParty {
  const code = p.code?.value?.toUpperCase();
  const u = code ? users.get(code) : undefined;
  if (!u) return p;
  return {
    ...p,
    code: p.code?.source === "user" ? p.code : { value: code!, source: "db", conf: 1 },
    name: put(p.name, u.name ?? undefined, "db", 1) ?? p.name,
    dept: put(p.dept, u.team ?? undefined, "db", 1) ?? p.dept,
  };
}

function findItem(items: FormItem[], name: string, serials: string[]): FormItem | undefined {
  return (
    items.find((it) => serials.some((s) => it.serials.includes(s))) ??
    (name ? items.find((it) => it.item?.value && keyOf(it.item.value) === keyOf(name)) : undefined)
  );
}

/** Fold one camera frame's extraction into the form. */
export function mergeExtracted(form: MinutesForm, e: Extracted, users: ReadonlyMap<string, KnownUser>): MinutesForm {
  const conf = Math.max(0.05, Math.min(0.9, e.conf));
  const next: MinutesForm = { ...form, parties: form.parties.map((p) => ({ ...p })), items: form.items.map((i) => ({ ...i, serials: [...i.serials] })) };
  const { internal, supplier } = e.kindVotes;
  if (internal !== supplier) {
    const kind = internal > supplier ? "internal" : "supplier";
    next.kind = put(next.kind, kind, "ocr", Math.min(0.9, Math.abs(internal - supplier) / 10));
  }
  next.date = put(next.date, e.date, "ocr", conf);
  next.place = put(next.place, e.place, "ocr", conf);
  next.docNumber = put(next.docNumber, e.docNumber, "ocr", conf);
  next.docType = put(next.docType, e.docType, "ocr", conf);
  next.reason = put(next.reason, e.reason, "ocr", conf);

  for (const p of e.parties) {
    let fp = next.parties.find((x) => x.label === p.label);
    if (!fp) {
      fp = { label: p.label, role: p.role };
      next.parties.push(fp);
    }
    if (p.role !== "unknown") fp.role = p.role;
    for (const k of PARTY_KEYS) fp[k] = put(fp[k], p[k], "ocr", conf);
  }
  next.parties = next.parties.map((p) => applyKnown(p, users));

  for (const it of e.items) {
    let fi = findItem(next.items, it.item, it.serials);
    if (!fi) {
      if (!it.serials.length && !it.item) continue;
      fi = newItem();
      next.items.push(fi);
    }
    fi.item = put(fi.item, it.item, "ocr", conf);
    for (const s of it.serials) {
      if (fi.serials.includes(s)) continue;
      fi.serials.push(s);
      fi.fromCamera = [...(fi.fromCamera ?? []), s];
    }
  }
  return next;
}

/** Withdraw camera-only serials that recent frames no longer show (a misread
 * of a line before its proper text arrived), and the rows left empty by it. */
export function dropStale(form: MinutesForm, stillSeen: ReadonlySet<string>): MinutesForm {
  let changed = false;
  const items = form.items
    .map((it) => {
      const stale = (it.fromCamera ?? []).filter((s) => !stillSeen.has(s));
      if (!stale.length) return it;
      changed = true;
      return { ...it, serials: it.serials.filter((s) => !stale.includes(s)), fromCamera: it.fromCamera!.filter((s) => !stale.includes(s)) };
    })
    .filter((it) => it.serials.length || it.item?.value);
  return changed ? { ...form, items } : form;
}

/** Fold Claude's careful read into the form. Fields a person typed or the
 * database settled stay; everything else takes Claude's value. */
export function mergeClaude(form: MinutesForm, r: MinutesReading, users: ReadonlyMap<string, KnownUser>): MinutesForm {
  const a = r.answer;
  const C = (f: Field | undefined, v: string | undefined) => put(f, v || undefined, "claude" as Source, 0.95);
  const next: MinutesForm = {
    ...form,
    kind: C(form.kind, a.kind),
    date: C(form.date, a.handover_date),
    place: C(form.place, a.place),
    docNumber: C(form.docNumber, a.doc_number),
    docType: C(form.docType, a.doc_type),
    reason: C(form.reason, a.reason),
    parties: form.parties.map((p) => ({ ...p })),
    items: form.items.map((i) => ({ ...i, serials: [...i.serials] })),
  };
  const known = new Map(users);
  for (const [code, u] of Object.entries(r.known_codes)) known.set(code, u);
  for (const p of a.parties) {
    let fp = next.parties.find((x) => x.label === p.label);
    if (!fp) {
      fp = { label: p.label, role: p.role };
      next.parties.push(fp);
    }
    if (p.role !== "unknown") fp.role = p.role;
    for (const k of PARTY_KEYS) fp[k] = C(fp[k], p[k]);
  }
  next.parties = next.parties.map((p) => applyKnown(p, known));
  for (const it of a.items) {
    if (it.kind !== "device") continue;
    const serials = it.serials.map((s) => s.replace(/^\s*S\/?N\s*[:#.]?\s*/i, "").replace(/\s+/g, "")).filter(Boolean);
    let fi = findItem(next.items, it.item, serials);
    if (!fi) {
      fi = newItem();
      next.items.push(fi);
    }
    fi.item = C(fi.item, it.item);
    fi.type = C(fi.type, it.type);
    fi.brand = C(fi.brand, it.brand?.toUpperCase());
    fi.cpu = C(fi.cpu, it.cpu);
    fi.ram = C(fi.ram, it.ram);
    fi.storage = C(fi.storage, it.storage);
    fi.note = C(fi.note, it.note);
    for (const s of serials) if (!fi.serials.includes(s)) fi.serials.push(s);
    fi.fromCamera = (fi.fromCamera ?? []).filter((s) => !serials.includes(s));
  }
  // Rows the camera invented from noise (no serial, nothing Claude saw) go.
  next.items = next.items.filter((i) => i.serials.length || i.item?.source === "user" || i.item?.source === "claude");
  return next;
}

const v = (f?: Field) => f?.value?.trim() ?? "";

/** The internal record, as /imports/handover/plan takes it. */
export function toParsed(form: MinutesForm): ParsedMinutes {
  let row = 0;
  const parsed: ParsedMinutes = {
    handover_date: /^\d{4}-\d{2}-\d{2}$/.test(v(form.date)) ? v(form.date) : null,
    place: v(form.place) || null,
    parties: form.parties
      .filter((p) => v(p.code) || v(p.name))
      .map((p) => ({ label: p.label, name: v(p.name) || null, code: v(p.code).toUpperCase() || null, dept: v(p.dept) || null, position: v(p.position) || null })),
    items: form.items.flatMap((it) =>
      (it.serials.length ? it.serials : [""]).filter(Boolean).map((serial) => ({
        row: ++row,
        no: row,
        quantity: 1,
        item: v(it.item) || null,
        detail: [v(it.cpu), v(it.ram), v(it.storage)].filter(Boolean).join(" / ") || null,
        serial,
        note: v(it.note) || null,
        device: {
          type: v(it.type) || null,
          brand: v(it.brand) || null,
          cpu: v(it.cpu) || null,
          ram: v(it.ram) || null,
          storage: v(it.storage) || null,
          name: v(it.item).slice(0, 100) || null,
        },
      })),
    ),
  };
  return parsed;
}

/** A supplier record, as groups for the supplier review list (/scan/save). */
export function toGroups(form: MinutesForm): ScanGroup[] {
  return form.items
    .filter((it) => it.serials.length)
    .map((it) => ({
      name: v(it.item).slice(0, 100),
      type: v(it.type),
      brand: v(it.brand),
      cpu: v(it.cpu),
      ram: v(it.ram),
      storage: v(it.storage),
      os: "",
      serials: [...it.serials],
    }));
}

export function sellerOf(form: MinutesForm): string {
  const p = form.parties.find((x) => x.role === "seller") ?? form.parties.find((x) => x.label === "B");
  return v(p?.company) || v(p?.name);
}

/** Whether a merge changed anything a person would see. Readings arrive
 * several times a second and mostly confirm what is already there; handing
 * React the same object back lets it skip re-rendering the whole form. */
export function sameForm(a: MinutesForm, b: MinutesForm): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Apply a merge, keeping the old object when nothing changed. */
export function settle(prev: MinutesForm, next: MinutesForm): MinutesForm {
  return sameForm(prev, next) ? prev : next;
}
