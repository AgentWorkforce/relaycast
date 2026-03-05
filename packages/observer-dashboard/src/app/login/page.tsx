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
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-8">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-3">
              <img
                src="/brand/agent-relay-logo-white.svg"
                alt="Agent Relay"
                className="h-9 w-auto dark:block hidden"
              />
              <img
                src="/brand/agent-relay-logo-black.svg"
                alt="Agent Relay"
                className="h-9 w-auto dark:hidden block"
              />
            </div>
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-1">Agent Relay Observer</h1>
            <p className="text-sm text-[var(--color-text-muted)]">Enter your workspace API key to continue</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="apiKey" className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
                API Key
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] placeholder-[var(--color-text-dim)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-cyan)] focus:border-transparent"
                placeholder="rk_live_..."
                autoFocus
              />
            </div>

            {error && (
              <p className="text-sm text-[var(--color-error)]">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !apiKey}
              className="w-full py-2.5 px-4 rounded-lg font-medium text-sm cursor-pointer transition-colors bg-[var(--color-accent-cyan)] text-[var(--color-text-inverse)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Validating...' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
