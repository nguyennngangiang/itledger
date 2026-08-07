import { useEffect, useRef, useState } from "react";
import { Button, Input, Select, AutoComplete, DatePicker } from "antd";
import type { InputRef } from "antd";
import dayjs from "dayjs";
import { createDevice, deviceSuggestions, updateDevice } from "../../api/devices";
import { listUsers } from "../../api/users";
import { ApiError } from "../../api/client";
import type { Device, DeviceCreate, DeviceStatus, User } from "../../types";
import { GHOST_USER_CODE, DEVICE_STATUS_ORDER, DEVICE_STATUS_META } from "../../types";
import { deriveStatus, isItHeld, ownerForStatus, ownerOptionLabel } from "../../lib/format";
import { normalizeField } from "../../lib/normalize";
import { Modal } from "./Modal";
import type { Key } from "../../i18n/catalog";
import { useT } from "../../i18n/useT";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Fields offered with suggestions. The values themselves come from the fleet
// (GET /devices/suggestions) rather than a hardcoded list, so they track what
// is actually in the data — the old hardcoded RAM/OS/Office lists matched none
// of the real rows. FALLBACK_OPTS only covers a cold/unreachable backend.
const AUTO_FIELDS = [
  "type",
  "brand",
  "cpu",
  "ram",
  "storage",
  "os",
  "msoffice",
] as const;

// DO NOT translate: these are saved as the device's spec values, not labels.
// Registered in i18n/exclusions.ts.
const FALLBACK_OPTS: Record<string, string[]> = {
  ram: ["8 GB", "16 GB", "32 GB", "64 GB"],
  os: ["Windows 11 Pro", "Windows 10 Pro", "macOS Sonoma", "Ubuntu 22.04"],
  msoffice: ["Office 365", "Office 2021", "Office 2019", "None"],
};

const SPEC_FIELDS: {
  key: keyof FormState;
  /** Catalog key — module scope cannot call the hook, so the row resolves it. */
  label: Key;
  placeholder?: string;
  type?: string;
  full?: boolean;
}[] = [
  { key: "barcode", label: "field.barcode", placeholder: "8239498234" },
  { key: "type", label: "field.type", placeholder: "Laptop" },
  { key: "brand", label: "field.brand", placeholder: "Dell" },
  { key: "cpu", label: "field.cpu", placeholder: "Intel Core i5" },
  { key: "ram", label: "field.ram", placeholder: "16 GB" },
  { key: "storage", label: "field.storage", placeholder: "512 GB SSD" },
  { key: "os", label: "field.os", placeholder: "Windows 11" },
  { key: "msoffice", label: "field.msoffice", placeholder: "Office 365" },
  { key: "buy_date", label: "field.buy_date", type: "date", full: true },
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
  onSaved,
  isEdit = false,
  device,
}: {
  onClose: () => void;
  /** Fired only when the device was actually written — Cancel calls `onClose`
   * alone. The Notifications screen needs the difference: it closes the issue
   * that asked for the missing fields, and closing it on Cancel would be a lie. */
  onSaved?: () => void;
  isEdit?: boolean;
  device?: Device;
}) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const [serialError, setSerialError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [form, setForm] = useState<FormState>(EMPTY);
  // field -> what the user originally typed, when we tidied it on blur.
  const [corrected, setCorrected] = useState<Partial<Record<keyof FormState, string>>>({});
  const serialRef = useRef<InputRef>(null);

  useEffect(() => {
    listUsers()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);

  // Suggestions are a convenience — if the call fails the form still works,
  // just with the fallback lists.
  useEffect(() => {
    deviceSuggestions()
      .then(setSuggestions)
      .catch(() => setSuggestions({}));
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

  // Owner drives status: IT Store means in stock, a person means active.
  // deriveStatus leaves maintaining/on_del alone — see lib/format.ts. The
  // Status select stays editable; this only fills it in.
  const setOwner = (userId: string) =>
    setForm((prev) => ({
      ...prev,
      user_id: userId,
      status: deriveStatus(userId, prev.status),
    }));

  // ...and the same rule backwards: maintaining/on_del mean IT has the machine,
  // so the owner moves to IT Store. The backend enforces this too, so leaving a
  // person selected here would just be silently undone on save.
  const setStatus = (status: DeviceStatus) =>
    setForm((prev) => ({
      ...prev,
      status,
      user_id: ownerForStatus(status, prev.user_id),
    }));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    // Validate here rather than letting the browser do it: the form is
    // noValidate so a missing serial reports in the app's own error style
    // instead of Chrome's yellow bubble, which matched nothing else here.
    if (!form.serial_number.trim()) {
      setSerialError(true);
      setError(t("form.required", { field: t("deviceForm.serial") }));
      serialRef.current?.focus();
      return;
    }
    setSerialError(false);
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
      onSaved?.();
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError ? String(err.message) : t("deviceForm.failed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const userOptions = users.map((u) => ({
    value: u.employee_code,
    label: ownerOptionLabel(u, t),
  }));

  const statusOptions = DEVICE_STATUS_ORDER.map((s) => ({
    value: s,
    label: DEVICE_STATUS_META[s].label,
  }));

  /** Tidy a spec field on blur, remembering the original so it can be undone. */
  const tidy = (key: keyof FormState) => {
    const pool = suggestions[key]?.length
      ? suggestions[key]
      : (FALLBACK_OPTS[key] ?? []);
    const { value, changedFrom } = normalizeField(key, form[key], pool);
    if (changedFrom === null) return;
    set(key, value);
    setCorrected((c) => ({ ...c, [key]: changedFrom }));
  };

  const undoTidy = (key: keyof FormState) => {
    const original = corrected[key];
    if (original === undefined) return;
    set(key, original);
    setCorrected((c) => {
      const next = { ...c };
      delete next[key];
      return next;
    });
  };

  /** Suggestions for one field: what the fleet already uses, else the fallback. */
  const optionsFor = (key: string) =>
    (suggestions[key]?.length ? suggestions[key] : FALLBACK_OPTS[key] ?? []).map(
      (v) => ({ value: v }),
    );

  const matches = (input: string, opt?: { value?: string | number }) =>
    String(opt?.value ?? "")
      .toLowerCase()
      .includes(input.toLowerCase());

  return (
    <Modal
      title={t(isEdit ? "deviceForm.edit" : "deviceForm.create")}
      onClose={onClose}
    >
      <form className="modal-form" noValidate onSubmit={handleSubmit}>
        <div className="form-section">
          <div className="form-section-label">Identity</div>
          <div className="form-grid">
            <label className="form-field">
              <span>
                Serial Number<span className="req">*</span>
              </span>
              <Input
                ref={serialRef}
                value={form.serial_number}
                required
                aria-invalid={serialError || undefined}
                status={serialError ? "error" : undefined}
                disabled={isEdit}
                placeholder={t("deviceForm.serialPlaceholder")}
                onChange={(e) => {
                  if (serialError) setSerialError(false);
                  set("serial_number", e.target.value);
                }}
              />
            </label>

            <label className="form-field">
              <span>{t("deviceForm.name")}</span>
              <AutoComplete
                style={{ width: "100%" }}
                value={form.name}
                options={optionsFor("name")}
                placeholder={t("deviceForm.namePlaceholder")}
                filterOption={matches}
                onChange={(v) => set("name", v)}
              />
            </label>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-label">Assignment</div>
          <div className="form-grid">
            <label className="form-field">
              <span>{t("deviceForm.owner")}</span>
              <Select
                showSearch
                optionFilterProp="label"
                value={form.user_id}
                onChange={setOwner}
                options={userOptions}
              />
            </label>

            <label className="form-field">
              <span>{t("deviceForm.status")}</span>
              <Select
                value={form.status}
                onChange={setStatus}
                options={statusOptions}
              />
            </label>
          </div>
          {isItHeld(form.status) ? (
            <p className="info-callout">
              {t("deviceForm.itHeld", {
                status: DEVICE_STATUS_META[form.status].label,
              })}
            </p>
          ) : (
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
                  placeholder={t("deviceForm.datePlaceholder")}
                  value={form.buy_date ? dayjs(form.buy_date) : null}
                  onChange={(d) =>
                    set("buy_date", d ? d.format("YYYY-MM-DD") : "")
                  }
                />
              );
            } else if ((AUTO_FIELDS as readonly string[]).includes(f.key)) {
              control = (
                <AutoComplete
                  style={{ width: "100%" }}
                  options={optionsFor(f.key)}
                  value={form[f.key]}
                  placeholder={f.placeholder}
                  filterOption={matches}
                  onChange={(v) => set(f.key, v)}
                  // Tidy up on blur, never mid-typing: correcting while someone
                  // is still in the middle of a word fights them.
                  onBlur={() => tidy(f.key)}
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
                <span>{t(f.label)}</span>
                {control}
                {corrected[f.key] && (
                  <span className="field-corrected">
                    {t("device.autoFixed", { value: corrected[f.key] ?? "" })}
                    <button
                      type="button"
                      className="field-undo"
                      onClick={() => undoTidy(f.key)}
                    >
                      {t("device.undoFix")}
                    </button>
                  </span>
                )}
              </label>
            );
          })}
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <Button onClick={onClose} disabled={submitting}>
            {t("form.cancel")}
          </Button>
          <Button type="primary" htmlType="submit" loading={submitting}>
            {t(isEdit ? "form.save" : "deviceForm.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
