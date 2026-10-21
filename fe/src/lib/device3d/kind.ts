// Which 3D model a device row gets, and how it is finished. Pure — no three.js —
// so it is unit-tested (scripts/device3d-kind.test.mjs).
//
// `type` is free text from the Excel import. On the live ledger it is LAPTOP /
// MONITOR / DESKTOP / ACCESSORY / Tablet in mixed case, and ACCESSORY covers
// anything from a Logitech mouse to an iPad — so the NAME decides as much as
// the type does. A model field doesn't exist, so shapes are per kind, and
// colour/material per brand; nothing pretends to be the exact SKU.

export type Kind =
  | "laptop" | "desktop" | "minipc" | "monitor" | "set" | "tablet" | "phone"
  | "printer" | "mouse" | "keyboard" | "cable" | "hub" | "ssd" | "other";

export type DeviceLike = {
  type?: string | null; name?: string | null; brand?: string | null;
  cpu?: string | null; ram?: string | null; storage?: string | null;
  os?: string | null; status?: string | null;
};

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

// Order matters: specific accessories before the broad types, so
// "Displayport to HDMI" is a cable, not a monitor, and "iPad" is a tablet even
// when filed as ACCESSORY.
const RULES: [Kind, RegExp][] = [
  ["mouse", /\b(chuot|mouse)\b/],
  ["keyboard", /\b(ban phim|keyboard)\b/],
  ["cable", /\b(hdmi|displayport|cap|cable|day)\b/],
  ["hub", /\b(hub|dock|docking)\b/],
  ["ssd", /^(ssd|hdd|o cung)\b|\b(ssd|nvme)\s*\d/],
  ["tablet", /\b(ipad|tablet|may tinh bang|galaxy tab)\b/],
  ["phone", /\b(iphone|phone|dien thoai|smartphone)\b/],
  ["printer", /\b(printer|may in|scanner|may scan)\b/],
  ["laptop", /\b(laptop|notebook|macbook|thinkpad|vivobook|zenbook|latitude|elitebook|probook|xps)\b/],
  ["monitor", /\b(monitor|man hinh|display)\b/],
  ["desktop", /\b(desktop|pc|may ban|workstation|tower|main ?board)\b/],
];

// Specs of a whole computer inside a name: "HP core i3 ram 8gb ssd 256gb". Such a
// row is a PC even when it mentions an SSD — the first version read "ssd 256gb"
// and drew a bare drive for a desktop.
const PC_SPEC = /\b(core\s*-?\s*i\d|corei\d|i[3579]\b|ryzen\s*\d?|ultra\s*\d|apple\s*m\d|main ?board|\d+\s*gb\s*ram|ram\s*\d+)/;
const MONITOR_WORD = /\b(monitor|man hinh)\b|\d{2}\s*(?:"|inch)/;

/** Number of monitors in a set row: `… / 2 27" LG Monitor / …` → 2. */
export function monitorsInSet(d: DeviceLike): number {
  const m = fold(d.name ?? "").match(/\b(\d)\s+\d{2}\s*(?:"|inch)/);
  return m ? Math.min(3, Math.max(1, +m[1])) : 1;
}

export function kindOf(d: DeviceLike): Kind {
  const type = fold(d.type ?? "").trim();
  const name = fold(d.name ?? "");
  // A printer is a printer whatever the type column says — the live ledger has
  // "Máy in laser đen trắng HP 4003dn" filed as LAPTOP.
  if (/\b(may in|printer|laserjet|scanner)\b/.test(name)) return "printer";
  // "HP Core i3 - 8GB - 256GB / 22" LG Monitor": one row for a PC AND its
  // screen, filed as MONITOR or ACCESSORY. Draw both.
  const parts = name.split("/");
  if (parts.length > 1 && parts.some((p) => MONITOR_WORD.test(p)) && parts.some((p) => PC_SPEC.test(p) && !MONITOR_WORD.test(p))) {
    return "set";
  }
  // A clear type wins for the big categories; ACCESSORY (or nothing) defers to
  // the name.
  if (/^(laptop|notebook)/.test(type)) return "laptop";
  if (/^(monitor|man hinh)/.test(type)) return "monitor";
  if (/^(tablet|ipad)/.test(type)) return "tablet";
  if (/^(desktop|pc|workstation|may ban)/.test(type)) {
    // Apple silicon in a "desktop" row is a Mac mini, not a tower.
    return fold(d.brand ?? "") === "apple" || /\bm[1-4]\b/.test(fold(d.cpu ?? "")) ? "minipc" : "desktop";
  }
  if (/^(phone|dien thoai)/.test(type)) return "phone";
  if (/^(printer|may in)/.test(type)) return "printer";
  // Whole-computer specs in an ACCESSORY row (and no clearer word): a desktop.
  const accessory = RULES.slice(0, 4).find(([, re]) => re.test(name));
  if (!accessory && PC_SPEC.test(name)) return "desktop";
  for (const [k, re] of RULES) if (re.test(name) || re.test(type)) return k;
  return "other";
}

/** Screen diagonal in inches from names like `LG Monitor 27"` or `22inch Monitor`. */
export function inchesOf(d: DeviceLike): number | null {
  const m = (d.name ?? "").match(/(\d{2}(?:\.\d)?)\s*(?:"|''|”|inch|in\b|-inch)/i);
  const n = m ? parseFloat(m[1]) : NaN;
  return n >= 10 && n <= 49 ? n : null;
}

export type Finish = {
  /** body colour (sRGB hex) */
  body: string;
  metal: boolean;
  /** accent for the logo / details */
  accent: string;
  logo: string;
};

const FINISH: [RegExp, Finish][] = [
  [/^apple/, { body: "#c9ccd1", metal: true, accent: "#e9ebee", logo: "" }],
  [/^(dell|alienware)/, { body: "#2b2e33", metal: false, accent: "#9aa3ad", logo: "DELL" }],
  [/^lenovo|thinkpad/, { body: "#1c1d20", metal: false, accent: "#e2231a", logo: "lenovo" }],
  [/^hp|hewlett/, { body: "#b7bbc1", metal: true, accent: "#f4f5f6", logo: "hp" }],
  [/^asus/, { body: "#5c6470", metal: true, accent: "#d9dde2", logo: "ASUS" }],
  [/^acer/, { body: "#43474d", metal: true, accent: "#a6c94a", logo: "acer" }],
  [/^lg/, { body: "#24262a", metal: false, accent: "#c0c4ca", logo: "LG" }],
  [/^samsung/, { body: "#2c2f35", metal: false, accent: "#d0d4da", logo: "SAMSUNG" }],
  [/^gigabyte|aorus/, { body: "#1e2024", metal: false, accent: "#ff7a1a", logo: "GIGABYTE" }],
  [/^msi/, { body: "#1b1c1f", metal: false, accent: "#e0262d", logo: "msi" }],
  [/^logitech/, { body: "#2a2b2e", metal: false, accent: "#00b8fc", logo: "logi" }],
  [/^ugreen/, { body: "#3a3d42", metal: true, accent: "#36c26b", logo: "UGREEN" }],
];

export function finishOf(d: DeviceLike): Finish {
  const b = fold(d.brand ?? "").trim();
  const n = fold(d.name ?? "");
  for (const [re, f] of FINISH) if (re.test(b)) return f;
  // Brand empty (most accessories): try the name — "Chuột Logitech B100".
  const words = n.split(/[^a-z0-9]+/).filter(Boolean);
  for (const [re, f] of FINISH) if (words.some((w) => re.test(w))) return f;
  return { body: "#3b3f45", metal: false, accent: "#c5cad1", logo: (d.brand ?? "").trim().slice(0, 10) };
}

/** Power-LED colour for the status, or null when it is off. */
export function ledOf(status: string | null | undefined): string | null {
  switch (status) {
    case "active": return "#38e07b";
    case "maintaining": return "#ffb02e";
    case "on_del": return "#ff4d4f";
    default: return null;            // in_stock / unknown: switched off
  }
}

export type Os = "windows" | "mac" | "android" | "ios" | "none";

export function osOf(d: DeviceLike): Os {
  const o = fold(d.os ?? "");
  if (/mac/.test(o)) return "mac";
  if (/android/.test(o)) return "android";
  if (/\bios|ipados/.test(o)) return "ios";
  if (/win/.test(o)) return "windows";
  return "none";
}

/** The specific product family when the name says it, so its model can follow
 * the real design (dimensions and features from the makers' spec pages):
 * HP 15 / 15s, Vivobook 15 X1502, Inspiron 16, MacBook Air, LG / Samsung office
 * monitors, Logitech B100, DareU EK75, LaserJet Pro 4003dn, iPad, POCO Pad, and
 * the tower each brand actually ships (HP Pro Tower, OptiPlex, GIGABYTE case). */
export type Variant =
  | "hp15" | "vivobook" | "inspiron" | "macbook" | "laptop"
  | "lg" | "samsung" | "monitor"
  | "hp-tower" | "dell-tower" | "gaming" | "tower"
  | "b100" | "mouse" | "ek75" | "keyboard" | "laserjet" | "printer"
  | "ipad" | "pocopad" | "tablet" | "other";

export function variantOf(d: DeviceLike, kind: Kind = kindOf(d)): Variant {
  const n = fold(`${d.brand ?? ""} ${d.name ?? ""}`);
  const brand = fold(d.brand ?? "");
  switch (kind) {
    case "laptop":
      if (/vivobook|x1502/.test(n)) return "vivobook";
      if (/inspiron/.test(n) || brand === "dell") return "inspiron";
      if (/apple|macbook/.test(n) || /\bm[1-4]\b/.test(fold(d.cpu ?? ""))) return "macbook";
      if (/\bhp\b|hewlett/.test(n)) return "hp15";
      if (/asus/.test(n)) return "vivobook";
      return "laptop";
    case "monitor":
    case "set": {
      // in a set the SCREEN brand is the one after the "/" (HP PC + LG monitor)
      const screen = kind === "set" ? fold(d.name ?? "").split("/").find((p) => MONITOR_WORD.test(p)) ?? n : n;
      if (/\blg\b/.test(screen)) return "lg";
      if (/samsung/.test(screen)) return "samsung";
      return "monitor";
    }
    case "desktop":
      if (/gigabyte|aorus|gtx|rtx/.test(n)) return "gaming";
      if (/\bhp\b/.test(n)) return "hp-tower";
      if (/\bdell\b/.test(n)) return "dell-tower";
      return "tower";
    case "mouse": return /b100/.test(n) ? "b100" : "mouse";
    case "keyboard": return /ek75/.test(n) ? "ek75" : "keyboard";
    case "printer": return /4003|laserjet|may in laser/.test(n) ? "laserjet" : "printer";
    case "tablet":
      if (/ipad/.test(n)) return "ipad";
      if (/poco|xiaomi|redmi/.test(n)) return "pocopad";
      return "tablet";
    default: return "other";
  }
}

/** Tower brand inside a set row: "HP Core i3 … / 22" LG Monitor" → hp-tower. */
export function setTower(d: DeviceLike): Variant {
  const pc = fold(d.name ?? "").split("/").find((p) => PC_SPEC.test(p) && !MONITOR_WORD.test(p)) ?? "";
  return variantOf({ ...d, brand: "", name: pc }, "desktop");
}

/** A colour named in the row ("Ipad … - blue", "Xanh dương") as a body hex. */
export function namedColour(d: DeviceLike, palette: { blue: string; silver?: string }): string | null {
  const n = fold(d.name ?? "");
  if (/\bblue\b|xanh duong|xanh\b/.test(n)) return palette.blue;
  if (/silver|\bbac\b/.test(n)) return palette.silver ?? null;
  return null;
}
