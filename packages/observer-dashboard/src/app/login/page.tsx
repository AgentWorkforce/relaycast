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
    <main className="relative min-h-screen overflow-hidden bg-[#050816] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(42rem_22rem_at_15%_18%,rgba(0,217,255,0.14),transparent_62%),radial-gradient(34rem_20rem_at_85%_82%,rgba(99,102,241,0.16),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),transparent)]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-4 py-8 sm:px-6">
        <section className="w-full rounded-[28px] border border-white/10 bg-[rgba(10,14,30,0.86)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur sm:p-7">
          <div className="mb-6 flex items-center gap-3">
            <img src="/observer/favicon.svg" alt="" aria-hidden="true" className="h-10 w-10" />
            <img
              src="/observer/agent-relay-logo-white.svg"
              alt="Agent Relay"
              className="h-6 w-auto sm:h-7"
            />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="apiKey" className="block text-sm font-medium text-[#c7d0ff]">
                API key
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full rounded-2xl border border-white/12 bg-white/5 px-4 py-3.5 text-sm text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)] transition focus:border-[#00d9ff]/60 focus:outline-none focus:ring-2 focus:ring-[#00d9ff]/25 placeholder:text-[#7d86b4] [font-family:'IBM_Plex_Mono',monospace]"
                placeholder="rk_live_..."
                autoComplete="current-password"
                autoFocus
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>

            {error && (
              <p className="rounded-2xl border border-[#fb7185]/35 bg-[#fb7185]/10 px-3.5 py-3 text-sm text-[#ffd5dd]">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !apiKey}
              className="w-full cursor-pointer rounded-2xl bg-[#00d9ff] px-4 py-3.5 text-sm font-semibold text-[#04111f] transition-colors hover:bg-[#33e2ff] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Validating...' : 'Open observer'}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
