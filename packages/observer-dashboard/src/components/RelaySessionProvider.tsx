'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RelayProvider } from '@relaycast/react';

interface Session {
  apiKey: string;
  agentToken: string;
  wsToken: string;
  baseUrl: string;
}

export function RelaySessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;

    fetch('/api/auth/session')
      .then((res) => {
        if (seq !== requestSeq.current) return null;
        if (!res.ok) {
          router.replace('/login');
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (seq !== requestSeq.current) return;
        if (data?.authenticated) {
          setSession({
            apiKey: data.apiKey,
            agentToken: data.agentToken,
            wsToken: data.wsToken ?? data.apiKey,
            baseUrl: data.baseUrl,
          });
        } else {
          router.replace('/login');
        }
      })
      .catch(() => {
        if (seq !== requestSeq.current) return;
        router.replace('/login');
      })
      .finally(() => {
        if (seq !== requestSeq.current) return;
        setChecking(false);
      });
  }, [router]);

  if (checking || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
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
