import { useEffect, useRef, useState } from "react";
import { Button, Table, Alert } from "antd";
import type { TableColumnsType } from "antd";
import * as XLSX from "xlsx";
import { toast } from "react-toastify";
import { importDevices } from "../../api/devices";
import { ApiError } from "../../api/client";
import type { DeviceCreate, DeviceStatus } from "../../types";
import { DEVICE_STATUS_ORDER, DEVICE_STATUS_META } from "../../types";
import { clean, norm, toIsoDate } from "../../lib/importHeaders";
import { UploadIcon } from "../icons";
import { Modal } from "./Modal";
import { useT } from "../../i18n/useT";

// Accepted header aliases → device field. Extend freely. `norm` folds diacritics,
// so Vietnamese column names can be listed the way people actually type them.
const HEADER_ALIASES: Record<string, keyof DeviceCreate> = {
  serialnumber: "serial_number", serial: "serial_number", sn: "serial_number",
  serialno: "serial_number", soserial: "serial_number",
  barcode: "barcode",
  type: "type", devicetype: "type", loai: "type", loaithietbi: "type",
  brand: "brand", manufacturer: "brand", hang: "brand", hangsanxuat: "brand",
  cpu: "cpu", processor: "cpu",
  ram: "ram", memory: "ram",
  storage: "storage", disk: "storage", ssd: "storage", hdd: "storage",
  ocung: "storage",
  os: "os", operatingsystem: "os", hedieuhanh: "os",
  msoffice: "msoffice", office: "msoffice",
  buydate: "buy_date", purchasedate: "buy_date", date: "buy_date",
  ngaymua: "buy_date",
  name: "name", devicename: "name", tenmay: "name", tenthietbi: "name",
  userid: "user_id", owner: "user_id", user: "user_id",
  employee: "user_id", employeecode: "user_id",
  nguoisudung: "user_id", nguoidung: "user_id", manv: "user_id",
  status: "status", trangthai: "status", tinhtrang: "status",
};

const STATUSES = new Set<string>(DEVICE_STATUS_ORDER);

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

export function ImportDevicesModal({
  onClose,
  onDone,
  file,
  embedded = false,
  queueLabel,
}: {
  onClose: () => void;
  onDone?: (summary?: string) => void;
  /** Pre-picked file (from the auto-detecting ImportModal) — skips the picker. */
  file?: File;
  /** Rendered inside the import queue rather than as its own dialog. */
  embedded?: boolean;
  queueLabel?: string;
}) {
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(file?.name ?? null);
  const [rows, setRows] = useState<DeviceCreate[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parseFile = async (picked: File) => {
    setError(null);
    setFileName(picked.name);
    try {
      const buf = await picked.arrayBuffer();
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
          t("sheet.device.noRows"),
        );
      }
    } catch (e) {
      setError(t("sheet.unreadable"));
      setRows([]);
      setSkipped(0);
      console.error(e);
    }
  };

  useEffect(() => {
    // The file identity is the trigger; `parseFile` is recreated every render, so
    // depending on it would re-parse on every keystroke elsewhere.
    //
    // parseFile clears the previous rows and error before it starts reading, which
    // is a synchronous setState the compiler rule flags. It is the right thing
    // here: a new file arriving from outside this component IS the event, and the
    // stale result of the last one must not stay on screen while the new one
    // parses. There is nothing to derive it from — the parse output is not a
    // function of the props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (file) parseFile(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const handleImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await importDevices(rows);
      const summary = t(
        res.skipped ? "sheet.device.done.skipped" : "sheet.device.done",
        { n: res.inserted, skipped: res.skipped },
      );
      // In a bulk run the queue reports every file at the end — see the same note
      // in ImportMaintenanceModal.
      if (!embedded) toast.success(summary);
      onDone?.(summary);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("sheet.failed"));
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumnsType<DeviceCreate> = [
    { title: t("sheet.col.serial"), dataIndex: "serial_number", key: "serial_number" },
    { title: t("sheet.col.name"), dataIndex: "name", key: "name", render: (v) => v || "—" },
    { title: t("sheet.col.type"), dataIndex: "type", key: "type", render: (v) => v || "—" },
    { title: t("sheet.col.brand"), dataIndex: "brand", key: "brand", render: (v) => v || "—" },
    { title: t("sheet.col.owner"), dataIndex: "user_id", key: "user_id", render: (v) => v || "—" },
    {
      title: t("sheet.col.status"),
      dataIndex: "status",
      key: "status",
      render: (v: DeviceStatus | null | undefined) =>
        (v && DEVICE_STATUS_META[v]?.label) || v || "—",
    },
  ];

  const body = (
      <div className="modal-form">
        {queueLabel && (
          <div className="import-steps">
            <span className="text-faint">{queueLabel}</span>
          </div>
        )}
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
            {t("sheet.choose")}
          </Button>
          <span className="import-hint">
            {fileName ?? t("sheet.device.hint")}
          </span>
        </div>

        {error && <Alert type="error" showIcon message={error} />}

        {rows.length > 0 && (
          <>
            <p className="import-summary">
              {t("sheet.device.ready", { n: rows.length })}
              {skipped > 0 && (
                <span className="text-faint">
                  {t("sheet.skipped", { n: skipped })}
                </span>
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
            {t(embedded ? "sheet.dropFile" : "sheet.cancel")}
          </Button>
          <Button
            type="primary"
            icon={<UploadIcon size={16} />}
            disabled={rows.length === 0}
            loading={busy}
            onClick={handleImport}
          >
            {t("sheet.import")} {rows.length || ""}
          </Button>
        </div>
      </div>
  );

  if (embedded) return body;
  return (
    <Modal title={t("sheet.device.title")} onClose={onClose} width={860}>
      {body}
    </Modal>
  );
}
