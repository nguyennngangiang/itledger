import { Button } from "antd";
import { Modal } from "./Modal";

type ConfirmModalProps = {
  message?: string;
  onConfirm: () => void;
  onCancel?: () => void;
};

export function ConfirmModal({
  message = "Are you sure you want to proceed?",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const handleCancel = onCancel ?? (() => {});

  return (
    <Modal title="Confirm" onClose={handleCancel}>
      <div className="modal-form">
        <p className="confirm-body">{message}</p>
        <div className="modal-actions">
          <Button onClick={handleCancel}>Cancel</Button>
          <Button danger type="primary" onClick={onConfirm}>
            Confirm
          </Button>
        </div>
      </div>
    </Modal>
  );
}
