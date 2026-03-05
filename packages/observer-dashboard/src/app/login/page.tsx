'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { setAuth } from '../../lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [logoSrc, setLogoSrc] = useState('/brand/agent-relay-logo-white.svg');

  useEffect(() => {
    const root = document.documentElement;
    const updateLogo = () => {
      setLogoSrc(
        root.classList.contains('theme-light')
          ? '/brand/agent-relay-logo-black.svg'
          : '/brand/agent-relay-logo-white.svg',
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
    <div className="relative min-h-screen overflow-hidden bg-[#09090b]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(65rem_32rem_at_15%_-5%,rgba(5,150,97,0.2),transparent_60%),radial-gradient(48rem_28rem_at_100%_100%,rgba(4,209,246,0.15),transparent_62%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.04),transparent_28%)]" />
      <div className="relative min-h-screen flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-lg rounded-2xl border border-zinc-700/60 bg-zinc-900/60 shadow-[0_24px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl">
          <div className="h-px w-full bg-gradient-to-r from-transparent via-[#059661] to-transparent" />
          <div className="p-8 md:p-10">
            <div className="mb-8">
              <div className="flex items-end gap-3">
                <img
                  src={logoSrc}
                  alt="Agent Relay"
                  className="h-9 w-auto shrink-0"
                />
                <h1 className="text-4xl font-black uppercase leading-none tracking-[0.06em] [font-family:Outfit,sans-serif]">
                  <span className="bg-gradient-to-r from-[#5BBAA7] to-[#04D1F6] bg-clip-text text-transparent">
                    Observer
                  </span>
                </h1>
              </div>
              <div className="mt-4 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                  Secure Workspace Access
                </p>
                <p className="text-sm text-zinc-400">Enter your workspace API key to continue</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="apiKey" className="mb-2 block text-sm font-medium text-zinc-300">
                  API Key
                </label>
                <input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full rounded-xl border border-zinc-700 bg-[#0b0f15] px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#5BBAA7]"
                  placeholder="rk_live_..."
                  autoFocus
                />
              </div>

              {error && (
                <p className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || !apiKey}
                className="w-full cursor-pointer rounded-xl bg-[#059661] px-4 py-3 text-sm font-semibold text-emerald-50 transition-colors hover:bg-[#04784e] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Validating...' : 'Sign in'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
