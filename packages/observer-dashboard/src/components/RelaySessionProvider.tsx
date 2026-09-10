'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RelayProvider } from '@relaycast/react';
import { resetActivityIfWorkspaceChanged } from '../lib/activity-store';
import {
  resolveObserverSession,
  type ObserverSessionData,
} from '../lib/observer-auto-login';

export function RelaySessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [session, setSession] = useState<ObserverSessionData | null>(null);
  const [checking, setChecking] = useState(true);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    // Read the `?key=` param synchronously so a query-string arrival (the
    // "Join as observer" link shape used by Pear and the site) triggers
    // auto-login before we probe the existing cookie session. This is the
    // regression-prone path — keep the read explicit and covered by
    // observer-auto-login.test.ts.
    const keyParam = searchParams.get('key');

    async function initSession() {
      const outcome = await resolveObserverSession({ keyParam });
      if (seq !== requestSeq.current) return;

      if (outcome.kind === 'unauthenticated') {
        router.replace('/login');
        setChecking(false);
        return;
      }

      // Drop another workspace's cached activity before this dashboard mounts,
      // so switching keys never hydrates stale cross-workspace events.
      resetActivityIfWorkspaceChanged(outcome.session.apiKey);
      setSession(outcome.session);
      // Strip the key from the URL only after the session is established, so
      // the URL change doesn't race with the session fetch.
      if (outcome.consumedKeyParam) {
        router.replace('/');
      }
      setChecking(false);
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
