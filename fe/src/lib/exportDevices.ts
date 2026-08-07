// Export the full device list to a formatted .xlsx.
//
// Three things this has to get right, each of which was wrong or missing before.
//
// **It exports the whole ledger, not the current view.** The table is
// server-paginated AND filterable, so an export that reused the screen's query
// gave you whatever happened to be filtered — pick the "Active" chip and you got
// 166 of 327 rows, with nothing in the file saying so. "Export the device list"
// means the list, so this asks for everything and ignores the search box, the
// status chips and the sort. Trashed devices are left out: they are deleted.
//
// **It carries the OWNER, not just the code.** A device row only stores
// `user_id`, so a raw dump reads "VPHN349" and is useless to anyone outside IT.
// Code, name and department go out as three separate columns.
//
// **It is formatted to be read.** Written with exceljs rather than the `xlsx`
// used elsewhere in the app, because SheetJS's community build silently discards
// cell styles on write — you can set a fill and it simply will not be in the
// file. exceljs is loaded dynamically so its ~1 MB never lands in the initial
// bundle; only someone who actually presses Export pays for it.
//
// NOTE: this module must never import the i18n layer. The column headings are
// matched by HEADER_ALIASES when a file is imported back, so translating them
// would break the export→reimport round-trip — and the workbook leaves the app,
// where a shuffled heading is a real problem rather than a joke. Registered in
// i18n/exclusions.ts and enforced by scripts/check-i18n.mjs.
import { pageDevices } from "../api/devices";
import type { Device, DeviceStatus } from "../types";
import { DEVICE_STATUS_META, GHOST_USER_CODE } from "../types";
import type { UserMap } from "./format";

/** Far above the real fleet (a few hundred), low enough to stay one request. */
const MAX_ROWS = 10000;

// The app's own palette (index.css), so the sheet looks like it came from here.
const ACCENT = "FF7C74E8";
const BAND = "FFF7F5FD";
const GRID = "FFECE9F5";

type Align = "left" | "center";

/** Sheet columns, in order. Deliberately human wording, not schema names — this
 * is opened in Excel by people who have never seen the database. */
const COLUMNS: { header: string; width: number; align: Align }[] = [
  { header: "Serial Number", width: 20, align: "center" },
  { header: "Barcode", width: 16, align: "center" },
  { header: "Device Name", width: 30, align: "left" },
  { header: "Type", width: 14, align: "left" },
  { header: "Brand", width: 14, align: "left" },
  { header: "CPU", width: 16, align: "left" },
  { header: "RAM", width: 12, align: "center" },
  { header: "Storage", width: 16, align: "left" },
  { header: "Operating System", width: 20, align: "left" },
  { header: "MS Office", width: 16, align: "left" },
  { header: "Buy Date", width: 13, align: "center" },
  { header: "Status", width: 13, align: "center" },
  { header: "Owner Code", width: 14, align: "center" },
  { header: "Owner Name", width: 24, align: "left" },
  { header: "Owner Department", width: 20, align: "left" },
];

function cells(device: Device, users: UserMap): (string | null)[] {
  const code = device.user_id ?? GHOST_USER_CODE;
  const owner = users[code];
  // The screen's `resolveOwner` fills gaps with display placeholders — the code
  // when the name is unknown, "—" when the team is. Both are wrong in a
  // spreadsheet: a blank cell reads as "not recorded", whereas "VPHN273" under
  // Owner Name reads as somebody's name and "—" sorts as a real department.
  const isGhost = code === GHOST_USER_CODE;
  return [
    device.serial_number,
    device.barcode ?? "",
    device.name ?? "",
    device.type ?? "",
    device.brand ?? "",
    device.cpu ?? "",
    device.ram ?? "",
    device.storage ?? "",
    device.os ?? "",
    device.msoffice ?? "",
    // Left as the ISO string: Excel sorts it correctly and it round-trips back
    // through the importer, which a localised date would not.
    device.buy_date ?? "",
    device.status
      ? (DEVICE_STATUS_META[device.status as DeviceStatus]?.label ?? device.status)
      : "",
    device.user_id ?? "",
    // The ghost account is not a person — leave these empty rather than writing
    // "IT Store" as though someone were holding the machine. Status says it.
    isGhost ? "" : (owner?.name?.trim() ?? ""),
    isGhost ? "" : (owner?.team?.trim() ?? ""),
  ];
}

/** `devices-2026-08-06.xlsx` */
export const exportFilename = (today: string) => `devices-${today}.xlsx`;

function download(buffer: ArrayBuffer, filename: string) {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Fetch every device in the ledger and download it as a formatted workbook.
 * Returns how many rows were written, so the caller can say.
 */
export async function exportDevices(
  users: UserMap,
  today: string,
): Promise<number> {
  // Everything, in a stable order. No `q`, no `status`, no `deleted` — see the
  // note at the top: the file is the ledger, not the current screen.
  const { rows } = await pageDevices({
    limit: MAX_ROWS,
    offset: 0,
    orderBy: "serial_number",
    order: "asc",
  });

  const ExcelJS = (await import("exceljs")).default;
  const book = new ExcelJS.Workbook();
  book.created = new Date();
  const sheet = book.addWorksheet("Devices", {
    // Keep the headings on screen while scrolling three hundred rows.
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  for (const device of rows) sheet.addRow(cells(device, users));

  const lastCol = COLUMNS.length;
  const thin = { style: "thin" as const, color: { argb: GRID } };

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
    cell.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  });

  // Body: per-column alignment, a light band on every other row so the eye can
  // track across fifteen columns, and a grid so it reads as a table.
  for (let r = 2; r <= rows.length + 1; r++) {
    const row = sheet.getRow(r);
    row.height = 18;
    const banded = r % 2 === 0;
    for (let c = 1; c <= lastCol; c++) {
      const cell = row.getCell(c);
      cell.alignment = {
        horizontal: COLUMNS[c - 1].align,
        vertical: "middle",
        wrapText: false,
      };
      cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      if (banded) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
      }
    }
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: lastCol },
  };

  download(await book.xlsx.writeBuffer(), exportFilename(today));
  return rows.length;
}
