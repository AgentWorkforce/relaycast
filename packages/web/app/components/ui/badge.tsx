import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const variantClasses = {
  default: "border-[var(--border-default)] bg-[var(--surface-soft)] text-[var(--text-secondary)]",
  success: "border-transparent bg-[var(--status-success-soft)] text-[var(--status-success)]",
  warning: "border-transparent bg-[var(--status-warning-soft)] text-[var(--status-warning)]",
  danger: "border-transparent bg-[var(--status-danger-soft)] text-[var(--status-danger)]",
  info: "border-transparent bg-[var(--status-info-soft)] text-[var(--status-info)]",
} as const;

type BadgeVariant = keyof typeof variantClasses;

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLDivElement> & { variant?: BadgeVariant }) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-[0.18em]",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
