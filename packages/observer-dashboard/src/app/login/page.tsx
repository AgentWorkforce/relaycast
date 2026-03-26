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
      <div className="relative mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-12 sm:px-6">
        <section className="brand-glass w-full max-w-lg rounded-[2rem] p-8 sm:p-10">
          <div className="flex items-center gap-3">
            <img src="/observer/brand/agent-relay-mark.svg" alt="Agent Relay" className="h-10 w-auto shrink-0" />
            <div className="min-w-0">
              <div className="brand-title text-[1.35rem] font-semibold tracking-tight text-[var(--foreground)]">
                Agent Relay
              </div>
              <div className="mt-2">
                <span className="brand-pill brand-kicker text-[0.62rem] text-[var(--brand-primary-strong)]">Observer</span>
              </div>
            </div>
          </div>

          <div className="mt-10">
            <h1 className="brand-title text-3xl font-semibold tracking-tight text-[var(--foreground)] sm:text-[2.4rem]">
              Enter observer
            </h1>
            <p className="mt-3 text-sm text-[var(--text-secondary)]">
              Workspace key
            </p>

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div className="space-y-2">
                <input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full rounded-[1.35rem] border border-[color-mix(in_srgb,var(--brand-primary)_18%,rgba(122,122,114,0.22))] bg-[color-mix(in_srgb,var(--surface-strong)_94%,rgba(255,255,255,0.55))] px-4 py-3.5 text-sm text-[var(--foreground)] placeholder:text-[var(--text-faint)] shadow-[inset_0_1px_0_rgba(255,255,255,0.42)] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(74,144,194,0.16)]"
                  placeholder="rk_live_..."
                  autoFocus
                />
                <p className="text-xs text-[var(--text-faint)]">Starts with <code className="rounded-md bg-[color-mix(in_srgb,var(--brand-primary-faint)_78%,transparent)] px-1.5 py-0.5 text-[var(--brand-primary-strong)]">rk_live_…</code></p>
              </div>

              {error && (
                <p className="rounded-2xl border border-[var(--status-danger)]/25 bg-[var(--status-danger-soft)] px-4 py-3 text-sm text-[var(--status-danger)]">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || !apiKey}
                className="w-full cursor-pointer rounded-[1.35rem] bg-[var(--brand-primary)] px-4 py-3.5 text-sm font-semibold text-white shadow-[0_18px_30px_-18px_rgba(74,144,194,0.9)] transition-all hover:-translate-y-0.5 hover:bg-[var(--brand-primary-strong)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              >
                {loading ? 'Validating…' : 'Enter'}
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
