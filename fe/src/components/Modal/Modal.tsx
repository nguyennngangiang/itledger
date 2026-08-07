import { useEffect, useRef } from "react";
import { Modal as AntModal } from "antd";

type ModalProps = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Wider than the antd default, for side-by-side comparisons (import wizard). */
  width?: number | string;
};

export function Modal({ title, onClose, children, width }: ModalProps) {
  // Every caller closes by unmounting this component (`{flag && <Modal/>}`),
  // which tears the dialog down before antd can hand focus back — a keyboard
  // user pressing Escape ends up on <body> and has to tab from the top again.
  // Remember whatever opened us and restore it ourselves, so it works the same
  // for Escape, the X, a Cancel button and a successful save.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    return () => {
      const el = opener.current;
      if (el?.isConnected) el.focus();
    };
  }, []);

  return (
    <AntModal
      title={title}
      open
      onCancel={onClose}
      footer={null}
      centered
      destroyOnHidden
      width={width}
    >
      {children}
    </AntModal>
  );
}
