import clsx from "clsx";

export function RickyLogo({ className }: { className?: string }) {
  return (
    <img
      src="/ricky-logo.svg"
      alt="Ricky"
      className={clsx(className)}
      width={20}
      height={20}
    />
  );
}
