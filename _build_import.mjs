// Reads REAL-DATA.xlsx, cleans the noisy real data, and writes a DB-ready
// import_data.json (users / devices / handovers / maintenance / user_devices).
import * as XLSX from './fe/node_modules/xlsx/xlsx.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wb = XLSX.read(readFileSync(join(__dirname, 'REAL-DATA.xlsx')), { type: 'buffer' });
const rowsOf = (name) =>
  XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, blankrows: false });

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

const STATUS_MAP = {
  'active': 'active',
  'in repair': 'maintaining',
  'no need user': 'in_stock',
  'storage': 'in_stock',
  'resigned': 'in_stock',
};
const mapStatus = (v, hasOwner) => {
  const s = clean(v);
  if (s && STATUS_MAP[s.toLowerCase()]) return STATUS_MAP[s.toLowerCase()];
  return hasOwner ? 'active' : 'in_stock';
};

const deviceName = (brand, cpu, ram, type) =>
  cut([clean(brand), clean(cpu), clean(ram)].filter(Boolean).join(' ') || clean(type), 100);

// ============================================================
// USERS  (built as we discover codes; first non-null team wins)
// ============================================================
const users = new Map(); // code -> {employee_code, name, team}
function addUser(code, name, team) {
  const c = empCode(code);
  if (!c) return null;
  const existing = users.get(c);
  if (!existing) {
    users.set(c, { employee_code: cut(c, 100), name: cut(clean(name), 100), team: cut(clean(team), 100) });
  } else {
    if (!existing.name && clean(name)) existing.name = cut(clean(name), 100);
    if (!existing.team && clean(team)) existing.team = cut(clean(team), 100);
  }
  return c;
}
users.set(GHOST, { employee_code: GHOST, name: 'IT Store', team: 'IT' });

// ============================================================
// DEVICES
// ============================================================
const devices = new Map();      // serial -> device object
const usedBarcodes = new Set();

function putDevice(serial, obj) {
  const s = cut(clean(serial), 100);
  if (!s) return null;
  // barcode uniqueness
  let bc = cut(clean(obj.barcode), 100);
  if (bc && usedBarcodes.has(bc)) bc = null;
  const existing = devices.get(s);
  if (!existing) {
    if (bc) usedBarcodes.add(bc);
    devices.set(s, { ...obj, serial_number: s, barcode: bc });
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
  if (clean(r[2])) mgmtToSerial.set(clean(r[2]).toUpperCase(), serial);
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

// --- 2) Devices sheet (assigned, authoritative for owner/status) ---
// cols: 1 status,2 division,3 team/acct,4 name,5 empcode,6 type,7 brand,8 cpu,9 ram,10 storage,
//       11 os,12 office,13 serial,14 mgmt,15 barcode,16 pc purchase date
for (const r of rowsOf('Devices').slice(1)) {
  const serial = clean(r[13]) || clean(r[14]); // fall back to MGMT code as serial
  if (!serial) continue;
  if (clean(r[14])) mgmtToSerial.set(clean(r[14]).toUpperCase(), serial);
  const code = addUser(r[5], r[4], r[2]); // team = Division
  const owner = code || GHOST;
  const dev = {
    barcode: r[15],
    type: cut(clean(r[6]), 100),
    brand: cut(clean(r[7]), 100),
    cpu: cut(clean(r[8]), 100),
    ram: cut(clean(r[9]), 100),
    storage: cut(clean(r[10]), 100),
    os: cut(clean(r[11]), 100),
    msoffice: cut(clean(r[12]), 100),
    buy_date: parseDotDate(r[16]),
    name: deviceName(r[7], r[8], r[9], r[6]),
    user_id: owner,
    status: mapStatus(r[1], !!code),
  };
  // The Devices sheet is the current state: override owner+status even if the
  // device already exists from the catalog.
  const existing = devices.get(cut(serial, 100));
  if (existing) {
    existing.user_id = owner;
    existing.status = dev.status;
    for (const k of ['type', 'brand', 'cpu', 'ram', 'storage', 'os', 'msoffice', 'name']) {
      if (dev[k]) existing[k] = dev[k];
    }
    if (dev.buy_date && !existing.buy_date) existing.buy_date = dev.buy_date;
    let bc = cut(clean(dev.barcode), 100);
    if (bc && !existing.barcode && !usedBarcodes.has(bc)) { existing.barcode = bc; usedBarcodes.add(bc); }
  } else {
    putDevice(serial, dev);
  }
}

const serialSet = new Set(devices.keys());

// ============================================================
// HANDOVERS
// cols: 0 no,1 date,2 device,3 serial,4 from name,5 from code,6 to name,7 to code,8 reason,9 remark
// ============================================================
const handovers = [];
const seenHo = new Set();
let hoDeviceResolved = 0;
for (const r of rowsOf('Handover History').slice(1)) {
  const no = clean(r[0]);
  const id = `HO-${no ?? handovers.length + 1}`;
  if (seenHo.has(id)) continue;
  seenHo.add(id);
  const from = addUser(r[5], r[4], null);
  const to = addUser(r[7], r[6], null);
  const firstSerial = clean(r[3]) ? clean(r[3]).split('/')[0].trim() : null;
  const deviceId = firstSerial && serialSet.has(cut(firstSerial, 100)) ? cut(firstSerial, 100) : null;
  if (deviceId) hoDeviceResolved++;
  handovers.push({
    handover_id: cut(id, 100),
    handover_date: parseDotDate(r[1]),
    device_id: deviceId,
    from_user_id: from,
    to_user_id: to,
    reason: cut(clean(r[8]), 100),
  });
}

// ============================================================
// MAINTENANCE
// cols: 0 no,1 date(excel serial),2 mgmt code,3 team,4 part,5 reason,6 solution,7 result,8 cost,9 remarks
// ============================================================
const maintenance = [];
let mxDeviceResolved = 0;
for (const r of rowsOf('Maintenance').slice(1)) {
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
const usersArr = [...users.values()];
const devicesArr = [...devices.values()];
const userDevices = devicesArr
  .filter((d) => d.user_id && d.user_id !== GHOST)
  .map((d) => ({ user_id: d.user_id, device_id: d.serial_number }));

const out = { users: usersArr, devices: devicesArr, handovers, maintenance, user_devices: userDevices };
writeFileSync(join(__dirname, 'import_data.json'), JSON.stringify(out, null, 2), 'utf8');

// ---- report ----
const statusCounts = {};
for (const d of devicesArr) statusCounts[d.status] = (statusCounts[d.status] ?? 0) + 1;
console.log('== IMPORT BUILD SUMMARY ==');
console.log('users        :', usersArr.length, '(incl. IT-STORE ghost)');
console.log('devices      :', devicesArr.length, ' status:', JSON.stringify(statusCounts));
console.log('  with owner :', devicesArr.filter((d) => d.user_id !== GHOST).length);
console.log('  with barcode:', devicesArr.filter((d) => d.barcode).length, ' with buy_date:', devicesArr.filter((d) => d.buy_date).length);
console.log('handovers    :', handovers.length, ' device resolved:', hoDeviceResolved, ' with date:', handovers.filter((h) => h.handover_date).length);
console.log('maintenance  :', maintenance.length, ' device resolved:', mxDeviceResolved, ' with date:', maintenance.filter((m) => m.maintenance_date).length);
console.log('user_devices :', userDevices.length);
console.log('\nSample device:', JSON.stringify(devicesArr[0]));
console.log('Sample handover:', JSON.stringify(handovers[0]));
console.log('Sample maintenance:', JSON.stringify(maintenance[0]));
