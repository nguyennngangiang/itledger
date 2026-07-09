import { Modal as AntModal } from "antd";

type ModalProps = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
};

export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <AntModal
      title={title}
      open
      onCancel={onClose}
      footer={null}
      centered
      destroyOnHidden
    >
      {children}
    </AntModal>
  );
}
