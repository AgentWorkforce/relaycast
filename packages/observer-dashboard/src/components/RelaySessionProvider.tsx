'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RelayProvider } from '@relaycast/react';
import { setAuth } from '../lib/auth';

interface Session {
  apiKey: string;
  agentToken: string;
  wsToken: string;
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
        // If a key is in the URL, authenticate with it before checking the session.
        if (keyParam?.startsWith('rk_live_')) {
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
          setSession({
            apiKey: data.apiKey,
            agentToken: data.agentToken,
            wsToken: data.wsToken ?? data.apiKey,
            baseUrl: data.baseUrl,
          });
          // Strip the key from the URL only after the session is established,
          // so the URL change doesn't race with the session fetch.
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
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-[var(--color-success)] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <RelayProvider
      apiKey={session.apiKey}
      agentToken={session.agentToken}
      wsToken={session.wsToken}
      baseUrl={session.baseUrl}
      debug
    >
      {children}
    </RelayProvider>
  );
}
