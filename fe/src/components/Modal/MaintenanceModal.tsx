import { useEffect, useState } from "react";
import { Button, Input, Select } from "antd";
import { listDevices, updateDevice } from "../../api/devices";
import { createMaintenance, updateMaintenance } from "../../api/maintenance";
import { listTeams } from "../../api/teams";
import { listUsers } from "../../api/users";
import { ApiError } from "../../api/client";
import type { Device, Maintenance, MaintenanceCreate, Team, User } from "../../types";
import { resolveOwner, toUserMap } from "../../lib/format";
import { Modal } from "./Modal";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Predefined repairable parts (dropdown in the form).
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

function MaintenanceModal({
  onClose,
  isEdit = false,
  maintenance,
}: {
  onClose: () => void;
  isEdit?: boolean;
  maintenance?: Maintenance;
}) {
  const [serialNumber, setSerialNumber] = useState("");
  const [teamId, setTeamId] = useState("");
  const [part, setPart] = useState<string | undefined>();
  const [problem, setProblem] = useState("");
  const [solution, setSolution] = useState("");
  const [result, setResult] = useState("");
  const [cost, setCost] = useState("");
  const [remark, setRemark] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<Record<string, User>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      listDevices(),
      listTeams().catch(() => [] as Team[]),
      listUsers().catch(() => [] as User[]),
    ])
      .then(([deviceList, teamList, userList]) => {
        setDevices(deviceList);
        setTeams(teamList);
        setUsers(toUserMap(userList));
      })
      .catch((err) => {
        setLoadError(
          err instanceof ApiError
            ? String(err.message)
            : "Failed to load form data",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  // Prefill when editing an existing record.
  useEffect(() => {
    if (isEdit && maintenance) {
      setSerialNumber(maintenance.device_id ?? "");
      setTeamId(maintenance.team ?? "");
      setPart(maintenance.part ?? undefined);
      setProblem(maintenance.reason ?? "");
      setSolution(maintenance.solution ?? "");
      setResult(maintenance.result ?? "");
      setCost(maintenance.cost_vnd != null ? String(maintenance.cost_vnd) : "");
      setRemark(maintenance.remarks ?? "");
    }
  }, [isEdit, maintenance]);

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

    const costTrimmed = cost.trim();
    let costVnd: number | null = null;
    if (costTrimmed !== "") {
      const parsed = Number(costTrimmed);
      if (Number.isNaN(parsed)) {
        setError("Cost must be a number");
        setSubmitting(false);
        return;
      }
      costVnd = parsed;
    }

    try {
      if (isEdit && maintenance) {
        await updateMaintenance(maintenance.maintenance_id, {
          device_id: serialNumber,
          team: teamId,
          part: emptyToNull(part ?? ""),
          reason: emptyToNull(problem),
          solution: emptyToNull(solution),
          result: emptyToNull(result),
          cost_vnd: costVnd,
          remarks: emptyToNull(remark),
        });
        onClose();
        return;
      }

      const record: MaintenanceCreate = {
        maintenance_id: crypto.randomUUID(),
        maintenance_date: todayIsoDate(),
        device_id: serialNumber,
        team: teamId,
        part: emptyToNull(part ?? ""),
        reason: emptyToNull(problem),
        solution: emptyToNull(solution),
        result: emptyToNull(result),
        cost_vnd: costVnd,
        remarks: emptyToNull(remark),
      };

      await createMaintenance(record);
      // Auto-hook: a device under maintenance flips to "maintaining"
      // unless it is manually flagged for deletion.
      const dev = devices.find((d) => d.serial_number === serialNumber);
      if (dev && dev.status !== "on_del" && dev.status !== "maintaining") {
        try {
          await updateDevice(serialNumber, { status: "maintaining" });
        } catch {
          /* non-fatal: the maintenance record was still created */
        }
      }
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.message)
          : "Failed to submit maintenance",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = loading || !!loadError || submitting;
  const teamOptions = teams.length
    ? teams.map((t) => ({
        value: t.team_id,
        label: t.team_name ? `${t.team_id} — ${t.team_name}` : t.team_id,
      }))
    : [{ value: "IT", label: "IT" }];

  return (
    <Modal title={isEdit ? "Edit Maintenance" : "Log Maintenance"} onClose={onClose}>
      <form className="modal-form" onSubmit={handleSubmit}>
        <div className="form-grid">
          <label className="form-field">
            <span>
              Device<span className="req">*</span>
            </span>
            <Select
              showSearch
              optionFilterProp="label"
              value={serialNumber || undefined}
              placeholder={loading ? "Loading devices…" : "Select a device"}
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
              Team<span className="req">*</span>
            </span>
            <Select
              showSearch
              optionFilterProp="label"
              value={teamId || undefined}
              placeholder="Select a team"
              disabled={disabled}
              onChange={setTeamId}
              options={teamOptions}
            />
          </label>

          <label className="form-field">
            <span>
              Part to repair<span className="req">*</span>
            </span>
            <Select
              value={part}
              placeholder="Select a part"
              disabled={submitting}
              onChange={setPart}
              options={PARTS.map((p) => ({ value: p, label: p }))}
            />
          </label>

          <label className="form-field">
            <span>Cost (VND)</span>
            <Input
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              disabled={submitting}
              placeholder="0"
            />
          </label>

          <label className="form-field form-field-full">
            <span>Problem description</span>
            <Input
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="form-field">
            <span>Solution</span>
            <Input
              value={solution}
              onChange={(e) => setSolution(e.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="form-field">
            <span>Result</span>
            <Input
              value={result}
              onChange={(e) => setResult(e.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="form-field form-field-full">
            <span>Remark</span>
            <Input
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              disabled={submitting}
            />
          </label>
        </div>

        {loadError && <p className="form-error">{loadError}</p>}
        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            loading={submitting}
            disabled={!serialNumber || !teamId || !part}
          >
            {isEdit ? "Save changes" : "Submit"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default MaintenanceModal;
