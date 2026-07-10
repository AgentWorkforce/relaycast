import Link from "next/link";

type SearchParams = Promise<{
  status?: string;
  detail?: string;
}>;

function decodeDetail(detail: string | undefined) {
  if (!detail) {
    return null;
  }

  return detail.length > 240 ? `${detail.slice(0, 239)}…` : detail;
}

export default async function CliAuthResultPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const status = params.status === "error" ? "error" : "success";
  const detail = decodeDetail(params.detail);

  const title = status === "success" ? "CLI connected" : "CLI login failed";
  const message =
    status === "success"
      ? "Authentication succeeded. Return to your terminal to continue the command."
      : "The browser sign-in flow did not complete successfully. Return to your terminal and try again.";
  const accent = status === "success" ? "text-[var(--status-success)]" : "text-[var(--status-danger)]";
  const accentBorder =
    status === "success"
      ? "border-[var(--status-success)] bg-[var(--status-success-soft)]"
      : "border-[var(--status-danger)] bg-[var(--status-danger-soft)]";
  const pill =
    status === "success"
      ? "border-[var(--status-success)] bg-[var(--status-success-soft)] text-[var(--status-success)]"
      : "border-[var(--status-danger)] bg-[var(--status-danger-soft)] text-[var(--status-danger)]";

  return (
    <main className="brand-shell brand-grid min-h-screen px-4 py-12">
      <div className="relative mx-auto flex min-h-[calc(100vh-6rem)] max-w-3xl items-center justify-center">
        <section className="brand-card w-full overflow-hidden rounded-[28px]">
          <div className="border-b border-[var(--border-default)] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--brand-primary)_18%,transparent),var(--surface-strong),transparent)] px-8 py-8">
            <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] ${pill}`}>
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: status === "success" ? "var(--status-success)" : "var(--status-danger)" }}
              />
              Cloud CLI
            </div>
            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-[var(--fg)]">{title}</h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--fg-muted)]">{message}</p>
          </div>

          <div className="space-y-5 px-8 py-8">
            <div className={`rounded-2xl border p-5 ${accentBorder}`}>
              <p className={`text-sm font-semibold uppercase tracking-[0.18em] ${accent}`}>Next step</p>
              <p className="mt-3 text-sm leading-7 text-[var(--fg)]">
                Return to your terminal. You can close this tab once the CLI resumes.
              </p>
            </div>

            {detail ? (
              <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-5">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
                  Details
                </p>
                <p className="mt-3 font-mono text-sm leading-7 text-[var(--fg)]">{detail}</p>
              </div>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-[var(--fg-faint)]">Agent Relay Cloud CLI</p>
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-glass)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-strong)]"
              >
                Back to dashboard
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
