import { useEffect, useState } from "react";
import { AutoComplete, Button, DatePicker, Select } from "antd";
import dayjs from "dayjs";
import { listDevices, updateDevice } from "../../api/devices";
import {
  createHandover,
  handoverSuggestions,
  updateHandover,
} from "../../api/handovers";
import { listUsers } from "../../api/users";
import { ApiError } from "../../api/client";
import type { Device, Handover, HandoverCreate, User } from "../../types";
import { GHOST_USER_CODE } from "../../types";
import { newId } from "../../lib/id";
import { deriveStatus, ownerOptionLabel, todayIsoDate } from "../../lib/format";
import { Modal } from "./Modal";
import { useT } from "../../i18n/useT";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Picking this reason means the machine is coming back to IT, so the receiver is
// the IT-STORE ghost and the device lands in stock. Recognised by meaning, not by
// exact string, so a Vietnamese or lower-cased variant still works.
//
// DO NOT put REASON_OPTS through the i18n catalog. The reason is free text saved
// verbatim on the handover row, and `looksLikeReturn` reads it back to decide
// where the device goes — a translated option would silently stop routing devices
// to the store. Registered in i18n/exclusions.ts; check-i18n.mjs enforces it.
const RETURN_TO_STORE = "Return to IT";

/** Diacritic-folded, so "Trả về kho" matches the ASCII phrase the server sends. */
const fold = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase();

/** Is this person on the IT team? Same token match as be/handover_import._looks_it,
 * so "UNIT" and "AUDIT" do not count but "IT" and "IT Support" do. */
const isItStaff = (user: User | undefined) =>
  fold(user?.team ?? "").replace(/[/-]/g, " ").split(/\s+/).includes("it");

/** Does this reason mean the machine is coming back to IT?
 *
 * The phrases come from the server (GET /handovers/suggestions -> return_phrases,
 * be/handover_import.UNAMBIGUOUS_RETURN) rather than a copy kept here. The copy
 * that used to live here had drifted: it knew "return to it" and "trả về kho" but
 * not "Resignation Return", so those rows were treated as ordinary hand-outs and
 * left machines standing in an IT staffer's name.
 *
 * Always paired with an IT check by `routeToStore` below — never read alone.
 * "Replacement" is in the list and runs in both directions, so the reason on its
 * own decides nothing. */
const looksLikeReturn = (reason: string, phrases: string[]) => {
  const r = fold(reason);
  return phrases.some((p) => r.includes(p));
};

// The handful of reasons a device actually changes hands here. Free text still
// allowed — this is an AutoComplete, not a Select. These are merged with the
// reasons already in the ledger (GET /handovers/suggestions), because a hardcoded
// list alone never shows how the team actually words things.
const REASON_OPTS = [
  "New hire",
  "Resignation",
  "Team transfer",
  "Device replacement",
  "Temporary loan",
  RETURN_TO_STORE,
  "Upgrade",
];

function HandoverModal({
  onClose,
  isEdit = false,
  handover,
}: {
  onClose: () => void;
  isEdit?: boolean;
  handover?: Handover;
}) {
  const { t } = useT();
  const [serialNumber, setSerialNumber] = useState("");
  const [fromEmployeeCode, setFromEmployeeCode] = useState("");
  const [toEmployeeCode, setToEmployeeCode] = useState("");
  const [handoverDate, setHandoverDate] = useState(todayIsoDate());
  const [reason, setReason] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [reasonHints, setReasonHints] = useState<string[]>([]);
  const [returnPhrases, setReturnPhrases] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([listDevices(), listUsers(), handoverSuggestions()])
      .then(([deviceList, userList, hints]) => {
        setDevices(deviceList);
        setUsers(userList);
        setReasonHints(hints.reason ?? []);
        setReturnPhrases(hints.return_phrases ?? []);
      })
      .catch((err) => {
        setLoadError(
          err instanceof ApiError
            ? String(err.message)
            : t("handoverForm.loadFailed"),
        );
      })
      .finally(() => setLoading(false));
  }, [t]);

  // Prefill when editing an existing handover.
  useEffect(() => {
    if (isEdit && handover) {
      setSerialNumber(handover.device_id ?? "");
      setFromEmployeeCode(handover.from_user_id ?? "");
      setToEmployeeCode(handover.to_user_id ?? "");
      setHandoverDate(handover.handover_date ?? todayIsoDate());
      setReason(handover.reason ?? "");
    }
  }, [isEdit, handover]);

  /** Picking a device fills in who is handing it over — by definition that is
   *  the device's current owner, and we already hold that in memory. */
  const handleDeviceChange = (serial: string) => {
    setSerialNumber(serial);
    const dev = devices.find((d) => d.serial_number === serial);
    if (dev) setFromEmployeeCode(dev.user_id ?? GHOST_USER_CODE);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (fromEmployeeCode === toEmployeeCode) {
      setError(t("handoverForm.samePerson"));
      return;
    }

    setSubmitting(true);

    try {
      if (isEdit && handover) {
        await updateHandover(handover.handover_id, {
          handover_date: handoverDate,
          device_id: serialNumber,
          from_user_id: fromEmployeeCode,
          to_user_id: toEmployeeCode,
          reason: emptyToNull(reason),
        });
        onClose();
        return;
      }

      const record: HandoverCreate = {
        handover_id: newId(),
        handover_date: handoverDate,
        device_id: serialNumber,
        from_user_id: fromEmployeeCode,
        to_user_id: toEmployeeCode,
        reason: emptyToNull(reason),
      };

      await createHandover(record);

      // Recording the handover is only half of it — the device itself has to
      // change hands, or the fleet still shows the previous owner. Status
      // follows the new owner (deriveStatus keeps maintaining/on_del as-is).
      const dev = devices.find((d) => d.serial_number === serialNumber);
      try {
        await updateDevice(serialNumber, {
          user_id: toEmployeeCode,
          status: deriveStatus(toEmployeeCode, dev?.status ?? null),
        });
      } catch {
        // The handover is already recorded; don't lose it over this.
        setError(
          t("handoverForm.ownerNotUpdated"),
        );
      }

      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? String(err.message)
          : t("handoverForm.failed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = loading || !!loadError || submitting;
  // Whole sentences per noun rather than `Select a ${noun}` — most languages
  // inflect the article and the noun together, so the glued version cannot be
  // translated at all.
  const devicePlaceholder = t(
    loading
      ? "handoverForm.loadingDevices"
      : loadError
        ? "handoverForm.devicesFailed"
        : "handoverForm.pickDevice",
  );
  const employeePlaceholder = t(
    loading
      ? "handoverForm.loadingEmployees"
      : loadError
        ? "handoverForm.employeesFailed"
        : "handoverForm.pickEmployee",
  );

  const selectedDevice = devices.find((d) => d.serial_number === serialNumber);

  /** Choosing a "return to IT" reason routes the device to the store account —
   *  that IS the reason, so making the person pick IT Store again is busywork.
   *  Still editable afterwards; this only sets it, never locks it. */
  /** "Handed to IT with a note saying it is coming back" means the STORE, not the
   * staffer who signed for it.
   *
   * Re-checked whenever EITHER end changes, not just the reason. Only watching the
   * reason left a hole: type "Return to IT" first, pick Vũ Nhật Minh second, and
   * nothing re-ran — the machine went on his name. That is how one person came to
   * be holding 29 devices.
   *
   * The note is still required. A monitor reached him through "New Assignment" and
   * is genuinely his — every IT member keeps one laptop and one monitor — so
   * "recipient is IT" alone would sweep their own kit into the store. */
  const routeToStore = (nextReason: string, nextTo: string) => {
    if (nextTo === GHOST_USER_CODE) return nextTo;
    if (!looksLikeReturn(nextReason, returnPhrases)) return nextTo;
    const recipient = users.find((u) => u.employee_code === nextTo);
    return isItStaff(recipient) ? GHOST_USER_CODE : nextTo;
  };

  const handleReasonChange = (value: string) => {
    setReason(value);
    setToEmployeeCode((to) => routeToStore(value, to));
  };

  const handleToChange = (value: string) => {
    setToEmployeeCode(routeToStore(reason, value));
  };

  // The fixed list plus what the ledger already contains, de-duped case-insensitively.
  const reasonOptions = Array.from(
    new Map(
      [...REASON_OPTS, ...reasonHints].map((v) => [v.toLowerCase(), v]),
    ).values(),
  )
    .sort((a, b) => a.localeCompare(b))
    .map((v) => ({ value: v }));

  const deviceOptions = devices.map((d) => ({
    value: d.serial_number,
    label: d.name ? `${d.name} (${d.serial_number})` : d.serial_number,
  }));
  const userOptions = users.map((u) => ({
    value: u.employee_code,
    label: ownerOptionLabel(u, t),
  }));

  return (
    <Modal
      title={t(isEdit ? "handoverForm.edit" : "handoverForm.create")}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={handleSubmit}>
        <div className="form-grid">
          <label className="form-field form-field-full">
            <span>
              {t("handoverForm.device")}<span className="req">*</span>
            </span>
            <Select
              showSearch
              optionFilterProp="label"
              value={serialNumber || undefined}
              placeholder={devicePlaceholder}
              disabled={disabled}
              onChange={handleDeviceChange}
              options={deviceOptions}
            />
          </label>

          <label className="form-field">
            <span>
              {t("handoverForm.from")}<span className="req">*</span>
            </span>
            <Select
              showSearch
              optionFilterProp="label"
              value={fromEmployeeCode || undefined}
              placeholder={employeePlaceholder}
              disabled={disabled}
              onChange={setFromEmployeeCode}
              options={userOptions}
            />
          </label>

          <label className="form-field">
            <span>
              {t("handoverForm.to")}<span className="req">*</span>
            </span>
            <Select
              showSearch
              optionFilterProp="label"
              value={toEmployeeCode || undefined}
              placeholder={employeePlaceholder}
              disabled={disabled}
              onChange={handleToChange}
              options={userOptions}
            />
          </label>

          <label className="form-field">
            <span>{t("handoverForm.date")}</span>
            <DatePicker
              style={{ width: "100%" }}
              format="DD-MM-YYYY"
              allowClear={false}
              disabled={submitting}
              value={handoverDate ? dayjs(handoverDate) : null}
              onChange={(d) =>
                setHandoverDate(d ? d.format("YYYY-MM-DD") : todayIsoDate())
              }
            />
          </label>

          <label className="form-field">
            <span>{t("handoverForm.reason")}</span>
            <AutoComplete
              style={{ width: "100%" }}
              value={reason}
              options={reasonOptions}
              placeholder={t("form.optional")}
              disabled={submitting}
              filterOption={(input, opt) =>
                String(opt?.value ?? "")
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              onChange={handleReasonChange}
            />
          </label>
        </div>

        {/* What this handover will do to the device. Spelled out because the
            receiver alone does not tell the whole story: a return sends the
            machine to IT-STORE and back into stock. */}
        {serialNumber && toEmployeeCode && (
          <p className="info-callout">
            {t("handover.effect", {
              serial: serialNumber,
              owner:
                toEmployeeCode === GHOST_USER_CODE
                  ? t("owner.store")
                  : toEmployeeCode,
              status: deriveStatus(toEmployeeCode, selectedDevice?.status ?? null),
            })}
          </p>
        )}

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
            disabled={loading || !!loadError}
          >
            {t(isEdit ? "form.save" : "form.submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default HandoverModal;
