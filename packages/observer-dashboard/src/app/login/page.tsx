'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { setAuth } from '../../lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [logoSrc, setLogoSrc] = useState('/observer/brand/agent-relay-logo-black.svg');

  useEffect(() => {
    const root = document.documentElement;
    const updateLogo = () => {
      setLogoSrc(
        root.classList.contains('theme-dark')
          ? '/observer/brand/agent-relay-logo-white.svg'
          : '/observer/brand/agent-relay-logo-black.svg',
      );
    };

    updateLogo();
    const observer = new MutationObserver(updateLogo);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

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
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_8%_0%,rgba(74,144,194,0.16),transparent_55%),radial-gradient(42rem_28rem_at_100%_100%,rgba(193,103,75,0.13),transparent_52%)]" />
      <div className="relative mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-10">
        <div className="brand-glass grid w-full max-w-5xl overflow-hidden md:grid-cols-[1.15fr_0.85fr]">
          <section className="flex flex-col justify-between border-b border-[var(--border-default)] p-8 md:border-b-0 md:border-r md:p-10">
            <div>
              <div className="brand-kicker mb-4">Agent Relay / Observer</div>
              <div className="flex items-end gap-3">
                <img src={logoSrc} alt="Agent Relay" className="h-10 w-auto shrink-0" />
                <h1 className="brand-title text-4xl font-black uppercase tracking-[0.08em] text-[var(--foreground)] md:text-5xl">
                  Observer
                </h1>
              </div>
              <p className="mt-5 max-w-lg text-base leading-7 text-[var(--text-secondary)]">
                Secure access to live channels, agents, DMs, and console telemetry with the new Agent Relay cloud styling system.
              </p>
            </div>

            <div className="mt-8 grid gap-3 text-sm text-[var(--text-secondary)]">
              <div className="brand-soft flex items-start gap-3 p-4">
                <ShieldCheck className="mt-0.5 h-5 w-5 text-[var(--brand-primary)]" />
                <div>
                  <div className="font-medium text-[var(--foreground)]">Private by default</div>
                  <div>Your API key is exchanged through the server auth flow and stored in secure cookies.</div>
                </div>
              </div>
              <div className="brand-soft flex items-start gap-3 p-4">
                <KeyRound className="mt-0.5 h-5 w-5 text-[var(--brand-warm)]" />
                <div>
                  <div className="font-medium text-[var(--foreground)]">Fast operator login</div>
                  <div>Paste a live workspace key and jump straight into the observer dashboard.</div>
                </div>
              </div>
            </div>
          </section>

          <section className="bg-[color-mix(in_srgb,var(--surface-strong)_82%,transparent)] p-8 md:p-10">
            <div className="brand-kicker mb-3">Secure Workspace Access</div>
            <h2 className="brand-title text-2xl font-semibold text-[var(--foreground)]">Sign in with your workspace API key</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">Use an <code className="rounded-md bg-[var(--brand-primary-faint)] px-1.5 py-0.5 text-[var(--brand-primary-strong)]">rk_live_…</code> key to establish your observer session.</p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-5">
              <div>
                <label htmlFor="apiKey" className="mb-2 block text-sm font-medium text-[var(--text-secondary)]">
                  API key
                </label>
                <input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-4 py-3 text-sm text-[var(--foreground)] placeholder:text-[var(--text-faint)] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
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
          </section>
        </div>
      </div>
    </div>
  );
}
