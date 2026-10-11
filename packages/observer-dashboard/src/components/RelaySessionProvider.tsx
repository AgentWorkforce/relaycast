'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RelayProvider } from '@relaycast/react';
import { login } from '../lib/auth';
import { resetActivityIfWorkspaceChanged } from '../lib/activity-store';
import {
  classifyConnectObserverStatus,
  connectObserverIdentity,
  connectObserverRetryDelay,
  connectObserverUrlWithoutCapability,
  parseRetryAfterMs,
  shouldInitializeConnectObserver,
} from '../lib/connect-observer';
import { ConnectObserverTemporaryState } from './ConnectObserverTemporaryState';

interface Session {
  apiKey: string;
  agentToken: string;
  wsToken: string | null;
  baseUrl: string;
}

export function RelaySessionProvider({
  children,
  mode = 'workspace',
}: {
  children: React.ReactNode;
  mode?: 'workspace' | 'connect';
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [accessFailure, setAccessFailure] = useState<'expired' | 'unavailable' | null>(null);
  // A Connect open that failed for a temporary reason (rate limit, outage,
  // network): retried in this tab with bounded backoff, never shown as revoked.
  const [temporaryFailure, setTemporaryFailure] = useState<{ retrying: boolean } | null>(null);
  const retryNow = useRef<() => void>(() => undefined);
  // Not cleared by the effect's cleanup: stripping the capability re-runs the
  // effect for the same identity, which must not cancel a pending retry.
  const retryTimer = useRef<number | undefined>(undefined);
  // An open that fails after unmount must not schedule a retry: it would later
  // re-send the captured capability and could overwrite a newer session's cookies.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(retryTimer.current);
    };
  }, []);
  const requestSeq = useRef(0);
  const connectIdentity = useRef<string | null>(null);
  const previousMode = useRef<'workspace' | 'connect' | null>(null);

  useEffect(() => {
    const observerIdParam = searchParams.get('observer_id');
    const fragmentKey = mode === 'connect' ? new URLSearchParams(window.location.hash.slice(1)).get('key') : null;
    const keyParam = searchParams.get('key') ?? fragmentKey;
    const expiresAt = searchParams.get('expires_at');
    const priorMode = previousMode.current;
    previousMode.current = mode;
    if (
      mode === 'connect'
      && !shouldInitializeConnectObserver(priorMode, connectIdentity.current, observerIdParam, expiresAt, keyParam)
    ) {
      return;
    }
    if (mode === 'connect') {
      connectIdentity.current = connectObserverIdentity(observerIdParam, expiresAt);
    }
    const seq = ++requestSeq.current;
    if (mode === 'connect' && keyParam) {
      // Capture the capability above, then remove it before any asynchronous
      // validation so success, rejection, expiry, and network failure all
      // leave a non-replayable address-bar entry.
      window.history.replaceState({}, '', connectObserverUrlWithoutCapability(window.location.href));
    }
    // An identity change is an authorization boundary. Unmount the room view
    // immediately so its message cache cannot survive into another session.
    setChecking(true);
    setSession(null);
    setAccessFailure(null);
    setTemporaryFailure(null);

    // The capability lives only in this closure once stripped from the URL, so
    // retries re-run the login here instead of asking for a reload.
    window.clearTimeout(retryTimer.current);
    let attempt = 0;
    const failTemporarily = (retryAfterMs?: number | null) => {
      if (seq !== requestSeq.current || !mounted.current) return;
      const delay = connectObserverRetryDelay(attempt, retryAfterMs);
      attempt += 1;
      setTemporaryFailure({ retrying: delay !== null });
      if (delay !== null) {
        retryTimer.current = window.setTimeout(() => {
          if (mounted.current) void initSession();
        }, delay);
      }
    };
    retryNow.current = () => {
      window.clearTimeout(retryTimer.current);
      attempt = 0;
      setTemporaryFailure(null);
      setChecking(true);
      void initSession();
    };

    async function initSession() {
      try {
        if (
          mode === 'connect' &&
          expiresAt &&
          Number.isFinite(Date.parse(expiresAt)) &&
          Date.parse(expiresAt) <= Date.now()
        ) {
          setAccessFailure('expired');
          return;
        }
        if (
          mode === 'connect' &&
          (!observerIdParam ||
            !/^ot_(?!live_)[A-Za-z0-9_-]+$/.test(observerIdParam) ||
            (keyParam !== null && !keyParam.startsWith('ot_live_')))
        ) {
          setAccessFailure('unavailable');
          return;
        }
        if (keyParam?.startsWith('rk_live_') || keyParam?.startsWith('ot_live_')) {
          const result = await login(
            keyParam,
            mode === 'connect' ? { connectObserverId: observerIdParam! } : undefined,
          );
          if (seq !== requestSeq.current) return;
          if (!result.ok) {
            if (mode === 'connect') {
              if (result.failure === 'temporary') failTemporarily(result.retryAfterMs);
              else setAccessFailure('unavailable');
              return;
            }
            router.replace('/login');
            return;
          }
        }

        const res = await fetch('/observer/api/auth/session');
        if (seq !== requestSeq.current) return;

        if (!res.ok) {
          if (mode === 'connect') {
            if (classifyConnectObserverStatus(res.status) === 'temporary') failTemporarily(parseRetryAfterMs(res.headers.get('retry-after')));
            else setAccessFailure('unavailable');
            return;
          }
          router.replace('/login');
          return;
        }

        const data = await res.json();
        if (seq !== requestSeq.current) return;

        if (
          data?.authenticated &&
          (mode !== 'connect' || (data.apiKey?.startsWith('ot_live_') && data.connectObserverId === observerIdParam))
        ) {
          // Drop another workspace's cached activity before this dashboard
          // mounts, so switching keys never hydrates stale cross-workspace events.
          resetActivityIfWorkspaceChanged(data.apiKey);
          setTemporaryFailure(null);
          setSession({
            apiKey: data.apiKey,
            agentToken: data.agentToken,
            // Never fall back to the REST/admin credential for the socket; a
            // missing stream token means the realtime stream stays offline.
            wsToken: data.wsToken ?? null,
            baseUrl: data.baseUrl,
          });
          if (keyParam && mode !== 'connect') router.replace('/');
        } else {
          if (mode === 'connect') {
            setAccessFailure('unavailable');
            return;
          }
          router.replace('/login');
        }
      } catch {
        if (seq !== requestSeq.current) return;
        if (mode === 'connect') {
          failTemporarily();
          return;
        }
        router.replace('/login');
      } finally {
        if (seq !== requestSeq.current) return;
        setChecking(false);
      }
    }

    initSession();
  }, [mode, router, searchParams]);

  if (accessFailure) {
    return <ConnectObserverAccessState state={accessFailure} />;
  }

  if (temporaryFailure) {
    return <ConnectObserverTemporaryState retrying={temporaryFailure.retrying} onRetry={() => retryNow.current()} />;
  }

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

function ConnectObserverAccessState({ state }: { state: 'expired' | 'unavailable' }) {
  const expired = state === 'expired';
  return (
    <main className="brand-grid flex min-h-screen items-center justify-center px-4">
      <section className="brand-glass w-full max-w-xl rounded-[2rem] p-8 text-center sm:p-10">
        <img src="/observer/brand/agent-relay-mark.svg" alt="Agent Relay" className="mx-auto h-10 w-auto" />
        <h1 className="brand-title mt-6 text-2xl font-semibold text-[var(--foreground)]">
          {expired ? 'This Relay Connect has expired' : 'Observer link unavailable'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          {expired
            ? 'The room and its read-only observer capability are no longer active.'
            : 'This link is invalid, revoked, or no longer has access to the Relay Connect room.'}
        </p>
      </section>
    </main>
  );
}
