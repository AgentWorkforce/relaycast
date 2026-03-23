'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AgentRelayMark, AgentRelayWordmark } from '../../components/Brand';
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
    <main className="relative min-h-screen overflow-hidden bg-[#F9FAFB] text-[#111827]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,#F9FAFB_0%,#E6F0F8_100%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(38rem_20rem_at_14%_18%,rgba(74,144,194,0.16),transparent_62%),radial-gradient(32rem_18rem_at_86%_80%,rgba(74,144,194,0.12),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(255,255,255,0.7),transparent)]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-4 py-8 sm:px-6">
        <section className="w-full rounded-[28px] border border-[rgba(74,144,194,0.16)] bg-[rgba(255,255,255,0.9)] p-6 shadow-[0_24px_80px_rgba(31,78,115,0.16)] backdrop-blur-xl sm:p-7">
          <div className="mb-6 space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full bg-[#4A90C2] px-3 py-2 text-white shadow-[0_12px_28px_rgba(74,144,194,0.28)]">
              <AgentRelayMark className="h-7 text-white" />
              <AgentRelayWordmark className="h-[18px] text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-[-0.03em] text-[#111827]">Observer</h1>
              <p className="mt-1 text-sm leading-6 text-[#4B5563]">
                Connect your workspace with a live API key to monitor channels, DMs, agents, and threads.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="apiKey" className="block text-sm font-medium text-[#1F2937]">
                API key
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full rounded-2xl border border-[rgba(74,144,194,0.14)] bg-white px-4 py-3.5 text-sm text-[#111827] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] transition placeholder:text-[#9CA3AF] focus:border-[#4A90C2] focus:outline-none focus:ring-4 focus:ring-[rgba(74,144,194,0.14)] [font-family:'IBM_Plex_Mono',monospace]"
                placeholder="rk_live_..."
                autoComplete="current-password"
                autoFocus
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>

            {error && (
              <p className="rounded-2xl border border-[#DC2626]/20 bg-[#DC2626]/8 px-3.5 py-3 text-sm text-[#B91C1C]">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !apiKey}
              className="w-full cursor-pointer rounded-2xl bg-[#4A90C2] px-4 py-3.5 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(74,144,194,0.22)] transition-colors hover:bg-[#2F6FA3] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Validating...' : 'Open observer'}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
