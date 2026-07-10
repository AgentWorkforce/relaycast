import type { ReactNode } from "react";

/**
 * The reading surface for a dashboard page. The shell paints a gradient
 * backdrop; content must not read directly on it, so each page sits on one
 * solid, contained panel (a single surface — not nested cards). The gradient
 * survives only as a frame in the gutter and behind the sidebar.
 */
export function PageSurface({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto w-full max-w-6xl rounded-2xl border border-[var(--border-default)] bg-[var(--section-bg)] p-6 shadow-[0_24px_60px_-40px_var(--dashboard-shadow)] md:p-10">
        {children}
      </div>
    </div>
  );
}
