'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RelayProvider } from '@relaycast/react';
import { setAuth } from '../lib/auth';
import { resetActivityIfWorkspaceChanged } from '../lib/activity-store';

interface Session {
  apiKey: string;
  agentToken: string;
  wsToken: string | null;
  baseUrl: string;
}

export function RelaySessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    const keyParam = searchParams.get('key');

    async function initSession() {
      try {
        if (keyParam?.startsWith('rk_live_') || keyParam?.startsWith('ot_live_')) {
          const success = await setAuth(keyParam);
          if (seq !== requestSeq.current) return;
          if (!success) {
            router.replace('/login');
            return;
          }
        }

        const res = await fetch('/observer/api/auth/session');
        if (seq !== requestSeq.current) return;

        if (!res.ok) {
          router.replace('/login');
          return;
        }

        const data = await res.json();
        if (seq !== requestSeq.current) return;

        if (data?.authenticated) {
          // Drop another workspace's cached activity before this dashboard
          // mounts, so switching keys never hydrates stale cross-workspace events.
          resetActivityIfWorkspaceChanged(data.apiKey);
          setSession({
            apiKey: data.apiKey,
            agentToken: data.agentToken,
            // Never fall back to the REST/admin credential for the socket; a
            // missing stream token means the realtime stream stays offline.
            wsToken: data.wsToken ?? null,
            baseUrl: data.baseUrl,
          });
          if (keyParam) router.replace('/');
        } else {
          router.replace('/login');
        }
      } catch {
        if (seq !== requestSeq.current) return;
        router.replace('/login');
      } finally {
        if (seq !== requestSeq.current) return;
        setChecking(false);
      }
    }

    initSession();
  }, [router, searchParams]);

  if (checking || !session) {
    return (
      <div className="brand-grid min-h-screen flex items-center justify-center px-4">
        <div className="brand-glass flex items-center gap-3 px-5 py-4 text-sm text-[var(--text-secondary)]">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent" />
          Syncing your workspace session…
        </div>
      </div>
    );
  }

  return (
    <RelayProvider
      apiKey={session.apiKey}
      // The socket credential is resolved as `wsToken ?? agentToken`, so keep
      // the admin key out of both: the realtime socket must only ever use the
      // observer stream token (empty when there is none, so it never falls back
      // to the REST/admin key). REST reads still use `apiKey`. The dashboard is
      // observer-only and never uses the agent (REST-as-agent) client.
      agentToken={session.wsToken ?? ''}
      wsToken={session.wsToken ?? undefined}
      baseUrl={session.baseUrl}
      debug
    >
      {children}
    </RelayProvider>
  );
}
