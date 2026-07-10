import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Launch Agent",
};

export default function CloudLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(102,126,234,0.24),transparent_34rem),linear-gradient(135deg,var(--dashboard-panel),#080b12_58%,#050609)] text-foreground">
      <main className="mx-auto flex min-h-screen w-full max-w-7xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
