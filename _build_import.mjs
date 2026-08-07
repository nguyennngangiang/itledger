// Builds a DB-ready import_data.json (users / devices / handovers /
// maintenance / user_devices) for be/import_real.py, from two sources:
//
//   employees_import.json  the HR system's staff list, extracted from
//                          employee.dump by _extract_employees.sh. Authoritative
//                          for who exists and what their name and department are.
//   real-data.xlsx         three sheets: "Device code" (the hardware catalog,
//                          two tables side by side), "Handover History" and
//                          "Maintenance".
//
// The workbook's "Devices" sheet is deliberately NOT read. It used to be the
// only source of a device's owner and status, but it is a hand-maintained
// snapshot that drifts. Ownership is now DERIVED: whoever received a device in
// its most recent handover holds it, and anything never handed over sits in the
// IT store. That makes the handover chain the single story of where hardware is.
import * as XLSX from './fe/node_modules/xlsx/xlsx.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wb = XLSX.read(readFileSync(join(__dirname, 'real-data.xlsx')), { type: 'buffer' });
const rowsOf = (name) =>
  XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, blankrows: false });

// The HR export. Absent means someone skipped _extract_employees.sh, and the
// result would be a users table built only from whoever appears in a handover.
let hrStaff;
try {
  hrStaff = JSON.parse(readFileSync(join(__dirname, 'employees_import.json'), 'utf8'));
} catch {
  console.error('employees_import.json is missing. Run:\n' +
    '  wsl -d Ubuntu-24.04 -u root -- bash /mnt/d/itledger/_extract_employees.sh');
  process.exit(1);
}

const GHOST = 'IT-STORE';
const NOISE = new Set(['', '#n/a', 'n/a', 'na', '-', 'null', 'undefined', '#ref!', '#value!']);

// ---- cleaning helpers ----
const clean = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (NOISE.has(s.toLowerCase())) return null;
  return s === '' ? null : s;
};
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
const empCode = (v) => {
  const c = clean(v);
  return c ? c.toUpperCase() : null; // normalise casing (VPHn275 -> VPHN275)
};

// "2024.8.25" / "2026.04.21" / "2024.27.4" -> "YYYY-MM-DD" (null if unparseable)
function parseDotDate(v) {
  const s = clean(v);
  if (!s) return null;
  const parts = s.split(/[.\-/]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length !== 3) return null;
  let [y, m, d] = parts.map((x) => parseInt(x, 10));
  if (!y || !m || !d || y < 2000 || y > 2100) return null;
  if (m > 12 && d <= 12) [m, d] = [d, m]; // swap obvious day/month typo
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Excel serial (45770) -> "YYYY-MM-DD"
function parseExcelDate(v) {
  const n = typeof v === 'number' ? v : parseInt(clean(v) ?? '', 10);
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
  const ms = Date.UTC(1899, 11, 30) + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function parseMoney(v) {
  const s = clean(v);
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Owner decides status: the IT store holds stock, a person holds a device in
// use. Mirrors deriveStatus() in fe/src/lib/format.ts — keep the two in step.
const statusFor = (owner) => (!owner || owner === GHOST ? 'in_stock' : 'active');

const deviceName = (brand, cpu, ram, type) =>
  cut([clean(brand), clean(cpu), clean(ram)].filter(Boolean).join(' ') || clean(type), 100);

// "309INMF70803 / 303INFK5M299" -> ['309INMF70803', '303INFK5M299'].
// One handover cell can list several serials — a laptop and the monitor issued
// with it. Separators seen in the real sheet: "/", "," and a literal newline.
// Split the RAW value: clean() collapses newlines to spaces, so splitting after
// it would glue two serials into one token.
const splitSerials = (v) => {
  if (v == null) return [];
  return String(v).split(/[/,\n]+/).map((x) => clean(x)).filter(Boolean);
};

const BRANDS = ['SAMSUNG', 'VIEWSONIC', 'PHILIPS', 'LENOVO', 'DELL', 'ASUS', 'ACER',
                'BENQ', 'AOC', 'MSI', 'LG', 'HP'];
// Earliest brand mentioned wins, not the first in BRANDS order: a row reading
// 'Monitor LG 21,5"/ Dell 19,5"' is an LG row that also mentions Dell.
const brandIn = (v) => {
  const s = (clean(v) ?? '').toUpperCase();
  let best = null;
  let at = Infinity;
  for (const b of BRANDS) {
    const i = s.indexOf(b);
    if (i !== -1 && i < at) { at = i; best = b; }
  }
  return best;
};

// ---- name sources, ranked by how much they can be trusted ----
// HR first: employee.dump is the company's actual staff system, and it fixed 26
// names the workbook had wrong — missing diacritics ("Nguyễn Thị Hông"),
// unaccented short forms ("Tran Thuy"), outright typos ("Nguễn Thị Hạnh").
// The handover sheet is second but still good: it pairs a full Vietnamese name
// with that person's own code in ADJACENT cells, which is why it is the only
// workbook source still read — and it is the only source for the 35 people
// (interns on TTS* codes, a few leavers) who appear in handover history but not
// in HR at all.
const RANK_HR = 1;       // employees_import.json, from the HR database
const RANK_HANDOVER = 2; // Handover History: full name beside its own code
const NO_NAME = 99;

// Conflicts a human has already ruled on. These beat every source, HR included.
// SOURCE OF TRUTH is NAME_DECISIONS in be/fix_user_names.py; this copy exists
// because that one is Python. Keep both in step (the GHOST code is duplicated
// across languages the same way).
//
// VPHN318 used to be here and was RETIRED: the ruling read the workbook before
// HR data existed, and HR separates the two people cleanly — VPHN313 is Phan Thị
// Ngọc Hải, VPHN318 is Lê Yến Nhi. ben.pham, 2026-08-03.
const NAME_DECISIONS = {
  'VPHN216': 'Nguyễn Minh Quân',
  'VPHN270': 'Phạm Thị Khánh Huyền',
};

const TITLES = new Set(['ms', 'mrs', 'mr', 'miss']);
// Words that mean "this cell is a note, not a person". Belt-and-braces: the one
// column that mixed notes into names (Remark) is no longer read, but "Don't need
// to use PC" and "Có màn của team rồi" are 5 all-letter words and would sail
// through the shape check if any future source let them in.
const NOT_A_NAME = new Set(['dont', "don't", 'need', 'use', 'pc', 'laptop', 'monitor',
  'team', 'vga', 'may', 'máy', 'cu', 'cũ', 'cua', 'của', 'co', 'có', 'man', 'màn',
  'roi', 'rồi', 'khong', 'không', 'them', 'thêm', 'cho', 'moi', 'mới']);

// A person's full name: 2-5 words, every word letters-only (diacritics count).
// A single word is a NICKNAME ("Luna", "Kate", "Quân"), not a name — it can't be
// told apart from a note and it isn't who the row belongs to, so it's rejected;
// the code is reported under MISSING NAMES instead of being given a fake name.
function personName(v) {
  const s = clean(v);
  if (!s || s.length > 50) return null;
  const words = s.split(' ').filter((w) => w && !TITLES.has(w.toLowerCase()));
  if (words.length < 2 || words.length > 5) return null;
  // Letters, plus a hyphen/apostrophe *between* letters ("Lee Young-joo") — so a
  // dangling " - " still disqualifies the string.
  if (!words.every((w) => /^\p{L}+(?:[-'’]\p{L}+)*$/u.test(w))) return null;
  if (words.some((w) => NOT_A_NAME.has(w.toLowerCase()))) return null;
  return words.join(' ');
}

// Diacritic- and case-free token set, for telling "Lê Thị Xuân Hồng" vs
// "Xuan Hong" (the same person typed twice) apart from "Phan Hoài Thu" vs
// "Trịnh Thế Hưng" (two different people sharing one code in the source).
const tokens = (n) =>
  new Set(n.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[\s-]+/).filter(Boolean));
const isSpellingVariant = (a, b) => {
  const [x, y] = [tokens(a), tokens(b)];
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every((t) => big.has(t));
};

// Case noise only: "TRịnh Thế Hưng" / "Vũ nhật Minh" are the same name as their
// properly-cased twin, not a conflict. Compare on this key, display the variant
// with the most Title-Cased words.
const nameKey = (n) => n.toLowerCase();
const titleScore = (n) =>
  n.split(' ').filter((w) => /^\p{Lu}[^\p{Lu}]*$/u.test(w)).length;

// ============================================================
// USERS  (built as we discover codes; first non-null team wins)
// ============================================================
// Every name we see is collected as a *candidate* with the rank of its source,
// then resolveNames() picks per code once all sheets have been read. Resolving
// at the end (rather than as-we-go) is what makes precedence come from source
// trust instead of sheet order, and it's what lets a genuine 1-code-2-people
// clash be reported instead of silently decided by whichever sheet ran first.
const users = new Map(); // code -> {employee_code, name, team}
const nameCands = new Map(); // code -> Map(nameKey -> {name, rank})
const nicknames = new Map(); // code -> raw rejected value, for the report

function addUser(code, name, team, rank = NO_NAME) {
  const c = empCode(code);
  if (!c) return null;
  const t = cut(clean(team), 100);
  if (!users.has(c)) users.set(c, { employee_code: cut(c, 100), name: null, team: t });
  else if (!users.get(c).team && t) users.get(c).team = t;

  const n = cut(personName(name), 100);
  if (n && rank !== NO_NAME) {
    if (!nameCands.has(c)) nameCands.set(c, new Map());
    const bucket = nameCands.get(c);
    const k = nameKey(n);
    const prev = bucket.get(k);
    if (!prev) bucket.set(k, { name: n, rank });
    else {
      if (titleScore(n) > titleScore(prev.name)) prev.name = n;
      if (rank < prev.rank) prev.rank = rank;
    }
  } else if (!n && clean(name) && rank === RANK_HANDOVER && !nicknames.has(c)) {
    // A one-word handover cell is a nickname, not a name — reported, not stored.
    nicknames.set(c, clean(name));
  }
  return c;
}

// Best candidate per code; ties inside a rank keep the first seen. Splits the
// leftovers into two very different piles: `variants` (same person, typed
// differently — safe to just pick the best) and `conflicts` (one code claimed by
// two different people — a human has to decide, so it's only reported).
function resolveNames() {
  const conflicts = [];
  const variants = [];
  const ruled = [];
  for (const [c, bucket] of nameCands) {
    if (c === GHOST) continue;
    const cands = [...bucket.values()].sort((a, b) => a.rank - b.rank);
    users.get(c).name = cands[0].name;
    if (cands.length === 1) continue;
    const rest = cands.slice(1);
    (rest.every((r) => isSpellingVariant(cands[0].name, r.name)) ? variants : conflicts)
      .push({ code: c, cands });
  }
  // A human ruling is the last word, applied after every source has spoken.
  for (const [code, name] of Object.entries(NAME_DECISIONS)) {
    const u = users.get(code);
    if (u && u.name !== name) { ruled.push({ code, was: u.name, now: name }); u.name = name; }
  }
  return { conflicts, variants, ruled };
}

users.set(GHOST, { employee_code: GHOST, name: 'IT Store', team: 'IT' });

// ---- 0) HR staff list: everyone the company employs ----
// team = department, falling back to division for the couple of rows that leave
// department blank. Runs first so the workbook can only ever add to this.
for (const p of hrStaff) {
  const code = empCode(p.staff_code);
  if (!code) continue;
  const team = clean(p.department) || clean(p.division) || clean(p.division_code);
  addUser(code, p.name, team, RANK_HR);
}
const hrCodes = new Set([...users.keys()]);

// ============================================================
// DEVICES
// ============================================================
const devices = new Map();      // serial -> device object
const usedBarcodes = new Set();

// be/import_real.py reads every column by direct key access (d["cpu"]), so each
// row must carry all of them even when the source sheet has no such column.
const DEVICE_KEYS = ['barcode', 'type', 'brand', 'cpu', 'ram', 'storage', 'os',
                     'msoffice', 'buy_date', 'name', 'user_id', 'status'];
const fullRow = (obj) => Object.fromEntries(DEVICE_KEYS.map((k) => [k, obj[k] ?? null]));

function putDevice(serial, obj) {
  const s = cut(clean(serial), 100);
  if (!s) return null;
  // barcode uniqueness
  let bc = cut(clean(obj.barcode), 100);
  if (bc && usedBarcodes.has(bc)) bc = null;
  const existing = devices.get(s);
  if (!existing) {
    if (bc) usedBarcodes.add(bc);
    devices.set(s, { ...fullRow(obj), serial_number: s, barcode: bc });
  } else {
    // merge: fill blanks only (first sheet wins for populated fields)
    for (const k of Object.keys(obj)) {
      if ((existing[k] == null || existing[k] === '') && obj[k] != null && obj[k] !== '') {
        if (k === 'barcode') {
          if (bc && !existing.barcode) { existing.barcode = bc; usedBarcodes.add(bc); }
        } else existing[k] = obj[k];
      }
    }
  }
  return s;
}

// --- 1) Device code master (catalog, includes in-stock) ---
// cols: 0 serial,1 devcode,2 mgmt,3 barcode,4 type,5 brand,6 cpu,7 ram,8 ssd/hdd,9 os,10 office,11 ngày mua
const mgmtToSerial = new Map();
for (const r of rowsOf('Device code').slice(1)) {
  const serial = clean(r[0]) || clean(r[1]);
  if (!serial) continue;
  // Index BOTH code columns: col 2 is the management code (YOL-001) but the
  // Maintenance sheet's "MGMT Code" actually holds the device code (YIC-Laptop-004),
  // which lives in col 1.
  for (const codeCol of [r[1], r[2]]) {
    if (clean(codeCol)) mgmtToSerial.set(clean(codeCol).toUpperCase(), serial);
  }
  putDevice(serial, {
    barcode: r[3],
    type: cut(clean(r[4]), 100),
    brand: cut(clean(r[5]), 100),
    cpu: cut(clean(r[6]), 100),
    ram: cut(clean(r[7]), 100),
    storage: cut(clean(r[8]), 100),
    os: cut(clean(r[9]), 100),
    msoffice: cut(clean(r[10]), 100),
    buy_date: parseDotDate(r[11]),
    name: deviceName(r[5], r[6], r[7], r[4]),
    user_id: GHOST,
    status: 'in_stock',
  });
}

// --- 2) "Device code" trailing asset register (cols 14 no,15 sn,16 date,17 name) ---
// An independent purchase log sharing that sheet — its rows do NOT line up with
// the catalog on the left. Runs AFTER the catalog on purpose: 61 of these
// serials are laptops already in it, and putDevice's blanks-only merge only
// leaves their type/specs intact if they were populated first.
const ACCESSORY_RE = /hdmi|ssd|ram |bàn phím|keyboard|chuột|mouse|cable|cáp|dock|adapter|usb|hub|ipad/i;
const assetType = (name) => {
  if (!name) return null;
  if (ACCESSORY_RE.test(name)) return 'ACCESSORY';   // before MONITOR: "Ipad 11-inch", "SSD 512GB"
  if (/monitor|màn hình/i.test(name)) return 'MONITOR';
  if (/specs PC|^PC\b/i.test(name)) return 'DESKTOP';
  return 'LAPTOP';
};
let assetRows = 0;
// Serials from this register are the *verified* ones: cell L2 of the sheet is
// VLOOKUP(A2,$P$2:$Q$221,2,0), i.e. the catalog on the left looks its own serial
// up in here to fetch a purchase date. 123 catalog rows come back #N/A and not
// one of those serials is in this register — so this column is the list that has
// actually been checked against a purchase record.
const registerSerials = [];
for (const r of rowsOf('Device code').slice(1)) {
  const sn = clean(r[15]);
  if (!sn) continue;
  const label = clean(r[17]);
  registerSerials.push(cut(sn, 100));
  assetRows++;
  putDevice(sn, {
    type: assetType(label),
    brand: brandIn(label),
    buy_date: parseDotDate(r[16]),
    name: cut(label, 100),
    user_id: GHOST,
    status: 'in_stock',
  });
}

// ============================================================
// HANDOVERS
// cols: 0 no,1 date,2 device,3 serial,4 from name,5 from code,6 to name,7 to code,8 reason,9 remark
// ============================================================
// Read in two passes. The first collects the rows and every serial they mention;
// the second emits the records. In between, any serial the catalog never listed
// becomes a stub device — otherwise its handover would insert a dangling FK, or
// (as the old code did) silently drop to device_id = NULL and lose the link.
const rawHandovers = [];
for (const r of rowsOf('Handover History').slice(1)) {
  // Like Maintenance, this sheet is padded with numbered but empty rows (232+).
  if (![r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]].some((v) => clean(v))) continue;
  rawHandovers.push({
    no: clean(r[0]),
    date: parseDotDate(r[1]),
    label: clean(r[2]),
    serials: splitSerials(r[3]),
    // This sheet pairs a full Vietnamese name with that person's own code in
    // adjacent cells — the only workbook source still trusted for names.
    from: addUser(r[5], r[4], null, RANK_HANDOVER),
    to: addUser(r[7], r[6], null, RANK_HANDOVER),
    reason: cut(clean(r[8]), 100),
  });
}

// --- 3) reconcile handover serials, then stub whatever is left ---
// A handover serial one character off a *register* serial is a typo: the
// register is the checked list, so the register spelling wins and the handover
// attaches to the real machine instead of conjuring a duplicate.
//
// Deliberately NOT done against the left-hand catalog. Nine more handover
// serials sit one character from a catalog entry, but HP ships in batches and
// "5CD3307YZ3" vs "5CD3307YL3" can be two real machines. Unverifiable, so those
// are left alone and reported.
const editDistanceAtMostOne = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, slack = 1;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (!slack--) return false;
    if (short.length === long.length) i++;
    j++;
  }
  return true;
};

const serialFixes = new Map(); // handover spelling -> register spelling
function canonicalSerial(raw) {
  const key = cut(raw, 100);
  if (!key || devices.has(key)) return key;
  if (serialFixes.has(key)) return serialFixes.get(key);
  const hit = registerSerials.find((r) => editDistanceAtMostOne(key.toUpperCase(), r.toUpperCase()));
  if (hit) serialFixes.set(key, hit);
  return hit ?? key;
}

for (const h of rawHandovers) h.serials = h.serials.map(canonicalSerial);

const stubSerials = [];
for (const h of rawHandovers) {
  for (const key of h.serials) {
    if (devices.has(key)) continue;
    stubSerials.push({ serial: key, label: h.label, no: h.no });
    putDevice(key, {
      type: assetType(h.label),
      brand: brandIn(h.label),
      name: cut(h.label ?? key, 100),
      user_id: GHOST,
      status: 'in_stock',
    });
  }
}

const serialSet = new Set(devices.keys());

// One record per (row, serial): a row handing over a laptop AND its monitor is
// two movements. The old build kept only split('/')[0] and threw the rest away.
const handovers = [];
const seenHo = new Set();
let hoDeviceResolved = 0;
let hoNoSerial = 0;
for (const h of rawHandovers) {
  const targets = h.serials.length ? h.serials : [null];
  targets.forEach((serial, i) => {
    const base = `HO-${h.no ?? handovers.length + 1}`;
    const id = i === 0 ? base : `${base}-${i + 1}`;
    if (seenHo.has(id)) return;
    seenHo.add(id);
    const deviceId = serial && serialSet.has(cut(serial, 100)) ? cut(serial, 100) : null;
    if (deviceId) hoDeviceResolved++; else hoNoSerial++;
    handovers.push({
      handover_id: cut(id, 100),
      handover_date: h.date,
      device_id: deviceId,
      from_user_id: h.from,
      to_user_id: h.to,
      reason: h.reason,
    });
  });
}

// --- derive each device's current owner from its last handover ---
// The workbook no longer states who holds what, so the chain decides: the
// person who received a device most recently still has it. Dates are
// day-granular, so ties fall back to the sheet's own NO ordinal — later row,
// later movement. A device nobody was ever handed stays in the IT store.
const ordinalOf = new Map(rawHandovers.map((h, i) => [h.no ?? String(i), i]));
const latest = new Map(); // serial -> {date, seq, to}
for (const h of handovers) {
  if (!h.device_id || !h.to_user_id) continue;
  const seq = ordinalOf.get(h.handover_id.replace(/^HO-/, '').replace(/-\d+$/, '')) ?? 0;
  const prev = latest.get(h.device_id);
  const key = [h.handover_date ?? '', seq];
  if (!prev || key[0] > prev.date || (key[0] === prev.date && key[1] >= prev.seq)) {
    latest.set(h.device_id, { date: key[0], seq, to: h.to_user_id });
  }
}
let derivedOwners = 0;
for (const d of devices.values()) {
  const hit = latest.get(d.serial_number);
  d.user_id = hit ? hit.to : GHOST;
  d.status = statusFor(d.user_id);
  if (hit) derivedOwners++;
}

// ============================================================
// MAINTENANCE
// cols: 0 no,1 date(excel serial),2 mgmt code,3 team,4 part,5 reason,6 solution,7 result,8 cost,9 remarks
// ============================================================
const maintenance = [];
let mxDeviceResolved = 0;
for (const r of rowsOf('Maintenance').slice(1)) {
  // The sheet ends with 6 blank numbered rows and a "TOTAL" summary row (which
  // carries only a cost). Keep only rows with actual repair content.
  if (![r[1], r[2], r[4], r[5], r[6], r[7]].some((v) => clean(v))) continue;
  const no = clean(r[0]);
  const mgmt = clean(r[2]);
  let deviceId = null;
  if (mgmt) {
    const key = mgmt.toUpperCase();
    if (mgmtToSerial.has(key) && serialSet.has(cut(mgmtToSerial.get(key), 100)))
      deviceId = cut(mgmtToSerial.get(key), 100);
    else if (serialSet.has(cut(mgmt, 100))) deviceId = cut(mgmt, 100);
  }
  if (deviceId) mxDeviceResolved++;
  maintenance.push({
    maintenance_id: cut(`MX-${no ?? maintenance.length + 1}`, 100),
    maintenance_date: parseExcelDate(r[1]),
    device_id: deviceId,
    team: cut(clean(r[3]), 100),
    part: cut(clean(r[4]), 200),
    reason: cut(clean(r[5]), 500),
    solution: cut(clean(r[6]), 500),
    result: cut(clean(r[7]), 500),
    cost_vnd: parseMoney(r[8]),
    remarks: cut(clean(r[9]), 500),
  });
}

// ============================================================
// OUTPUT
// ============================================================
// All sources are in — now settle each code's name from its ranked candidates.
const { conflicts: nameConflicts, variants: nameVariants, ruled } = resolveNames();

const usersArr = [...users.values()].map(({ employee_code, name, team }) => ({ employee_code, name, team }));
const devicesArr = [...devices.values()];
const userDevices = devicesArr
  .filter((d) => d.user_id && d.user_id !== GHOST)
  .map((d) => ({ user_id: d.user_id, device_id: d.serial_number }));

const out = { users: usersArr, devices: devicesArr, handovers, maintenance, user_devices: userDevices };
writeFileSync(join(__dirname, 'import_data.json'), JSON.stringify(out, null, 2), 'utf8');

// Machine-readable twin of the name report printed below. Kept OUT of
// import_data.json so that file stays exactly the shape import_real.py reads.
// be/fix_user_names.py uses `conflicts` as its do-not-touch list.
writeFileSync(
  join(__dirname, 'import_names_report.json'),
  JSON.stringify({
    conflicts: nameConflicts.map(({ code, cands }) => ({ code, candidates: cands })),
    variants: nameVariants.map(({ code, cands }) => ({ code, candidates: cands })),
    missing: [...users.keys()]
      .filter((c) => c !== GHOST && !users.get(c).name)
      .map((c) => ({ code: c, nickname: nicknames.get(c) ?? null })),
  }, null, 2),
  'utf8',
);

// ---- report ----
const statusCounts = {};
for (const d of devicesArr) statusCounts[d.status] = (statusCounts[d.status] ?? 0) + 1;
const typeCounts = {};
for (const d of devicesArr) typeCounts[d.type ?? '(none)'] = (typeCounts[d.type ?? '(none)'] ?? 0) + 1;
const missingKeys = devicesArr.filter((d) => DEVICE_KEYS.some((k) => !(k in d))).length;
const handoverOnly = usersArr.filter((u) => !hrCodes.has(u.employee_code) && u.employee_code !== GHOST);
console.log('== IMPORT BUILD SUMMARY ==');
console.log('users        :', usersArr.length, '(incl. IT-STORE ghost)',
            ' from HR:', hrStaff.length,
            ' handover-only:', handoverOnly.length,
            ' with name:', usersArr.filter((u) => u.name).length,
            ' no team:', usersArr.filter((u) => !u.team).length);
console.log('devices      :', devicesArr.length, ' status:', JSON.stringify(statusCounts));
console.log('  by type    :', JSON.stringify(typeCounts));
console.log('  asset-register rows read:', assetRows, ' rows missing a column:', missingKeys);
console.log('  owner derived from a handover:', derivedOwners,
            ' left in the IT store:', devicesArr.filter((d) => d.user_id === GHOST).length);
console.log('  with barcode:', devicesArr.filter((d) => d.barcode).length, ' with buy_date:', devicesArr.filter((d) => d.buy_date).length);
console.log('handovers    :', handovers.length, 'from', rawHandovers.length, 'sheet rows',
            ' device resolved:', hoDeviceResolved, ' no serial:', hoNoSerial,
            ' with date:', handovers.filter((h) => h.handover_date).length);
console.log('maintenance  :', maintenance.length, ' device resolved:', mxDeviceResolved, ' with date:', maintenance.filter((m) => m.maintenance_date).length);
console.log('user_devices :', userDevices.length);
console.log('\nSample device:', JSON.stringify(devicesArr[0]));
console.log('Sample handover:', JSON.stringify(handovers[0]));
console.log('Sample maintenance:', JSON.stringify(maintenance[0]));

// ---- rows invented from the handover sheet, for a human to eyeball ----
console.log(`\n== PEOPLE FROM HANDOVER ONLY (${handoverOnly.length}) — not in the HR export ==`);
for (const u of handoverOnly) console.log(`  ${u.employee_code.padEnd(12)} ${JSON.stringify(u.name)}`);

console.log(`\n== SERIALS CORRECTED AGAINST THE PURCHASE REGISTER (${serialFixes.size}) ==`);
for (const [typo, real] of serialFixes) console.log(`  ${typo.padEnd(20)} -> ${real}`);

console.log(`\n== DEVICES FROM HANDOVER ONLY (${stubSerials.length}) — serial in no catalog;`
            + ` some may still be typos of an unverified catalog entry ==`);
for (const s of stubSerials) console.log(`  row ${String(s.no).padEnd(4)} ${s.serial.padEnd(20)} ${JSON.stringify(s.label)}`);

if (ruled.length) {
  console.log(`\n== HUMAN RULINGS APPLIED (${ruled.length}) — override every source ==`);
  for (const r of ruled) console.log(`  ${r.code.padEnd(12)} ${JSON.stringify(r.was)} -> ${JSON.stringify(r.now)}`);
}

// ---- referential self-check: these are FK inserts, they must resolve ----
const userCodes = new Set(usersArr.map((u) => u.employee_code));
const badOwner = devicesArr.filter((d) => d.user_id && !userCodes.has(d.user_id));
const badHoDev = handovers.filter((h) => h.device_id && !serialSet.has(h.device_id));
const badHoUser = handovers.filter((h) =>
  (h.from_user_id && !userCodes.has(h.from_user_id)) || (h.to_user_id && !userCodes.has(h.to_user_id)));
const badMxDev = maintenance.filter((m) => m.device_id && !serialSet.has(m.device_id));
console.log('\n== FK PRE-CHECK ==');
console.log('  devices with an unknown owner   :', badOwner.length);
console.log('  handovers with an unknown device:', badHoDev.length);
console.log('  handovers with an unknown person:', badHoUser.length);
console.log('  maintenance with unknown device :', badMxDev.length);
if (badOwner.length || badHoDev.length || badHoUser.length || badMxDev.length) {
  console.log('  FAIL — import_real.py would abort on a foreign key violation.');
  process.exitCode = 1;
}

// ---- names needing a human ----
// Printed, never guessed: the workbook itself disagrees on these.
const RANK_LABEL = { [RANK_HR]: 'HR', [RANK_HANDOVER]: 'handover' };
console.log(`\n== NAME CONFLICTS (${nameConflicts.length}) — one code claimed by two DIFFERENT people. Needs a human; do not trust the pick ==`);
for (const { code, cands } of nameConflicts) {
  const shown = cands.map((c, i) =>
    `${i === 0 ? 'used   ' : 'ignored'} "${c.name}" (${RANK_LABEL[c.rank] ?? c.rank})`);
  console.log(' ', code, '->', shown.join('  |  '));
}

console.log(`\n== spelling variants merged (${nameVariants.length}) — same person, higher-trust spelling kept ==`);
for (const { code, cands } of nameVariants) {
  console.log(' ', code, '->', `"${cands[0].name}"`, 'over', cands.slice(1).map((c) => `"${c.name}"`).join(', '));
}

const missing = usersArr
  .filter((u) => !u.name && u.employee_code !== GHOST)
  .map((u) => u.employee_code + (nicknames.has(u.employee_code) ? ` (${nicknames.get(u.employee_code)})` : ''));
console.log(`\n== MISSING NAMES (${missing.length}) — nickname only in the workbook, so no name stored ==`);
console.log(' ', missing.join(', ') || '(none)');

// ---- self-check: the two rows this rewrite exists to fix ----
const nameOf = (c) => users.get(c)?.name ?? null;
const EXPECT = { VPHN216: 'Nguyễn Minh Quân', VPHN260: 'Nguyễn Đức Minh' };
console.log('\n== SELF-CHECK ==');
let ok = true;
for (const [code, want] of Object.entries(EXPECT)) {
  const got = nameOf(code);
  const pass = got === want;
  if (!pass) ok = false;
  console.log(` ${pass ? 'PASS' : 'FAIL'} ${code}: expected "${want}", got ${JSON.stringify(got)}`);
}
const junk = usersArr.filter((u) => u.name && /\b(don't|dont|need|use|pc|máy|cũ|của|có|màn|team|vga|monitor)\b/i.test(u.name));
if (junk.length) {
  ok = false;
  console.log(' FAIL note-as-name still present:', junk.map((u) => `${u.employee_code}="${u.name}"`).join(', '));
} else {
  console.log(' PASS no user name looks like a note');
}
if (!ok) process.exitCode = 1;
