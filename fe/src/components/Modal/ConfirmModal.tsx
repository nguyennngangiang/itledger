import { Button } from "antd";
import { Modal } from "./Modal";
import { useT } from "../../i18n/useT";

type ConfirmModalProps = {
  /** Already-translated text — callers build it from their own keys. */
  message?: string;
  onConfirm: () => void;
  onCancel?: () => void;
};

export function ConfirmModal({
  message,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { t } = useT();
  const handleCancel = onCancel ?? (() => {});

  return (
    <Modal title={t("confirm.title")} onClose={handleCancel}>
      <div className="modal-form">
        <p className="confirm-body">{message ?? t("confirm.default")}</p>
        <div className="modal-actions">
          <Button onClick={handleCancel}>{t("confirm.cancel")}</Button>
          <Button danger type="primary" onClick={onConfirm}>
            {t("confirm.ok")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
