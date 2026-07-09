import { useEffect, useState } from "react";
import { Button, Input, Select } from "antd";
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

  const disabled = loading || !!loadError || submitting;
  const placeholder = (noun: string) =>
    loading ? `Loading ${noun}…` : loadError ? `Could not load ${noun}` : `Select a ${noun}`;

  const deviceOptions = devices.map((d) => ({
    value: d.serial_number,
    label: d.name ? `${d.name} (${d.serial_number})` : d.serial_number,
  }));
  const userOptions = users.map((u) => ({
    value: u.employee_code,
    label: u.name ? `${u.employee_code} — ${u.name}` : u.employee_code,
  }));

  return (
    <Modal title="Record Handover" onClose={onClose}>
      <form className="modal-form" onSubmit={handleSubmit}>
        <div className="form-grid">
          <label className="form-field form-field-full">
            <span>
              Device<span className="req">*</span>
            </span>
            <Select
              showSearch
              optionFilterProp="label"
              value={serialNumber || undefined}
              placeholder={placeholder("device")}
              disabled={disabled}
              onChange={setSerialNumber}
              options={deviceOptions}
            />
          </label>

          <label className="form-field">
            <span>
              From employee<span className="req">*</span>
            </span>
            <Select
              showSearch
              optionFilterProp="label"
              value={fromEmployeeCode || undefined}
              placeholder={placeholder("employee")}
              disabled={disabled}
              onChange={setFromEmployeeCode}
              options={userOptions}
            />
          </label>

          <label className="form-field">
            <span>
              To employee<span className="req">*</span>
            </span>
            <Select
              showSearch
              optionFilterProp="label"
              value={toEmployeeCode || undefined}
              placeholder={placeholder("employee")}
              disabled={disabled}
              onChange={setToEmployeeCode}
              options={userOptions}
            />
          </label>

          <label className="form-field form-field-full">
            <span>Reason</span>
            <Input
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

export default HandoverModal;
