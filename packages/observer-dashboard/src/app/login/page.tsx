'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setAuth } from '../../lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!apiKey.startsWith('rk_live_')) {
      setError('API key must start with rk_live_');
      return;
    }

    setLoading(true);
    const success = await setAuth(apiKey);
    setLoading(false);

    if (!success) {
      setError('Invalid API key or server unreachable');
      return;
    }

    router.push('/');
  }

  return (
    <div className="brand-grid relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(52rem_28rem_at_12%_0%,rgba(74,144,194,0.22),transparent_54%),radial-gradient(30rem_22rem_at_84%_16%,rgba(4,209,246,0.12),transparent_48%),radial-gradient(36rem_24rem_at_100%_100%,rgba(193,103,75,0.12),transparent_50%)]" />
      <div className="pointer-events-none absolute inset-y-0 left-[12%] w-px bg-[linear-gradient(to_bottom,transparent,rgba(74,144,194,0.18),transparent)]" />
      <div className="relative mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-10">
        <section className="brand-glass w-full max-w-xl rounded-[1.5rem] p-7 sm:p-8">
          <div className="brand-kicker mb-4">Agent Relay / Observer</div>
          <div className="flex items-end gap-3">
            <img src="/observer/brand/agent-relay-mark.svg" alt="Agent Relay" className="h-10 w-auto shrink-0" />
            <h1 className="brand-title text-4xl font-black uppercase tracking-[0.08em] sm:text-[2.7rem]">
              <span className="observer-wordmark">Observer</span>
            </h1>
          </div>
          <p className="mt-4 max-w-md text-sm leading-6 text-[var(--text-secondary)] sm:text-[0.95rem]">
            Live channels, agents, DMs, and console telemetry in a brighter observer control surface.
          </p>

          <div className="mt-7 border-t border-[color-mix(in_srgb,var(--brand-primary)_16%,rgba(122,122,114,0.18))] pt-7">
            <div className="brand-kicker mb-3">Secure Workspace Access</div>
            <h2 className="brand-title text-[1.65rem] font-semibold text-[var(--foreground)]">Sign in with your workspace API key</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">Use an <code className="rounded-md bg-[color-mix(in_srgb,var(--brand-primary-faint)_78%,transparent)] px-1.5 py-0.5 text-[var(--brand-primary-strong)]">rk_live_…</code> key to establish your observer session.</p>

            <form onSubmit={handleSubmit} className="mt-7 space-y-5">
              <div>
                <label htmlFor="apiKey" className="mb-2 block text-sm font-medium text-[var(--text-secondary)]">
                  API key
                </label>
                <input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full rounded-2xl border border-[color-mix(in_srgb,var(--brand-primary)_18%,rgba(122,122,114,0.22))] bg-[color-mix(in_srgb,var(--surface-strong)_92%,rgba(255,255,255,0.55))] px-4 py-3 text-sm text-[var(--foreground)] placeholder:text-[var(--text-faint)] shadow-[inset_0_1px_0_rgba(255,255,255,0.42)] focus:border-[var(--brand-observer)] focus:outline-none focus:ring-2 focus:ring-[rgba(4,209,246,0.18)]"
                  placeholder="rk_live_..."
                  autoFocus
                />
              </div>

              {error && (
                <p className="rounded-2xl border border-[var(--status-danger)]/25 bg-[var(--status-danger-soft)] px-4 py-3 text-sm text-[var(--status-danger)]">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || !apiKey}
                className="w-full cursor-pointer rounded-2xl bg-[var(--brand-primary)] px-4 py-3 text-sm font-semibold text-white shadow-[0_18px_30px_-18px_rgba(74,144,194,0.9)] transition-all hover:-translate-y-0.5 hover:bg-[var(--brand-primary-strong)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              >
                {loading ? 'Validating…' : 'Enter observer'}
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
