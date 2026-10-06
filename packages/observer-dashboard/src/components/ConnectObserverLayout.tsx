'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useEvent, useRelay } from '@relaycast/react';
import { MessageSquareText, ShieldCheck } from 'lucide-react';
import {
  connectObserverExpiryDelay,
  formatUtcTimestamp,
  loadConnectConversationMessages,
  sanitizeConnectObserverText,
  type ConnectObservedMessage,
} from '../lib/connect-observer';

const REFRESH_INTERVAL_MS = 15_000;

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
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (expired || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const conversations = await relay.allDmConversations();
      // Read conversations sequentially so a large room does not burst through
      // the workspace request budget. After the initial history walk, only
      // messages newer than the remembered snowflake are requested.
      for (const conversation of conversations) {
        const previousNewest = newestByConversation.current.get(conversation.id);
        const page = await loadConnectConversationMessages(relay, conversation, previousNewest);
        for (const message of page) messageCache.current.set(message.id, message);
        const newest = page.reduce<string | undefined>(
          (candidate, message) => (candidate === undefined || message.id > candidate ? message.id : candidate),
          previousNewest,
        );
        if (newest) newestByConversation.current.set(conversation.id, newest);
      }
      setMessages(
        [...messageCache.current.values()].sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
        ),
      );
      setUnavailable(false);
    } catch (error) {
      // Keep already-loaded history visible while transient transport errors
      // or rate limits recover. Only a denied or missing room ends access.
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status === 401 || status === 403 || status === 404) setUnavailable(true);
    } finally {
      setLoading(false);
      refreshInFlight.current = false;
    }
  }, [expired, relay]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);
  useEvent('dm.received', refresh);
  useEvent('group_dm.received', refresh);

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
