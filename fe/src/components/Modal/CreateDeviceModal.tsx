import { useEffect, useState } from "react";
import { Button, Input, Select, AutoComplete, DatePicker } from "antd";
import dayjs from "dayjs";
import { createDevice, updateDevice } from "../../api/devices";
import { listUsers } from "../../api/users";
import { ApiError } from "../../api/client";
import type { Device, DeviceCreate, DeviceStatus, User } from "../../types";
import { GHOST_USER_CODE, DEVICE_STATUS_ORDER, DEVICE_STATUS_META } from "../../types";
import { Modal } from "./Modal";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Preset suggestions for the dropdowns (free text still allowed).
const RAM_OPTS = ["8 GB", "16 GB", "32 GB", "64 GB"];
const OS_OPTS = ["Windows 11 Pro", "Windows 10 Pro", "macOS Sonoma", "Ubuntu 22.04"];
const OFFICE_OPTS = ["Office 365", "Office 2021", "Office 2019", "None"];
const AUTO: Record<string, string[]> = {
  ram: RAM_OPTS,
  os: OS_OPTS,
  msoffice: OFFICE_OPTS,
};

const SPEC_FIELDS: {
  key: keyof FormState;
  label: string;
  placeholder?: string;
  type?: string;
  full?: boolean;
}[] = [
  { key: "barcode", label: "Barcode", placeholder: "8239498234" },
  { key: "type", label: "Type", placeholder: "Laptop" },
  { key: "brand", label: "Brand", placeholder: "Dell" },
  { key: "cpu", label: "CPU", placeholder: "Intel Core i5" },
  { key: "ram", label: "RAM", placeholder: "16 GB" },
  { key: "storage", label: "Storage", placeholder: "512 GB SSD" },
  { key: "os", label: "Operating System", placeholder: "Windows 11" },
  { key: "msoffice", label: "MS Office", placeholder: "Office 365" },
  { key: "buy_date", label: "Buy Date", type: "date", full: true },
];

type FormState = {
  serial_number: string;
  barcode: string;
  type: string;
  brand: string;
  cpu: string;
  ram: string;
  storage: string;
  os: string;
  msoffice: string;
  buy_date: string;
  name: string;
  user_id: string;
  status: DeviceStatus;
};

const EMPTY: FormState = {
  serial_number: "",
  barcode: "",
  type: "",
  brand: "",
  cpu: "",
  ram: "",
  storage: "",
  os: "",
  msoffice: "",
  buy_date: "",
  name: "",
  user_id: GHOST_USER_CODE,
  status: "in_stock",
};

export function CreateDeviceModal({
  onClose,
  isEdit = false,
  device,
}: {
  onClose: () => void;
  isEdit?: boolean;
  device?: Device;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);

  useEffect(() => {
    listUsers()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    if (isEdit && device) {
      setForm({
        serial_number: device.serial_number,
        barcode: device.barcode ?? "",
        type: device.type ?? "",
        brand: device.brand ?? "",
        cpu: device.cpu ?? "",
        ram: device.ram ?? "",
        storage: device.storage ?? "",
        os: device.os ?? "",
        msoffice: device.msoffice ?? "",
        buy_date: device.buy_date ?? "",
        name: device.name ?? "",
        user_id: device.user_id ?? GHOST_USER_CODE,
        status: (device.status as DeviceStatus) ?? "in_stock",
      });
    }
  }, [isEdit, device]);

  const set = (key: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // When the owner changes and status is still a derivable value, re-derive it.
  const setOwner = (userId: string) =>
    setForm((prev) => {
      const derivable = prev.status === "active" || prev.status === "in_stock";
      const derived = userId === GHOST_USER_CODE ? "in_stock" : "active";
      return { ...prev, user_id: userId, status: derivable ? derived : prev.status };
    });

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const payload: DeviceCreate = {
      serial_number: form.serial_number.trim(),
      barcode: emptyToNull(form.barcode),
      type: emptyToNull(form.type),
      brand: emptyToNull(form.brand),
      cpu: emptyToNull(form.cpu),
      ram: emptyToNull(form.ram),
      storage: emptyToNull(form.storage),
      os: emptyToNull(form.os),
      msoffice: emptyToNull(form.msoffice),
      buy_date: emptyToNull(form.buy_date),
      name: emptyToNull(form.name),
      user_id: form.user_id || GHOST_USER_CODE,
      status: form.status,
    };

    try {
      if (isEdit) {
        const { serial_number, ...patch } = payload;
        await updateDevice(serial_number, patch);
      } else {
        await createDevice(payload);
      }
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError ? String(err.message) : "Failed to save device",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const userOptions = users.map((u) => ({
    value: u.employee_code,
    label:
      u.employee_code === GHOST_USER_CODE
        ? "IT Store — in stock (IT)"
        : `${u.name ?? u.employee_code} — ${u.team ?? "—"}`,
  }));

  const statusOptions = DEVICE_STATUS_ORDER.map((s) => ({
    value: s,
    label: DEVICE_STATUS_META[s].label,
  }));

  return (
    <Modal title={isEdit ? "Edit Device" : "Create Device"} onClose={onClose}>
      <form className="modal-form" onSubmit={handleSubmit}>
        <div className="form-section">
          <div className="form-section-label">Identity</div>
          <div className="form-grid">
            <label className="form-field">
              <span>
                Serial Number<span className="req">*</span>
              </span>
              <Input
                value={form.serial_number}
                required
                disabled={isEdit}
                placeholder="SN123456789"
                onChange={(e) => set("serial_number", e.target.value)}
              />
            </label>

            <label className="form-field">
              <span>Device Name</span>
              <Input
                value={form.name}
                placeholder="Dell Latitude 5420"
                onChange={(e) => set("name", e.target.value)}
              />
            </label>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-label">Assignment</div>
          <div className="form-grid">
            <label className="form-field">
              <span>Owner</span>
              <Select
                showSearch
                optionFilterProp="label"
                value={form.user_id}
                onChange={setOwner}
                options={userOptions}
              />
            </label>

            <label className="form-field">
              <span>Status</span>
              <Select
                value={form.status}
                onChange={(v) => set("status", v)}
                options={statusOptions}
              />
            </label>
          </div>
          {(form.status === "active" || form.status === "in_stock") && (
            <p className="info-callout">
              Status follows the owner — assigning a person flips it to{" "}
              <b>Active</b>; clearing the owner (IT Store) returns it to{" "}
              <b>In stock</b>.
            </p>
          )}
        </div>

        <div className="form-section">
          <div className="form-section-label">Specifications</div>
          <div className="form-grid">
          {SPEC_FIELDS.map((f) => {
            let control: React.ReactNode;
            if (f.key === "buy_date") {
              control = (
                <DatePicker
                  style={{ width: "100%" }}
                  format="DD-MM-YYYY"
                  placeholder="DD-MM-YYYY"
                  value={form.buy_date ? dayjs(form.buy_date) : null}
                  onChange={(d) =>
                    set("buy_date", d ? d.format("YYYY-MM-DD") : "")
                  }
                />
              );
            } else if (f.key in AUTO) {
              control = (
                <AutoComplete
                  style={{ width: "100%" }}
                  options={AUTO[f.key].map((v) => ({ value: v }))}
                  value={form[f.key]}
                  placeholder={f.placeholder}
                  filterOption={(input, opt) =>
                    String(opt?.value ?? "")
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                  onChange={(v) => set(f.key, v)}
                />
              );
            } else {
              control = (
                <Input
                  value={form[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              );
            }
            return (
              <label
                key={f.key}
                className={`form-field${f.full ? " form-field-full" : ""}`}
              >
                <span>{f.label}</span>
                {control}
              </label>
            );
          })}
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="primary" htmlType="submit" loading={submitting}>
            {isEdit ? "Save changes" : "Create Device"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
