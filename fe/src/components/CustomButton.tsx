import React from "react";

interface CustomButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  /** Tailwind background color class, e.g. "bg-blue-500" */
  color?: string;
  /** Tailwind hover background class, e.g. "hover:bg-blue-600" */
  hoverColor?: string;
}

const CustomButton: React.FC<CustomButtonProps> = ({
  children,
  color = "",
  hoverColor = "hover:bg-blue-600",
  className = "",
  ...props
}) => {
  return (
    <button
      className={`cursor-pointer rounded-md px-4 py-2 text-white transition-colors duration-200 ${color} ${hoverColor} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

export default CustomButton;
