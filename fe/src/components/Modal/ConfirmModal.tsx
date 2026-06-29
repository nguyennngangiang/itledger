import { Modal } from "./Modal";
import CustomButton from "../CustomButton";

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
        <p className="text-center pt-6 text-md font-bold text-white">
          {message}
        </p>
        <div className="modal-actions">
          <CustomButton hoverColor="hover:bg-sky-500" onClick={handleCancel}>
            Cancel
          </CustomButton>
          <CustomButton hoverColor="hover:bg-red-600" onClick={onConfirm}>
            Confirm
          </CustomButton>
        </div>
      </div>
    </Modal>
  );
}
