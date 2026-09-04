import { useEffect, useState } from "react";
import { AutoComplete, Button, DatePicker, InputNumber, Select } from "antd";
import dayjs from "dayjs";
import { listDevices, updateDevice } from "../../api/devices";
import {
  createMaintenance,
  maintenanceSuggestions,
  updateMaintenance,
} from "../../api/maintenance";
import { listUsersIncludingDeleted, listUserTeams } from "../../api/users";
import { ApiError } from "../../api/client";
import type { Device, Maintenance, MaintenanceCreate, User } from "../../types";
import { GHOST_USER_CODE } from "../../types";
import { resolveOwner, todayIsoDate, toUserMap } from "../../lib/format";
import { newId } from "../../lib/id";
import { Modal } from "./Modal";
import { useT } from "../../i18n/useT";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Common repairable parts. Merged with what the data already contains, and
// offered through an AutoComplete so "Battery — swollen" is still possible.
//
// DO NOT translate PARTS or RESULT_OPTS. They are merged with live values by
// mergeOptions() and POSTed as the stored `part` / `result`, so a translated
// option writes foreign text into the maintenance table and stops matching what
// is already there. Registered in i18n/exclusions.ts.
const PARTS = [
  "Battery",
  "Keyboard",
  "RAM",
  "Storage/SSD",
  "Screen/Display",
  "Charger/Adapter",
  "Motherboard",
  "Fan/Cooling",
  "Trackpad",
  "Ports",
  "Software/OS",
  "Other",
];

const RESULT_OPTS = ["Fixed", "Replaced", "Sent to vendor", "Unrepairable", "Pending"];

/** Suggestions from the data first, with a starter list folded in, de-duped
 *  case-insensitively so the picker never offers "RAM" and "Ram" together. */
function mergeOptions(fromData: string[] | undefined, seed: string[]) {
  const seen = new Map<string, string>();
  for (const v of [...(fromData ?? []), ...seed]) {
    const key = v.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, v.trim());
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v }));
}

const matches = (input: string, opt?: { value?: string | number }) =>
  String(opt?.value ?? "")
    .toLowerCase()
    .includes(input.toLowerCase());

function MaintenanceModal({
  onClose,
  isEdit = false,
  maintenance,
}: {
  onClose: () => void;
  isEdit?: boolean;
  maintenance?: Maintenance;
}) {
  const { t } = useT();
  // Editing prefills through the initial state rather than an effect that
  // overwrites it a render later. MaintenanceScreen mounts this modal fresh per
  // row ({editTarget && …}, keyed on the row id), so `maintenance` never changes
  // underneath a mounted form.
  const editing = isEdit ? maintenance : undefined;
  const [serialNumber, setSerialNumber] = useState(
    () => editing?.device_id ?? "",
  );
  const [teamId, setTeamId] = useState(() => editing?.team ?? "");
  const [part, setPart] = useState(() => editing?.part ?? "");
  const [problem, setProblem] = useState(() => editing?.reason ?? "");
  const [solution, setSolution] = useState(() => editing?.solution ?? "");
  const [result, setResult] = useState(() => editing?.result ?? "");
  const [cost, setCost] = useState<number | null>(() => editing?.cost_vnd ?? null);
  const [remark, setRemark] = useState(() => editing?.remarks ?? "");
  const [maintenanceDate, setMaintenanceDate] = useState(
    () => editing?.maintenance_date ?? todayIsoDate(),
  );
  const [devices, setDevices] = useState<Device[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [users, setUsers] = useState<Record<string, User>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      listDevices(),
      listUserTeams().catch(() => [] as string[]),
      // Trashed staff included: this map only resolves the selected device's
      // owner team, and that owner may since have left.
      listUsersIncludingDeleted().catch(() => [] as User[]),
      maintenanceSuggestions().catch(() => ({}) as Record<string, string[]>),
    ])
      .then(([deviceList, teamList, userList, hints]) => {
        setDevices(deviceList);
        setTeams(teamList);
        setUsers(toUserMap(userList));
        setSuggestions(hints);
      })
      .catch((err) => {
        setLoadError(
          err instanceof ApiError
            ? String(err.message)
            : t("maintForm.loadFailed"),
        );
      })
      .finally(() => setLoading(false));
  }, [t]);

  // Team always follows the selected device's owner team.
  const handleDeviceChange = (serial: string) => {
    setSerialNumber(serial);
    const dev = devices.find((d) => d.serial_number === serial);
    const ownerTeam = resolveOwner(dev?.user_id ?? null, users).team;
    if (ownerTeam && ownerTeam !== "—") setTeamId(ownerTeam);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (isEdit && maintenance) {
        await updateMaintenance(maintenance.maintenance_id, {
          maintenance_date: maintenanceDate,
          device_id: serialNumber,
          team: teamId,
          part: emptyToNull(part),
          reason: emptyToNull(problem),
          solution: emptyToNull(solution),
          result: emptyToNull(result),
          cost_vnd: cost,
          remarks: emptyToNull(remark),
        });
        onClose();
        return;
      }

      const record: MaintenanceCreate = {
        maintenance_id: newId(),
        maintenance_date: maintenanceDate,
        device_id: serialNumber,
        team: teamId,
        part: emptyToNull(part),
        reason: emptyToNull(problem),
        solution: emptyToNull(solution),
        result: emptyToNull(result),
        cost_vnd: cost,
        remarks: emptyToNull(remark),
      };

      await createMaintenance(record);
      // Auto-hook: logging a repair flips the device to "maintaining" unless it
      // is already flagged for deletion. Ownership moves to IT Store with it —
      // IT physically has the machine, and maintaining/on_del never sit on a
      // person. Hand it back through a handover once the repair is done.
      const dev = devices.find((d) => d.serial_number === serialNumber);
      if (dev && dev.status !== "on_del" && dev.status !== "maintaining") {
        try {
          await updateDevice(serialNumber, {
            status: "maintaining",
            user_id: GHOST_USER_CODE,
          });
        } catch {
          /* non-fatal: the maintenance record was still created */
        }
      }
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.message)
          : t("maintForm.failed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = loading || !!loadError || submitting;
  const teamOptions = mergeOptions(teams, ["IT"]);

  return (
    <Modal
      title={t(isEdit ? "maintForm.edit" : "maintForm.create")}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={handleSubmit}>
        <div className="form-grid">
          <label className="form-field">
            <span>
              {t("maintForm.device")}<span className="req">*</span>
            </span>
            <Select
              showSearch
              optionFilterProp="label"
              value={serialNumber || undefined}
              placeholder={t(
                loading ? "maintForm.deviceLoading" : "maintForm.devicePlaceholder",
              )}
              disabled={disabled || isEdit}
              onChange={handleDeviceChange}
              options={devices.map((d) => ({
                value: d.serial_number,
                label: d.name
                  ? `${d.serial_number} — ${d.name}`
                  : d.serial_number,
              }))}
            />
          </label>

          <label className="form-field">
            <span>
              {t("maintForm.team")}<span className="req">*</span>
            </span>
            <AutoComplete
              style={{ width: "100%" }}
              value={teamId}
              options={teamOptions}
              placeholder={t("maintForm.teamPlaceholder")}
              disabled={disabled}
              filterOption={matches}
              onChange={setTeamId}
            />
          </label>

          <label className="form-field">
            <span>
              {t("maintForm.part")}<span className="req">*</span>
            </span>
            <AutoComplete
              style={{ width: "100%" }}
              value={part}
              options={mergeOptions(suggestions.part, PARTS)}
              // A sample from PARTS, which is not translated (see exclusions.ts):
              // the hint must keep matching what the picker actually offers.
              placeholder="Battery"
              disabled={submitting}
              filterOption={matches}
              onChange={setPart}
            />
          </label>

          <label className="form-field">
            <span>{t("maintForm.cost")}</span>
            <InputNumber<number>
              style={{ width: "100%" }}
              value={cost}
              min={0}
              step={1000}
              disabled={submitting}
              placeholder="0"
              // Thousands separators while typing. The old plain Input parsed
              // with Number(), so "1,000,000" came back NaN and was rejected.
              formatter={(v) =>
                v == null ? "" : `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
              }
              parser={(v) => Number(String(v ?? "").replace(/[^\d]/g, "") || 0)}
              onChange={setCost}
            />
          </label>

          <label className="form-field">
            <span>{t("maintForm.date")}</span>
            <DatePicker
              style={{ width: "100%" }}
              format="DD-MM-YYYY"
              allowClear={false}
              disabled={submitting}
              value={maintenanceDate ? dayjs(maintenanceDate) : null}
              onChange={(d) =>
                setMaintenanceDate(d ? d.format("YYYY-MM-DD") : todayIsoDate())
              }
            />
          </label>

          <label className="form-field">
            <span>{t("maintForm.result")}</span>
            <AutoComplete
              style={{ width: "100%" }}
              value={result}
              options={mergeOptions(suggestions.result, RESULT_OPTS)}
              placeholder={t("maintForm.resultPlaceholder")}
              disabled={submitting}
              filterOption={matches}
              onChange={setResult}
            />
          </label>

          <label className="form-field form-field-full">
            <span>{t("maintForm.problem")}</span>
            <AutoComplete
              style={{ width: "100%" }}
              value={problem}
              options={mergeOptions(suggestions.reason, [])}
              disabled={submitting}
              filterOption={matches}
              onChange={setProblem}
            />
          </label>

          <label className="form-field form-field-full">
            <span>{t("maintForm.solution")}</span>
            <AutoComplete
              style={{ width: "100%" }}
              value={solution}
              options={mergeOptions(suggestions.solution, [])}
              disabled={submitting}
              filterOption={matches}
              onChange={setSolution}
            />
          </label>

          <label className="form-field form-field-full">
            <span>{t("maintForm.remark")}</span>
            <AutoComplete
              style={{ width: "100%" }}
              value={remark}
              options={[]}
              disabled={submitting}
              filterOption={matches}
              onChange={setRemark}
            />
          </label>
        </div>

        {loadError && <p className="form-error">{loadError}</p>}
        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <Button onClick={onClose} disabled={submitting}>
            {t("form.cancel")}
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            loading={submitting}
            disabled={!serialNumber || !teamId || !part}
          >
            {t(isEdit ? "form.save" : "form.submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default MaintenanceModal;
