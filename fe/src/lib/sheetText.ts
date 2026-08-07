// Flatten a spreadsheet into the text the handover-minutes reader is given.
//
// A handover record is a FORM, not a table: labels in one cell, values in the cell
// to the right, merged title blocks, and one small item table in the middle. So it
// is flattened row by row with the row index kept, which is enough for the model to
// tell "the cell right of `Bên A/ Party A:`" from "a cell somewhere else".
//
// Only ~30 rows of text go to the server — the workbook itself never leaves the
// browser, unlike a PDF or a photo, which has to be uploaded to be extracted.
import * as XLSX from "xlsx";

/**
 * Date cells carry their ISO value in brackets after the displayed text:
 *
 *   5 |  |  |  | Tuesday, July 21, 2026 [2026-07-21]
 *
 * That is what makes the date verifiable the same way as every other value: the
 * server only keeps what it can find in this text, and "2026-07-21" would appear
 * nowhere if we sent the display string alone. Without it, a real date would be
 * thrown out as invented.
 */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const shown = String(cell.w ?? cell.v ?? "").replace(/\s+/g, " ").trim();
  if (!shown) return "";
  if (cell.t === "d" && cell.v instanceof Date) {
    const iso = new Date(
      cell.v.getTime() - cell.v.getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 10);
    return `${shown} [${iso}]`;
  }
  return shown;
}

/** Flatten one worksheet to `idx | cell | cell` lines, skipping empty rows. */
export function sheetToText(sheet: XLSX.WorkSheet): string {
  const ref = sheet["!ref"];
  if (!ref) return "";
  const range = XLSX.utils.decode_range(ref);
  const lines: string[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      cells.push(
        cellText(sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject),
      );
    }
    // Trailing blanks carry no information and a handover form is mostly blank.
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.some((v) => v !== "")) {
      lines.push(`${String(r + 1).padStart(3)} | ${cells.join(" | ")}`);
    }
  }
  return lines.join("\n");
}

/** Read a picked workbook file and flatten its first sheet. */
export async function fileToSheetText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Workbook has no sheet");
  return sheetToText(sheet);
}
