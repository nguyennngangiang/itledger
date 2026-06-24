import { useState } from "react";
import { createDevice } from "../api/devices";
import { ApiError } from "../api/client";
import type { DeviceCreate } from "../types";
import { Modal } from "./Modal";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function CreateDeviceModal({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [deviceData, setDeviceData] = useState({
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
  });

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

  const handleInputChange = (field: keyof DeviceCreate, value: string) => {
    setDeviceData((prev) => ({ ...prev, [field]: value }));
  };
  console.log("Device data:", deviceData); // Debugging log to check the device data being submitted
  return (
    <Modal title="Create Device" onClose={onClose}>
      <form className="device-form" onSubmit={handleSubmit}>
        <div className="device-grid">
          <label>
            Serial Number *
            <input
              type="text"
              name="serial_number"
              value={deviceData.serial_number}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              required
              placeholder="SN123456789"
            />
          </label>

          <label>
            Barcode
            <input
              type="text"
              name="barcode"
              value={deviceData.barcode}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              placeholder="Barcode"
            />
          </label>

          <label>
            Device Name
            <input
              type="text"
              name="name"
              value={deviceData.name}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              placeholder="Dell Latitude 5420"
            />
          </label>

          <label>
            Type
            <input
              type="text"
              name="type"
              value={deviceData.type}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              placeholder="Laptop"
            />
          </label>

          <label>
            Brand
            <input
              type="text"
              name="brand"
              value={deviceData.brand}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              placeholder="Dell"
            />
          </label>

          <label>
            CPU
            <input
              type="text"
              name="cpu"
              value={deviceData.cpu}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              placeholder="Intel Core i5"
            />
          </label>

          <label>
            RAM
            <input
              type="text"
              name="ram"
              value={deviceData.ram}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              placeholder="16 GB"
            />
          </label>

          <label>
            Storage
            <input
              type="text"
              name="storage"
              value={deviceData.storage}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              placeholder="512 GB SSD"
            />
          </label>

          <label>
            Operating System
            <input
              type="text"
              name="os"
              value={deviceData.os}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              placeholder="Windows 11"
            />
          </label>

          <label>
            MS Office
            <input
              type="text"
              name="msoffice"
              value={deviceData.msoffice}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
              placeholder="Office 365"
            />
          </label>

          <label>
            Buy Date
            <input
              type="date"
              name="buy_date"
              value={deviceData.buy_date}
              onChange={(e) =>
                handleInputChange(
                  e.target.name as keyof DeviceCreate,
                  e.target.value,
                )
              }
            />
          </label>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button
            type="button"
            className="cancel-btn"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>

          <button type="submit" className="create-btn" disabled={submitting}>
            {submitting ? "Creating..." : "Create Device"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
