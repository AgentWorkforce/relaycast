'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RelayProvider } from '@relaycast/react';

interface Session {
  apiKey: string;
  agentToken: string;
  baseUrl: string;
}

export function RelaySessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((res) => {
        if (!res.ok) {
          router.replace('/login');
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (data?.authenticated) {
          setSession({
            apiKey: data.apiKey,
            agentToken: data.agentToken,
            baseUrl: data.baseUrl,
          });
        }
      })
      .catch(() => {
        router.replace('/login');
      })
      .finally(() => setChecking(false));
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
      baseUrl={session.baseUrl}
      debug
    >
      {children}
    </RelayProvider>
  );
}
