import { useEffect, useState } from "react";
import { AutoComplete, Button, Input, Select } from "antd";
import { createUser, listUserTeams, updateUser } from "../../api/users";
import { ApiError } from "../../api/client";
import type { User, UserCreate, UserStatus } from "../../types";
import { Modal } from "./Modal";
import { useT } from "../../i18n/useT";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function EmployeeModal({
  onClose,
  isEdit = false,
  user,
}: {
  onClose: () => void;
  isEdit?: boolean;
  user?: User;
}) {
  // Seeded straight from the props: callers mount this fresh per record
  // (`{editTarget && <EmployeeModal …/>}`), so there is nothing to sync later.
  const { t } = useT();
  const [employeeCode, setEmployeeCode] = useState(user?.employee_code ?? "");
  const [name, setName] = useState(user?.name ?? "");
  const [team, setTeam] = useState(user?.team ?? "");
  // Chức vụ — a different thing from Department. Handover minutes carry both, and
  // the live data shows what happens when they share a column (VPHN228 was stored
  // with team "IT", which is his title; his department is Operation).
  const [status, setStatus] = useState<UserStatus>(user?.status ?? "active");
  const [teams, setTeams] = useState<string[]>([]);
  const [codeError, setCodeError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Teams come from the data, not a hardcoded list — there is no teams table
  // and the real column holds ~67 values that keep growing. Free text stays
  // allowed (AutoComplete, not Select) so a new department is not a blocker.
  useEffect(() => {
    listUserTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!isEdit && !employeeCode.trim()) {
      setCodeError(true);
      setError(t("form.required", { field: t("employeeForm.code") }));
      return;
    }
    setCodeError(false);
    setSubmitting(true);

    try {
      if (isEdit && user) {
        // employee_code is the primary key — only the editable fields go out.
        await updateUser(user.employee_code, {
          name: emptyToNull(name),
          team: emptyToNull(team),
          status,
        });
        onClose();
        return;
      }

      const record: UserCreate = {
        employee_code: employeeCode.trim(),
        name: emptyToNull(name),
        team: emptyToNull(team),
        status,
      };
      await createUser(record);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError ? String(err.message) : t("employeeForm.failed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const teamOptions = teams.map((t) => ({ value: t }));

  return (
    <Modal
      title={t(isEdit ? "employeeForm.edit" : "employeeForm.create")}
      onClose={onClose}
    >
      <form className="modal-form" noValidate onSubmit={handleSubmit}>
        <div className="form-grid">
          <label className="form-field">
            <span>
              Employee Code<span className="req">*</span>
            </span>
            <Input
              value={employeeCode}
              disabled={isEdit}
              status={codeError ? "error" : undefined}
              aria-invalid={codeError || undefined}
              placeholder={t("employeeForm.codePlaceholder")}
              onChange={(e) => {
                if (codeError) setCodeError(false);
                setEmployeeCode(e.target.value);
              }}
            />
          </label>

          <label className="form-field">
            <span>{t("employeeForm.name")}</span>
            <Input
              value={name}
              placeholder={t("employee.namePlaceholder")}
              disabled={submitting}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="form-field">
            <span>{t("employeeForm.team")}</span>
            <AutoComplete
              style={{ width: "100%" }}
              value={team}
              options={teamOptions}
              placeholder={t("employeeForm.teamPlaceholder")}
              disabled={submitting}
              filterOption={(input, opt) =>
                String(opt?.value ?? "")
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              onChange={setTeam}
            />
          </label>

          <label className="form-field">
            <span>{t("employeeForm.status")}</span>
            <Select
              value={status}
              disabled={submitting}
              options={[
                { value: "active", label: t("employee.status.active") },
                { value: "retired", label: t("employee.status.retired") },
              ]}
              onChange={setStatus}
            />
            <span className="text-faint">{t("employeeForm.statusHint")}</span>
          </label>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <Button onClick={onClose} disabled={submitting}>
            {t("form.cancel")}
          </Button>
          <Button type="primary" htmlType="submit" loading={submitting}>
            {t(isEdit ? "form.save" : "employeeForm.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default EmployeeModal;
