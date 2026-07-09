import { useEffect, useState } from "react";
import { Button, Input, Select } from "antd";
import { listDevices } from "../../api/devices";
import { createMaintenance } from "../../api/maintenance";
import { listTeams } from "../../api/teams";
import { ApiError } from "../../api/client";
import type { Device, MaintenanceCreate, Team } from "../../types";
import { Modal } from "./Modal";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function MaintenanceModal({ onClose }: { onClose: () => void }) {
  const [serialNumber, setSerialNumber] = useState("");
  const [teamId, setTeamId] = useState("");
  const [part, setPart] = useState("");
  const [problem, setProblem] = useState("");
  const [solution, setSolution] = useState("");
  const [result, setResult] = useState("");
  const [cost, setCost] = useState("");
  const [remark, setRemark] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([listDevices(), listTeams()])
      .then(([deviceList, teamList]) => {
        setDevices(deviceList);
        setTeams(teamList);
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

    const maintenance: MaintenanceCreate = {
      maintenance_id: crypto.randomUUID(),
      maintenance_date: todayIsoDate(),
      device_id: serialNumber,
      team: teamId,
      part: emptyToNull(part),
      reason: emptyToNull(problem),
      solution: emptyToNull(solution),
      result: emptyToNull(result),
      cost_vnd: costVnd,
      remarks: emptyToNull(remark),
    };

    try {
      await createMaintenance(maintenance);
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

  return (
    <Modal title="Log Maintenance" onClose={onClose}>
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
              placeholder={
                loading
                  ? "Loading devices…"
                  : loadError
                    ? "Could not load devices"
                    : "Select a device"
              }
              disabled={disabled}
              onChange={setSerialNumber}
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
              placeholder={
                loading
                  ? "Loading teams…"
                  : loadError
                    ? "Could not load teams"
                    : "Select a team"
              }
              disabled={disabled}
              onChange={setTeamId}
              options={teams.map((t) => ({
                value: t.team_id,
                label: t.team_name ? `${t.team_id} — ${t.team_name}` : t.team_id,
              }))}
            />
          </label>

          <label className="form-field">
            <span>Part to repair</span>
            <Input
              value={part}
              onChange={(e) => setPart(e.target.value)}
              disabled={submitting}
              placeholder="e.g. Battery"
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
            disabled={loading || !!loadError}
          >
            Submit
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default MaintenanceModal;
