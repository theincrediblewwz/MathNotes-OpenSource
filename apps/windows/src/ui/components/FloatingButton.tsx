import type { ButtonHTMLAttributes, ReactNode } from "react";

type FloatingButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  badge?: string;
  variant?: "default" | "dark" | "small";
};

export function FloatingButton({ icon, badge, variant = "default", className = "", ...props }: FloatingButtonProps) {
  const classes = ["float-btn", variant === "dark" ? "dark" : "", variant === "small" ? "small" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={classes} type="button" {...props}>
      {icon}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  );
}
