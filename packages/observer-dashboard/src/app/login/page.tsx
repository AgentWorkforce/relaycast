'use client';

import { Shield, Sparkles, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { setAuth } from '../../lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [logoSrc, setLogoSrc] = useState('/observer/brand/agent-relay-logo-white.svg');

  useEffect(() => {
    const root = document.documentElement;
    const updateLogo = () => {
      setLogoSrc(
        root.classList.contains('theme-light')
          ? '/observer/brand/agent-relay-logo-black.svg'
          : '/observer/brand/agent-relay-logo-white.svg',
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
    <main className="relative min-h-screen overflow-y-auto bg-[var(--color-bg-deep)] text-[var(--color-text-primary)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(58rem_28rem_at_8%_-5%,var(--color-success-light),transparent_62%),radial-gradient(52rem_30rem_at_100%_100%,var(--color-accent-light),transparent_58%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,var(--color-bg-hover),transparent_18%,transparent_82%,var(--color-bg-hover))]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent-cyan)]/50 to-transparent" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl items-center px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-12">
        <div className="grid w-full items-center gap-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(24rem,0.92fr)] lg:gap-10">
          <section className="order-2 flex flex-col gap-5 lg:order-1 lg:gap-7">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-hover)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-secondary)] backdrop-blur-sm">
              <Sparkles className="h-3.5 w-3.5 text-[var(--color-success)]" />
              Observer dashboard
            </div>

            <div className="space-y-4">
              <img
                src={logoSrc}
                alt="Agent Relay"
                className="h-8 w-auto sm:h-10"
              />

              <div className="max-w-2xl space-y-3">
                <h1 className="max-w-[14ch] text-4xl font-semibold leading-[0.95] tracking-[-0.04em] text-[var(--color-text-primary)] sm:text-5xl lg:text-6xl">
                  Mobile-friendly access to your relay workspace.
                </h1>
                <p className="max-w-xl text-sm leading-6 text-[var(--color-text-secondary)] sm:text-base sm:leading-7">
                  Monitor channels, inspect agent activity, and keep an eye on live coordination from a cleaner observer experience that matches the Agent Relay brand.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <FeatureCard
                icon={<Shield className="h-4 w-4" />}
                title="Secure sign-in"
                body="Use your workspace relay key. Credentials stay scoped to the observer session."
              />
              <FeatureCard
                icon={<Wifi className="h-4 w-4" />}
                title="Live visibility"
                body="Jump straight into channels, DMs, and agent state once the session validates."
              />
              <FeatureCard
                icon={<Sparkles className="h-4 w-4" />}
                title="Built for phones"
                body="Comfortable spacing, readable type, and a layout that doesn’t collapse on smaller screens."
              />
            </div>
          </section>

          <section className="order-1 lg:order-2">
            <div className="w-full rounded-[28px] border border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_84%,transparent)] shadow-[0_28px_80px_rgba(0,0,0,0.3)] backdrop-blur-xl">
              <div className="h-px w-full bg-gradient-to-r from-transparent via-[var(--color-success)] to-transparent opacity-80" />
              <div className="p-5 sm:p-7 lg:p-8">
                <div className="mb-6 flex items-start justify-between gap-4 sm:mb-8">
                  <div className="space-y-3">
                    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-hover)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-secondary)]">
                      <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" />
                      Agent Relay Observer
                    </div>
                    <div className="space-y-2">
                      <h2 className="text-2xl font-semibold tracking-[-0.03em] text-[var(--color-text-primary)] sm:text-[2rem]">
                        Sign in to continue
                      </h2>
                      <p className="max-w-md text-sm leading-6 text-[var(--color-text-secondary)]">
                        Enter the workspace API key for the relay you want to observe. Once verified, you’ll be dropped straight into the dashboard.
                      </p>
                    </div>
                  </div>

                  <div className="hidden rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-hover)] px-3 py-2 text-right sm:block">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                      Access
                    </div>
                    <div className="mt-1 text-sm font-medium text-[var(--color-text-primary)]">
                      Workspace key
                    </div>
                  </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  <div className="space-y-2.5">
                    <label htmlFor="apiKey" className="block text-sm font-medium text-[var(--color-text-primary)]">
                      API key
                    </label>
                    <input
                      id="apiKey"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="w-full rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-4 py-3.5 text-sm text-[var(--color-text-primary)] shadow-[inset_0_0_0_1px_var(--color-border-subtle)] transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--focus-color)] placeholder:text-[var(--color-text-muted)] [font-family:'IBM_Plex_Mono',monospace]"
                      placeholder="rk_live_..."
                      autoComplete="current-password"
                      autoFocus
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                    />
                    <p className="text-xs leading-5 text-[var(--color-text-muted)]">
                      Starts with <span className="font-semibold text-[var(--color-text-secondary)]">rk_live_</span> and grants observer access for this workspace.
                    </p>
                  </div>

                  {error && (
                    <p className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-3.5 py-3 text-sm text-rose-200">
                      {error}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={loading || !apiKey}
                    className="w-full cursor-pointer rounded-2xl bg-[var(--focus-color)] px-4 py-3.5 text-sm font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loading ? 'Validating...' : 'Open observer'}
                  </button>
                </form>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--color-border-default)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_68%,transparent)] p-4 backdrop-blur-sm">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-bg-hover)] text-[var(--color-accent-cyan)]">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">{body}</p>
    </div>
  );
}
