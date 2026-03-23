'use client';

import { useRouter } from 'next/navigation';
import { setAuth } from '../../lib/auth';
import { useState } from 'react';

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
    <main className="relative min-h-screen overflow-hidden bg-[#f6efe2] text-[#22314a]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(48rem_24rem_at_0%_0%,rgba(182,215,255,0.65),transparent_62%),radial-gradient(38rem_22rem_at_100%_100%,rgba(255,163,71,0.18),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(150,201,255,0.16),transparent)]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-4 py-8 sm:px-6">
        <section className="w-full rounded-[28px] border border-[#d5e4f5] bg-[rgba(255,252,246,0.92)] p-6 shadow-[0_24px_80px_rgba(103,137,179,0.16)] backdrop-blur sm:p-7">
          <div className="mb-6 flex items-center justify-between gap-4">
            <img
              src="/observer/brand/agent-relay-logo-black.svg"
              alt="Agent Relay"
              className="h-8 w-auto sm:h-9"
            />
            <div className="h-2.5 w-2.5 rounded-full bg-[#f28c28]" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="apiKey" className="block text-sm font-medium text-[#324866]">
                API key
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full rounded-2xl border border-[#cfe0f2] bg-[#fffdfa] px-4 py-3.5 text-sm text-[#22314a] shadow-[inset_0_0_0_1px_rgba(207,224,242,0.45)] transition focus:border-[#8bbef0] focus:outline-none focus:ring-2 focus:ring-[#8bbef0]/45 placeholder:text-[#8a97a8] [font-family:'IBM_Plex_Mono',monospace]"
                placeholder="rk_live_..."
                autoComplete="current-password"
                autoFocus
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>

            {error && (
              <p className="rounded-2xl border border-[#f4c7c7] bg-[#fff1f1] px-3.5 py-3 text-sm text-[#9f2f2f]">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !apiKey}
              className="w-full cursor-pointer rounded-2xl bg-[#6aa9e9] px-4 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-[#5a9bde] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Validating...' : 'Open observer'}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
