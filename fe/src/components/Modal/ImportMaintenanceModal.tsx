// Import repair history from a spreadsheet.
//
// Same shape as ImportDevicesModal — parse in the browser, preview, then post the
// typed rows — with two differences that come from the data:
//
//  * A repair has no natural key. The id is minted here per row, so the SERVER
//    decides what counts as a duplicate: same device, same date, same part
//    (be/repositories/maintenance.import_maintenance). That is what makes a second
//    run of the same file a no-op instead of a second copy of every repair.
//  * A repair must name a device that exists. Rows whose serial is unknown come
//    back counted in `skipped` rather than failing the file, so one bad line in a
//    hundred does not reject the sheet.
import { useEffect, useRef, useState } from "react";
import { Button, Table, Alert } from "antd";
import type { TableColumnsType } from "antd";
import * as XLSX from "xlsx";
import { toast } from "react-toastify";
import { importMaintenance } from "../../api/maintenance";
import { ApiError } from "../../api/client";
import type { MaintenanceCreate } from "../../types";
import { clean, norm, toIsoDate, toNumber } from "../../lib/importHeaders";
import { newId } from "../../lib/id";
import { UploadIcon } from "../icons";
import { Modal } from "./Modal";
import { useT } from "../../i18n/useT";

// Accepted header aliases → maintenance field. Extend freely; the normaliser
// folds diacritics, so Vietnamese names are written the way people type them.
const HEADER_ALIASES: Record<string, keyof MaintenanceCreate> = {
  serial: "device_id", serialnumber: "device_id", sn: "device_id",
  soserial: "device_id", device: "device_id", deviceid: "device_id",
  thietbi: "device_id", may: "device_id",
  date: "maintenance_date", ngay: "maintenance_date",
  ngaysua: "maintenance_date", ngaysuachua: "maintenance_date",
  maintenancedate: "maintenance_date", repairdate: "maintenance_date",
  team: "team", bophan: "team", nhom: "team", doi: "team",
  part: "part", hangmuc: "part", linhkien: "part", bophankiemtra: "part",
  reason: "reason", lydo: "reason", problem: "reason", vande: "reason",
  motavande: "reason", trieuchung: "reason",
  solution: "solution", cachxuly: "solution", giaiphap: "solution",
  xuly: "solution", bienphap: "solution",
  result: "result", ketqua: "result",
  cost: "cost_vnd", chiphi: "cost_vnd", costvnd: "cost_vnd",
  giatien: "cost_vnd", sotien: "cost_vnd",
  remarks: "remarks", remark: "remarks", ghichu: "remarks", note: "remarks",
};

/** One raw spreadsheet row → a MaintenanceCreate, or null to skip it. */
function rowToMaintenance(raw: Record<string, unknown>): MaintenanceCreate | null {
  const out: Partial<Record<keyof MaintenanceCreate, unknown>> = {};
  for (const [header, cell] of Object.entries(raw)) {
    const field = HEADER_ALIASES[norm(header)];
    if (field) out[field] = cell;
  }
  const device = clean(out.device_id);
  // No device means nothing to attach the repair to — the server would reject it
  // anyway, so drop it here where we can say how many were dropped.
  if (!device) return null;

  return {
    maintenance_id: newId(),
    device_id: device,
    maintenance_date: toIsoDate(out.maintenance_date),
    team: clean(out.team),
    part: clean(out.part),
    reason: clean(out.reason),
    solution: clean(out.solution),
    result: clean(out.result),
    cost_vnd: toNumber(out.cost_vnd),
    remarks: clean(out.remarks),
  };
}

export function ImportMaintenanceModal({
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
  const [rows, setRows] = useState<MaintenanceCreate[]>([]);
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
      const parsed = raw.map(rowToMaintenance);
      const valid = parsed.filter((m): m is MaintenanceCreate => m !== null);
      setRows(valid);
      setSkipped(parsed.length - valid.length);
      if (!valid.length) {
        setError(
          t("sheet.maint.noRows"),
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
    // See the note in ImportDevicesModal — the file identity is the trigger, and
    // clearing the last file's rows before parsing the new one is the point.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (file) parseFile(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const handleImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await importMaintenance(rows);
      const summary = t(
        res.skipped ? "sheet.maint.done.skipped" : "sheet.maint.done",
        { n: res.inserted, skipped: res.skipped },
      );
      // In a bulk run the queue reports every file at the end — a toast per file
      // would stack five deep and scroll the first one away before it was read.
      if (!embedded) toast.success(summary);
      onDone?.(summary);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("sheet.failed"));
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumnsType<MaintenanceCreate> = [
    { title: t("sheet.col.device"), dataIndex: "device_id", key: "device_id" },
    {
      title: t("sheet.col.date"),
      dataIndex: "maintenance_date",
      key: "maintenance_date",
      render: (v) => v || "—",
    },
    { title: t("sheet.col.part"), dataIndex: "part", key: "part", render: (v) => v || "—" },
    { title: t("sheet.col.reason"), dataIndex: "reason", key: "reason", render: (v) => v || "—" },
    { title: t("sheet.col.result"), dataIndex: "result", key: "result", render: (v) => v || "—" },
    {
      title: t("sheet.col.cost"),
      dataIndex: "cost_vnd",
      key: "cost_vnd",
      render: (v: number | null) => (v == null ? "—" : v.toLocaleString("vi-VN")),
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
            e.target.value = "";
          }}
        />

        <div className="import-drop">
          <Button icon={<UploadIcon size={16} />} onClick={() => inputRef.current?.click()}>
            {t("sheet.choose")}
          </Button>
          <span className="import-hint">
            {fileName ?? t("sheet.maint.hint")}
          </span>
        </div>

        {error && <Alert type="error" showIcon message={error} />}

        {rows.length > 0 && (
          <>
            <p className="import-summary">
              {t("sheet.maint.ready", { n: rows.length })}
              {skipped > 0 && (
                <span className="text-faint">
                  {t("sheet.skipped", { n: skipped })}
                </span>
              )}
            </p>
            <div className="table-wrap import-preview">
              <Table<MaintenanceCreate>
                rowKey="maintenance_id"
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
    <Modal title={t("sheet.maint.title")} onClose={onClose} width={860}>
      {body}
    </Modal>
  );
}
