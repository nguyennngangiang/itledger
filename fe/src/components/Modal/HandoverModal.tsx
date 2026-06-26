import { useEffect, useState } from "react";
import { listDevices } from "../../api/devices";
import { createHandover } from "../../api/handovers";
import { listUsers } from "../../api/users";
import { ApiError } from "../../api/client";
import type { Device, HandoverCreate, User } from "../../types";
import { Modal } from "./Modal";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function HandoverModal({ onClose }: { onClose: () => void }) {
  const [serialNumber, setSerialNumber] = useState("");
  const [fromEmployeeCode, setFromEmployeeCode] = useState("");
  const [toEmployeeCode, setToEmployeeCode] = useState("");
  const [reason, setReason] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([listDevices(), listUsers()])
      .then(([deviceList, userList]) => {
        setDevices(deviceList);
        setUsers(userList);
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

    if (fromEmployeeCode === toEmployeeCode) {
      setError("From and to employee must be different");
      return;
    }

    setSubmitting(true);

    const handover: HandoverCreate = {
      handover_id: crypto.randomUUID(),
      handover_date: todayIsoDate(),
      device_id: serialNumber,
      from_user_id: fromEmployeeCode,
      to_user_id: toEmployeeCode,
      reason: emptyToNull(reason),
    };

    try {
      await createHandover(handover);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.message)
          : "Failed to submit handover",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Handover" onClose={onClose}>
      <form className="modal-form handover-form" onSubmit={handleSubmit}>
        <div className="handover-grid">
          <label>
            Device name
            <select
              value={serialNumber}
              onChange={(e) => setSerialNumber(e.target.value)}
              required
              disabled={loading || !!loadError || submitting}
            >
              <option value="">
                {loading
                  ? "Loading devices…"
                  : loadError
                    ? "Could not load devices"
                    : "Select a device"}
              </option>

              {devices.map((device) => (
                <option key={device.serial_number} value={device.serial_number}>
                  {device.name ?? device.serial_number}
                  {device.name ? ` (${device.serial_number})` : ""}
                </option>
              ))}
            </select>
          </label>

          <label>
            From employee
            <select
              value={fromEmployeeCode}
              onChange={(e) => setFromEmployeeCode(e.target.value)}
              required
              disabled={loading || !!loadError || submitting}
            >
              <option value="">
                {loading
                  ? "Loading users…"
                  : loadError
                    ? "Could not load users"
                    : "Select an employee"}
              </option>

              {users.map((user) => (
                <option key={user.employee_code} value={user.employee_code}>
                  {user.employee_code}
                  {user.name ? ` — ${user.name}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label>
            To employee
            <select
              value={toEmployeeCode}
              onChange={(e) => setToEmployeeCode(e.target.value)}
              required
              disabled={loading || !!loadError || submitting}
            >
              <option value="">
                {loading
                  ? "Loading users…"
                  : loadError
                    ? "Could not load users"
                    : "Select an employee"}
              </option>

              {users.map((user) => (
                <option key={user.employee_code} value={user.employee_code}>
                  {user.employee_code}
                  {user.name ? ` — ${user.name}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="handover-reason">
            Reason
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              placeholder="Optional"
            />
          </label>
        </div>

        {loadError && <p className="form-error">{loadError}</p>}
        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button
            className="cancel-btn"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>

          <button
            className="create-btn"
            type="submit"
            disabled={loading || !!loadError || submitting}
          >
            {submitting ? "Submitting…" : "Submit"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default HandoverModal;
