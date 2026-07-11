import { useRef, useState } from "react";
import { Button, Table, Alert } from "antd";
import type { TableColumnsType } from "antd";
import * as XLSX from "xlsx";
import { toast } from "react-toastify";
import { importDevices } from "../../api/devices";
import { ApiError } from "../../api/client";
import type { DeviceCreate, DeviceStatus } from "../../types";
import { DEVICE_STATUS_ORDER } from "../../types";
import { UploadIcon } from "../icons";
import { Modal } from "./Modal";

// Normalize a spreadsheet header ("Serial Number", "serial_number", "SN") to a
// comparable key so column order / casing / punctuation don't matter.
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

// Accepted header aliases → device field. Extend freely.
const HEADER_ALIASES: Record<string, keyof DeviceCreate> = {
  serialnumber: "serial_number", serial: "serial_number", sn: "serial_number",
  serialno: "serial_number",
  barcode: "barcode",
  type: "type", devicetype: "type",
  brand: "brand", manufacturer: "brand",
  cpu: "cpu", processor: "cpu",
  ram: "ram", memory: "ram",
  storage: "storage", disk: "storage", ssd: "storage", hdd: "storage",
  os: "os", operatingsystem: "os",
  msoffice: "msoffice", office: "msoffice",
  buydate: "buy_date", purchasedate: "buy_date", date: "buy_date",
  name: "name", devicename: "name",
  userid: "user_id", owner: "user_id", user: "user_id",
  employee: "user_id", employeecode: "user_id",
  status: "status",
};

const STATUSES = new Set<string>(DEVICE_STATUS_ORDER);

function toIsoDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  // Already ISO.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YYYY or DD-MM-YYYY → YYYY-MM-DD.
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const yyyy = y.length === 2 ? `20${y}` : y;
    return `${yyyy}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

function clean(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

// Map one raw spreadsheet row (header→cell) to a DeviceCreate.
function rowToDevice(raw: Record<string, unknown>): DeviceCreate | null {
  const out: Partial<Record<keyof DeviceCreate, unknown>> = {};
  for (const [header, cell] of Object.entries(raw)) {
    const field = HEADER_ALIASES[norm(header)];
    if (field) out[field] = cell;
  }
  const serial = clean(out.serial_number);
  if (!serial) return null; // serial_number is required — skip the row.

  const status = clean(out.status)?.toLowerCase();
  return {
    serial_number: serial,
    barcode: clean(out.barcode),
    type: clean(out.type),
    brand: clean(out.brand),
    cpu: clean(out.cpu),
    ram: clean(out.ram),
    storage: clean(out.storage),
    os: clean(out.os),
    msoffice: clean(out.msoffice),
    buy_date: toIsoDate(out.buy_date),
    name: clean(out.name),
    user_id: clean(out.user_id), // null → unassigned (avoids FK errors on import)
    status: (status && STATUSES.has(status) ? status : "in_stock") as DeviceStatus,
  };
}

export function ImportDevicesModal({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<DeviceCreate[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parseFile = async (file: File) => {
    setError(null);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: null,
      });
      const parsed = raw.map(rowToDevice);
      const valid = parsed.filter((d): d is DeviceCreate => d !== null);
      setRows(valid);
      setSkipped(parsed.length - valid.length);
      if (!valid.length) {
        setError(
          'No valid rows found. Ensure there is a "Serial Number" column.',
        );
      }
    } catch (e) {
      setError("Could not read that file. Use a .xlsx, .xls or .csv export.");
      setRows([]);
      setSkipped(0);
      console.error(e);
    }
  };

  const handleImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await importDevices(rows);
      toast.success(
        `Imported ${res.inserted} device${res.inserted === 1 ? "" : "s"}` +
          (res.skipped ? ` · ${res.skipped} already existed` : ""),
      );
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumnsType<DeviceCreate> = [
    { title: "Serial", dataIndex: "serial_number", key: "serial_number" },
    { title: "Name", dataIndex: "name", key: "name", render: (v) => v || "—" },
    { title: "Type", dataIndex: "type", key: "type", render: (v) => v || "—" },
    { title: "Brand", dataIndex: "brand", key: "brand", render: (v) => v || "—" },
    { title: "Owner", dataIndex: "user_id", key: "user_id", render: (v) => v || "—" },
    { title: "Status", dataIndex: "status", key: "status" },
  ];

  return (
    <Modal title="Import Devices" onClose={onClose}>
      <div className="modal-form">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) parseFile(f);
            e.target.value = ""; // allow re-selecting the same file
          }}
        />

        <div className="import-drop">
          <Button icon={<UploadIcon size={16} />} onClick={() => inputRef.current?.click()}>
            Choose .xlsx / .csv
          </Button>
          <span className="import-hint">
            {fileName ?? "Needs a Serial Number column; other columns are matched by name."}
          </span>
        </div>

        {error && <Alert type="error" showIcon message={error} />}

        {rows.length > 0 && (
          <>
            <p className="import-summary">
              <b>{rows.length}</b> device{rows.length === 1 ? "" : "s"} ready to import
              {skipped > 0 && (
                <span className="text-faint"> · {skipped} row(s) skipped (no serial)</span>
              )}
            </p>
            <div className="table-wrap import-preview">
              <Table<DeviceCreate>
                rowKey="serial_number"
                size="small"
                columns={columns}
                dataSource={rows}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
              />
            </div>
          </>
        )}

        <div className="modal-actions">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="primary"
            icon={<UploadIcon size={16} />}
            disabled={rows.length === 0}
            loading={busy}
            onClick={handleImport}
          >
            Import {rows.length || ""}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
