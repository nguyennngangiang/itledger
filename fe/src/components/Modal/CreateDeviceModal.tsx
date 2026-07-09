import { useState } from "react";
import { Button, Input } from "antd";
import { createDevice } from "../../api/devices";
import { ApiError } from "../../api/client";
import type { DeviceCreate } from "../../types";
import { Modal } from "./Modal";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const FIELDS: {
  key: keyof typeof INITIAL;
  label: string;
  placeholder?: string;
  required?: boolean;
  type?: string;
  full?: boolean;
}[] = [
  { key: "serial_number", label: "Serial Number", placeholder: "SN123456789", required: true },
  { key: "barcode", label: "Barcode", placeholder: "8239498234" },
  { key: "name", label: "Device Name", placeholder: "Dell Latitude 5420" },
  { key: "type", label: "Type", placeholder: "Laptop" },
  { key: "brand", label: "Brand", placeholder: "Dell" },
  { key: "cpu", label: "CPU", placeholder: "Intel Core i5" },
  { key: "ram", label: "RAM", placeholder: "16 GB" },
  { key: "storage", label: "Storage", placeholder: "512 GB SSD" },
  { key: "os", label: "Operating System", placeholder: "Windows 11" },
  { key: "msoffice", label: "MS Office", placeholder: "Office 365" },
  { key: "buy_date", label: "Buy Date", type: "date", full: true },
];

const INITIAL = {
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
};

export function CreateDeviceModal({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deviceData, setDeviceData] = useState({ ...INITIAL });

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const device: DeviceCreate = {
      serial_number: deviceData.serial_number.trim(),
      barcode: emptyToNull(deviceData.barcode),
      type: emptyToNull(deviceData.type),
      brand: emptyToNull(deviceData.brand),
      cpu: emptyToNull(deviceData.cpu),
      ram: emptyToNull(deviceData.ram),
      storage: emptyToNull(deviceData.storage),
      os: emptyToNull(deviceData.os),
      msoffice: emptyToNull(deviceData.msoffice),
      buy_date: emptyToNull(deviceData.buy_date),
      name: emptyToNull(deviceData.name),
    };

    try {
      await createDevice(device);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.message)
          : "Failed to create device",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleInputChange = (field: keyof typeof INITIAL, value: string) => {
    setDeviceData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <Modal title="Create Device" onClose={onClose}>
      <form className="modal-form" onSubmit={handleSubmit}>
        <div className="form-grid">
          {FIELDS.map((f) => (
            <label
              key={f.key}
              className={`form-field${f.full ? " form-field-full" : ""}`}
            >
              <span>
                {f.label}
                {f.required && <span className="req">*</span>}
              </span>
              <Input
                type={f.type}
                value={deviceData[f.key]}
                required={f.required}
                placeholder={f.placeholder}
                onChange={(e) => handleInputChange(f.key, e.target.value)}
              />
            </label>
          ))}
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="primary" htmlType="submit" loading={submitting}>
            Create Device
          </Button>
        </div>
      </form>
    </Modal>
  );
}
