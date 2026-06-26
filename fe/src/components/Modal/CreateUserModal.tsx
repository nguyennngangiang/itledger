import { useEffect, useState } from "react";
import { createUser, updateUser } from "../../api/users";
import type { UserCreate } from "../../types";
import { Modal } from "./Modal";
import { teamsOptions } from "../../types";
import { useLoading } from "../../hook/LoadingContext";

export function CreateUserModal({
  onClose,
  isEdit,
  selectedUser,
}: {
  onClose: () => void;
  isEdit: boolean;
  selectedUser?: UserCreate;
}) {
  const [formData, setFormData] = useState<UserCreate>({
    employee_code: "",
    name: "",
    team: "",
  });
  const { startLoading } = useLoading();

  const handleInputChange = (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    const { name, value } = event.target;
    setFormData((prevData) => ({
      ...prevData,
      [name]: value,
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const payload: UserCreate = {
      employee_code: formData.employee_code.trim(),
      name: formData?.name?.trim() || " ",
      team: formData?.team?.trim() || " ",
    };

    try {
      startLoading();
      if (isEdit) {
        await updateUser(formData.employee_code, payload);
      } else {
        await createUser(payload);
      }
      onClose();
    } catch (err) {
      console.log("Error creating user:", err);
    } finally {
      setTimeout(() => {
        onClose();
      }, 1000);
    }
  };

  useEffect(() => {
    if (isEdit && selectedUser) {
      setFormData(selectedUser);
    }
  }, [isEdit, selectedUser]);

  return (
    <Modal title={isEdit ? "Edit User" : "Create User"} onClose={onClose}>
      <form className="modal-form user-form" onSubmit={handleSubmit}>
        <div className="user-grid">
          <label>
            Employee code *
            <input
              type="text"
              value={formData.employee_code}
              onChange={(e) => handleInputChange(e)}
              required
              placeholder="VPHN000"
              name="employee_code"
              disabled={isEdit}
            />
          </label>

          <label>
            Name *
            <input
              type="text"
              value={formData.name || ""}
              onChange={(e) => handleInputChange(e)}
              required
              placeholder="Nguyen Van A"
              name="name"
            />
          </label>

          <label className="user-team">
            Team *
            <select
              value={formData.team || ""}
              onChange={(e) => handleInputChange(e)}
              required
              name="team"
              defaultValue={selectedUser?.team || ""}
            >
              <option value="" disabled>
                Select a team
              </option>
              {teamsOptions.map((t) => (
                <option key={t.team_id} value={t.team_id}>
                  {t.team_name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="modal-actions">
          <button className="cancel-btn" type="button" onClick={onClose}>
            Cancel
          </button>

          <button className="create-btn" type="submit">
            {isEdit ? "Update" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
