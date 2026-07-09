import { useEffect, useState } from "react";
import { Button, Input, Select } from "antd";
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
      <form className="modal-form" onSubmit={handleSubmit}>
        <div className="form-grid">
          <label className="form-field">
            <span>
              Employee code<span className="req">*</span>
            </span>
            <Input
              value={formData.employee_code}
              onChange={(e) => handleInputChange(e)}
              required
              placeholder="VPHN000"
              name="employee_code"
              disabled={isEdit}
            />
          </label>

          <label className="form-field">
            <span>
              Name<span className="req">*</span>
            </span>
            <Input
              value={formData.name || ""}
              onChange={(e) => handleInputChange(e)}
              required
              placeholder="Nguyen Van A"
              name="name"
            />
          </label>

          <label className="form-field form-field-full">
            <span>
              Team<span className="req">*</span>
            </span>
            <Select
              value={formData.team || undefined}
              placeholder="Select a team"
              onChange={(value) =>
                handleInputChange({
                  target: { name: "team", value },
                } as React.ChangeEvent<HTMLSelectElement>)
              }
              options={teamsOptions.map((t) => ({
                value: t.team_id,
                label: t.team_name,
              }))}
            />
          </label>
        </div>

        <div className="modal-actions">
          <Button onClick={onClose}>Cancel</Button>

          <Button type="primary" htmlType="submit">
            {isEdit ? "Update" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
