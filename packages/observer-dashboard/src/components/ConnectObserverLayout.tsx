'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useEvent, useRelay } from '@relaycast/react';
import type { WorkspaceDmConversation, WsClientEvent } from '@relaycast/sdk';
import { MessageSquareText, ShieldCheck } from 'lucide-react';
import {
  classifyConnectObserverError,
  connectObserverExpiryDelay,
  connectObserverRetryDelay,
  formatUtcTimestamp,
  isConnectConversationGone,
  loadConnectConversationMessages,
  sanitizeConnectObserverText,
  type ConnectObservedMessage,
} from '../lib/connect-observer';
import { ConnectObserverTemporaryState } from './ConnectObserverTemporaryState';

// Realtime events are the primary update path. This slower reconciliation
// catches missed events without reloading the conversation list every 15s.
const RECONCILIATION_INTERVAL_MS = 5 * 60_000;

type ObserverRead = () => Promise<void>;

export function ConnectObserverLayout() {
  const relay = useRelay();
  const searchParams = useSearchParams();
  const expiresAt = searchParams.get('expires_at');
  const [messages, setMessages] = useState<ConnectObservedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [expired, setExpired] = useState(Boolean(expiresAt && Date.parse(expiresAt) <= Date.now()));
  const messageCache = useRef(new Map<string, ConnectObservedMessage>());
  const newestByConversation = useRef(new Map<string, string>());
  const conversationCache = useRef(new Map<string, WorkspaceDmConversation>());
  const pendingConversationIds = useRef(new Set<string>());
  const reconciliationPending = useRef(false);
  const readInFlight = useRef(false);
  // Temporary failures (rate limit, outage, network) retry with bounded
  // backoff; once spent, polling pauses until the viewer asks again.
  const [temporary, setTemporary] = useState<{ retrying: boolean } | null>(null);
  const hasLoadedHistory = useRef(false);
  const retryAttempt = useRef(0);
  const retryTimer = useRef<number | undefined>(undefined);
  const retryRead = useRef<ObserverRead | null>(null);
  const pausedAfterFailures = useRef(false);
  // A rejected capability stays rejected: stop polling instead of re-sending it.
  const revoked = useRef(false);
  // While a backoff retry is scheduled, the live poll and realtime events wait
  // for it, so a longer Retry-After is honoured and the budget is not spent early.
  const retryPending = useRef(false);
  const runReadRef = useRef<(read: ObserverRead) => void>(() => undefined);
  const scheduleReconciliationRef = useRef<() => void>(() => undefined);
  const flushPendingRef = useRef<() => void>(() => undefined);

  // A read that fails after unmount must not schedule a retry.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(retryTimer.current);
    };
  }, []);

  const publishMessages = useCallback(() => {
    if (!mounted.current) return;
    setMessages(
      [...messageCache.current.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)),
    );
  }, []);

  const dropConversation = useCallback((conversationId: string) => {
    conversationCache.current.delete(conversationId);
    newestByConversation.current.delete(conversationId);
    for (const [id, message] of messageCache.current) {
      if (message.conversationId === conversationId) messageCache.current.delete(id);
    }
  }, []);

  const loadConversation = useCallback(
    async (conversation: WorkspaceDmConversation): Promise<boolean> => {
      const previousNewest = newestByConversation.current.get(conversation.id);
      let page: ConnectObservedMessage[];
      try {
        page = await loadConnectConversationMessages(relay, conversation, previousNewest);
      } catch (error) {
        if (!isConnectConversationGone(error)) throw error;
        // Access to this one conversation was narrowed: drop what it showed and
        // keep observing the rest of the cached scope.
        dropConversation(conversation.id);
        return false;
      }
      conversationCache.current.set(conversation.id, conversation);
      for (const message of page) messageCache.current.set(message.id, message);
      const newest = page.reduce<string | undefined>(
        (candidate, message) => (candidate === undefined || message.id > candidate ? message.id : candidate),
        previousNewest,
      );
      if (newest) newestByConversation.current.set(conversation.id, newest);
      return true;
    },
    [dropConversation, relay],
  );

  const reconcile = useCallback(async () => {
    const conversations = await relay.allDmConversations();
    const visibleConversationIds = new Set<string>();
    // Read conversations sequentially so a large room does not burst through
    // the workspace request budget. After the initial history walk, only
    // messages newer than the remembered snowflake are requested.
    for (const conversation of conversations) {
      if (await loadConversation(conversation)) visibleConversationIds.add(conversation.id);
    }
    for (const conversationId of [...conversationCache.current.keys()]) {
      if (!visibleConversationIds.has(conversationId)) dropConversation(conversationId);
    }
    publishMessages();
    hasLoadedHistory.current = true;
  }, [dropConversation, loadConversation, publishMessages, relay]);

  const runRead = useCallback(
    (read: ObserverRead) => {
      if (!mounted.current || expired || readInFlight.current || pausedAfterFailures.current || revoked.current || retryPending.current)
        return;
      if (read === reconcile) reconciliationPending.current = false;
      readInFlight.current = true;
      void (async () => {
        try {
          await read();
          if (!mounted.current) return;
          retryRead.current = null;
          retryAttempt.current = 0;
          setTemporary(null);
          setUnavailable(false);
        } catch (error) {
          if (!mounted.current) return;
          if (classifyConnectObserverError(error) === 'revoked') {
            revoked.current = true;
            retryPending.current = false;
            retryRead.current = null;
            window.clearTimeout(retryTimer.current);
            setUnavailable(true);
          } else {
            const retryAfterMs = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
            const delay = connectObserverRetryDelay(retryAttempt.current, typeof retryAfterMs === 'number' ? retryAfterMs : null);
            retryAttempt.current += 1;
            pausedAfterFailures.current = delay === null;
            retryRead.current = read;
            setTemporary({ retrying: delay !== null });
            window.clearTimeout(retryTimer.current);
            retryPending.current = delay !== null;
            if (delay !== null) {
              retryTimer.current = window.setTimeout(() => {
                retryPending.current = false;
                if (mounted.current) runReadRef.current(read);
              }, delay);
            }
          }
        } finally {
          if (mounted.current) setLoading(false);
          readInFlight.current = false;
          if (reconciliationPending.current && !retryPending.current && !pausedAfterFailures.current && !revoked.current) {
            void Promise.resolve().then(() => scheduleReconciliationRef.current());
          } else if (pendingConversationIds.current.size > 0 && !retryPending.current && !pausedAfterFailures.current && !revoked.current) {
            void Promise.resolve().then(() => flushPendingRef.current());
          }
        }
      })();
    },
    [expired, reconcile],
  );
  runReadRef.current = runRead;

  const scheduleReconciliation = useCallback(() => {
    reconciliationPending.current = true;
    if (!mounted.current || expired || readInFlight.current || retryPending.current || pausedAfterFailures.current || revoked.current)
      return;
    runRead(reconcile);
  }, [expired, reconcile, runRead]);
  scheduleReconciliationRef.current = scheduleReconciliation;

  const flushPending = useCallback(() => {
    if (
      pendingConversationIds.current.size === 0 ||
      reconciliationPending.current ||
      !mounted.current ||
      readInFlight.current ||
      retryPending.current ||
      pausedAfterFailures.current ||
      revoked.current
    )
      return;
    const conversationIds = [...pendingConversationIds.current];
    pendingConversationIds.current.clear();
    runRead(async () => {
      let attempted = false;
      for (const conversationId of conversationIds) {
        const conversation = conversationCache.current.get(conversationId);
        // Unknown conversations are discovered by bounded reconciliation. A
        // realtime event does not contain the participant summary needed to
        // render its messages safely.
        if (!conversation) continue;
        attempted = true;
        await loadConversation(conversation);
      }
      if (attempted) publishMessages();
    });
  }, [loadConversation, publishMessages, runRead]);
  flushPendingRef.current = flushPending;

  const refreshConversation = useCallback(
    (event: WsClientEvent) => {
      if (!('conversationId' in event) || typeof event.conversationId !== 'string') return;
      pendingConversationIds.current.add(event.conversationId);
      flushPending();
    },
    [flushPending],
  );

  const retryNow = useCallback(() => {
    const read = retryRead.current ?? reconcile;
    window.clearTimeout(retryTimer.current);
    retryPending.current = false;
    retryAttempt.current = 0;
    pausedAfterFailures.current = false;
    setTemporary({ retrying: true });
    runRead(read);
  }, [reconcile, runRead]);

  useEffect(() => {
    scheduleReconciliation();
    const interval = window.setInterval(scheduleReconciliation, RECONCILIATION_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [scheduleReconciliation]);
  useEvent('dm.received', refreshConversation);
  useEvent('group_dm.received', refreshConversation);

  useEffect(() => {
    if (!expiresAt) return;
    let timer: number | undefined;
    const checkExpiry = () => {
      const delay = connectObserverExpiryDelay(expiresAt);
      if (delay === null) return;
      if (delay <= 0) {
        setExpired(true);
        return;
      }
      // Browser timers use a signed 32-bit delay. Long-lived rooms therefore
      // wake at safe checkpoints until the real deadline is reached.
      timer = window.setTimeout(checkExpiry, delay);
    };
    checkExpiry();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [expiresAt]);

  const expiryLabel = useMemo(() => (expiresAt ? formatUtcTimestamp(expiresAt) : null), [expiresAt]);

  if (expired) return <TerminalState expired />;
  if (unavailable) return <TerminalState expired={false} />;
  // Before any history loaded, a temporary failure must not look like an empty room.
  if (temporary && !hasLoadedHistory.current) {
    return <ConnectObserverTemporaryState retrying={temporary.retrying} onRetry={retryNow} />;
  }

  return (
    <main className="brand-grid min-h-screen p-3 sm:p-6">
      <div className="mx-auto flex min-h-[calc(100vh-1.5rem)] w-full max-w-5xl flex-col gap-3 sm:min-h-[calc(100vh-3rem)]">
        <header className="brand-glass rounded-[1.5rem] px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <img src="/observer/brand/agent-relay-mark.svg" alt="Agent Relay" className="h-9 w-auto" />
              <div>
                <h1 className="brand-title text-lg font-semibold text-[var(--foreground)]">Relay Connect observer</h1>
                <p className="text-xs text-[var(--text-muted)]">Read-only room direct messages</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <ShieldCheck className="h-4 w-4 text-[var(--brand-primary)]" />
              {expiryLabel ? `Expires ${expiryLabel}` : 'Room-scoped access'}
            </div>
          </div>
        </header>

        <section className="brand-card flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-[var(--border-default)] px-5 py-4">
            <MessageSquareText className="h-4 w-4 text-[var(--brand-primary)]" />
            <h2 className="brand-title text-base font-semibold text-[var(--foreground)]">Room messages</h2>
            <span className="ml-auto text-xs text-[var(--text-faint)]">
              {messages.length} {messages.length === 1 ? 'message' : 'messages'}
            </span>
          </div>
          {temporary ? (
            <div
              role="status"
              className="flex items-center gap-3 border-b border-[var(--border-default)] px-5 py-2 text-xs text-[var(--text-muted)]"
            >
              {temporary.retrying ? 'Agent Relay is busy. Retrying to load new messages…' : 'Agent Relay is busy. New messages are paused.'}
              {temporary.retrying ? null : (
                <button type="button" onClick={retryNow} className="ml-auto font-semibold text-[var(--brand-primary)]">
                  Try again
                </button>
              )}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto bg-[color-mix(in_srgb,var(--surface-strong)_72%,transparent)] p-3 sm:p-5">
            {loading ? (
              <StateText>Loading room messages…</StateText>
            ) : messages.length === 0 ? (
              <StateText>No direct messages yet.</StateText>
            ) : (
              <ol className="space-y-3" aria-label="Relay Connect direct messages">
                {messages.map((message) => (
                  <li
                    key={message.id}
                    className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-strong)] px-4 py-3 shadow-sm"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-sm font-semibold text-[var(--foreground)]">
                        {sanitizeConnectObserverText(message.agentName)}
                      </span>
                      <time dateTime={message.createdAt} className="text-xs text-[var(--text-faint)]">
                        {formatUtcTimestamp(message.createdAt)}
                      </time>
                      <span className="ml-auto text-xs text-[var(--text-faint)]">
                        {message.participants.map(sanitizeConnectObserverText).join(', ')}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--text-secondary)]">
                      {sanitizeConnectObserverText(message.text)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function StateText({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-48 items-center justify-center text-sm text-[var(--text-muted)]">{children}</div>;
}

function TerminalState({ expired }: { expired: boolean }) {
  return (
    <main className="brand-grid flex min-h-screen items-center justify-center px-4">
      <section className="brand-glass w-full max-w-xl rounded-[2rem] p-8 text-center sm:p-10">
        <h1 className="brand-title text-2xl font-semibold text-[var(--foreground)]">
          {expired ? 'This Relay Connect has expired' : 'Observer link unavailable'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          {expired
            ? 'The room and its observer capability are no longer active.'
            : 'This link is invalid, revoked, or no longer has access to the room.'}
        </p>
      </section>
    </main>
  );
}
