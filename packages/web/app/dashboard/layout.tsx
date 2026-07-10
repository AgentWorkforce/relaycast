import type { ReactNode } from "react";
import { DashboardProvider } from "./_components/dashboard-data";
import { DashboardShell } from "./_components/dashboard-shell";

export default function DashboardLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <DashboardProvider>
      <DashboardShell>{children}</DashboardShell>
    </DashboardProvider>
  );
}
