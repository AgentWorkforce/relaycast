'use client';

/**
 * A Connect observer that could not load for a temporary reason (rate limit,
 * engine outage, network). Distinct from the revoked/invalid state: the link
 * may be fine. The capability was stripped from the address bar on open, so
 * recovery has to happen in this tab, not by reloading.
 */
export function ConnectObserverTemporaryState({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <main className="brand-grid flex min-h-screen items-center justify-center px-4">
      <section className="brand-glass w-full max-w-xl rounded-[2rem] p-8 text-center sm:p-10" aria-live="polite">
        <img src="/observer/brand/agent-relay-mark.svg" alt="Agent Relay" className="mx-auto h-10 w-auto" />
        <h1 className="brand-title mt-6 text-2xl font-semibold text-[var(--foreground)]">
          Observer temporarily unavailable
        </h1>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          {retrying
            ? 'Agent Relay is busy. Retrying automatically…'
            : 'Agent Relay is still busy. Try again in a minute. Use the button here: reloading this page needs the original link.'}
        </p>
        {retrying ? null : (
          <button
            type="button"
            onClick={onRetry}
            className="mt-6 rounded-full bg-[var(--brand-primary)] px-5 py-2 text-sm font-semibold text-white"
          >
            Try again
          </button>
        )}
      </section>
    </main>
  );
}
