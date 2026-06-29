import CustomButton from "../CustomButton";
type ModalProps = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
};

export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <CustomButton
            type="button"
            onClick={onClose}
            hoverColor="hover:bg-red-500"
          >
            ×
          </CustomButton>
        </div>
        {children}
      </div>
    </div>
  );
}
