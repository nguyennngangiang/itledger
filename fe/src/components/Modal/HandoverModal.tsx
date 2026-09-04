import { useEffect, useState } from "react";
import { AutoComplete, Button, DatePicker, Select } from "antd";
import dayjs from "dayjs";
import { listDevices } from "../../api/devices";
import {
  createHandoverBatch,
  handoverSuggestions,
  updateHandover,
} from "../../api/handovers";
import { listUsers } from "../../api/users";
import { ApiError } from "../../api/client";
import type { Device, Handover, HandoverCreate, User } from "../../types";
import { DEVICE_STATUS_META, GHOST_USER_CODE } from "../../types";
import { newId } from "../../lib/id";
import { deriveStatus, ownerOptionLabel, todayIsoDate } from "../../lib/format";
import { Modal } from "./Modal";
import { useT } from "../../i18n/useT";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** One line of the record: a device and the person handing it over.
 *
 * A record now routinely moves two or three machines at once, and those machines
 * are not necessarily coming from the same person — IT collecting three laptops
 * back into the store collects them from three desks. So the recipient, the date
 * and the reason belong to the record, while `from` belongs to the line. That is
 * also the shape the spreadsheet importer produces (be/handover_sheet.py reads a
 * multi-row item table), so both entry paths now agree.
 */
type Line = { serial: string; from: string };

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
  const [lines, setLines] = useState<Line[]>([]);
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

  // Prefill when editing an existing handover. A ledger row is still one device,
  // so editing works on exactly one line — the multi-device part is about
  // recording a new record, not about rewriting one that was already written.
  useEffect(() => {
    if (isEdit && handover) {
      setLines(
        handover.device_id
          ? [{ serial: handover.device_id, from: handover.from_user_id ?? "" }]
          : [],
      );
      setToEmployeeCode(handover.to_user_id ?? "");
      setHandoverDate(handover.handover_date ?? todayIsoDate());
      setReason(handover.reason ?? "");
    }
  }, [isEdit, handover]);

  /** Picking devices fills in who is handing each one over — by definition that
   *  is the device's current owner, and we already hold that in memory. Lines
   *  already on screen keep whatever `from` was typed on them; only the newly
   *  picked serials are filled in. */
  const handleDevicesChange = (value: string | string[]) => {
    const serials = Array.isArray(value) ? value : value ? [value] : [];
    setLines((prev) => {
      const existing = new Map(prev.map((line) => [line.serial, line]));
      return serials.map((serial) => {
        const kept = existing.get(serial);
        if (kept) return kept;
        const dev = devices.find((d) => d.serial_number === serial);
        return { serial, from: dev ? dev.user_id ?? GHOST_USER_CODE : "" };
      });
    });
  };

  const setLineFrom = (serial: string, from: string) =>
    setLines((prev) =>
      prev.map((line) => (line.serial === serial ? { ...line, from } : line)),
    );

  const removeLine = (serial: string) =>
    setLines((prev) => prev.filter((line) => line.serial !== serial));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (lines.length === 0) {
      setError(t("handoverForm.noDevice"));
      return;
    }
    // Named per device rather than as one blanket message: with three machines on
    // screen, "from and to must differ" does not say which one is wrong.
    const clash = lines.find((line) => line.from === toEmployeeCode);
    if (clash) {
      setError(t("handoverForm.samePersonFor", { serial: clash.serial }));
      return;
    }

    setSubmitting(true);

    try {
      if (isEdit && handover) {
        const [line] = lines;
        await updateHandover(handover.handover_id, {
          handover_date: handoverDate,
          device_id: line.serial,
          from_user_id: line.from,
          to_user_id: toEmployeeCode,
          reason: emptyToNull(reason),
        });
        onClose();
        return;
      }

      // One call, one transaction. Recording the handover and moving the device
      // used to be two separate requests from here, so a failure between them
      // left the history written and the machine still on its old owner — and
      // three devices meant six requests and six ways to end up half-recorded.
      // POST /handovers/batch does both for every line or neither for any.
      const records: HandoverCreate[] = lines.map((line) => ({
        handover_id: newId(),
        handover_date: handoverDate,
        device_id: line.serial,
        from_user_id: line.from,
        to_user_id: toEmployeeCode,
        reason: emptyToNull(reason),
      }));

      await createHandoverBatch(records);
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
        : isEdit
          ? "handoverForm.pickDevice"
          : "handoverForm.pickDevices",
  );
  const employeePlaceholder = t(
    loading
      ? "handoverForm.loadingEmployees"
      : loadError
        ? "handoverForm.employeesFailed"
        : "handoverForm.pickEmployee",
  );

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

  const labelOf = (serial: string) =>
    deviceOptions.find((o) => o.value === serial)?.label ?? serial;

  return (
    <Modal
      title={t(isEdit ? "handoverForm.edit" : "handoverForm.create")}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={handleSubmit}>
        <div className="form-grid">
          <label className="form-field form-field-full">
            <span>
              {t(isEdit ? "handoverForm.device" : "handoverForm.devices")}
              <span className="req">*</span>
            </span>
            <Select
              // The picker IS the list: removing a tag removes the line, so there
              // is no separate "add row" button to keep in sync with it. Editing
              // stays single — one ledger row is one device.
              mode={isEdit ? undefined : "multiple"}
              showSearch
              optionFilterProp="label"
              value={
                isEdit
                  ? lines[0]?.serial || undefined
                  : lines.map((line) => line.serial)
              }
              placeholder={devicePlaceholder}
              disabled={disabled}
              onChange={handleDevicesChange}
              options={deviceOptions}
            />
          </label>

          {lines.length > 0 && (
            <ul className="form-field-full handover-lines">
              {lines.map((line) => {
                const dev = devices.find((d) => d.serial_number === line.serial);
                // What this line will do to this machine. Shown per line rather
                // than in one summary because the answer differs between them: a
                // device coming back to the store keeps `maintaining` if that is
                // where it was, while its neighbour becomes `in_stock`.
                const after = toEmployeeCode
                  ? DEVICE_STATUS_META[
                      deriveStatus(toEmployeeCode, dev?.status ?? null)
                    ]
                  : null;
                return (
                  <li key={line.serial} className="handover-line">
                    <span className="handover-line-device" title={line.serial}>
                      {labelOf(line.serial)}
                    </span>
                    <label className="handover-line-from">
                      <span>{t("handoverForm.from")}</span>
                      <Select
                        showSearch
                        optionFilterProp="label"
                        value={line.from || undefined}
                        placeholder={employeePlaceholder}
                        disabled={disabled}
                        onChange={(value) => setLineFrom(line.serial, value)}
                        options={userOptions}
                      />
                    </label>
                    {after && (
                      <span className={`pill ${after.pill}`}>{after.label}</span>
                    )}
                    {!isEdit && (
                      <Button
                        type="text"
                        size="small"
                        disabled={submitting}
                        aria-label={t("handoverForm.removeDevice")}
                        title={t("handoverForm.removeDevice")}
                        onClick={() => removeLine(line.serial)}
                      >
                        ✕
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

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

          <label className="form-field form-field-full">
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

        {/* Who ends up holding the machines. The per-device effect is on each line
            above; this is the one thing the whole record shares — and it is worth
            spelling out, because a return sends the machines to IT-STORE rather
            than to the person who signed for them. */}
        {lines.length > 0 && toEmployeeCode && (
          <p className="info-callout">
            {t("handover.effect", {
              n: lines.length,
              serial: lines[0].serial,
              owner:
                toEmployeeCode === GHOST_USER_CODE
                  ? t("owner.store")
                  : toEmployeeCode,
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
