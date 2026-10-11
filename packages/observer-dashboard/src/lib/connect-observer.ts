import type { DmMessage, WorkspaceDmConversation } from '@relaycast/sdk';

const DM_PAGE_SIZE = 100;
const MAX_BROWSER_TIMEOUT_MS = 2_147_000_000;

const CREDENTIAL_PATTERN = /\b(?:rk_live|at_live|nt_live|ot_live|wh_live)_[A-Za-z0-9_-]+\b/g;
const CONNECT_INVITE_PATTERN =
  /https?:\/\/(?:www\.)?agentrelay\.com\/connect\/[A-Za-z0-9_-]+(?:\.json|\.md)?(?:\?[^\s]*)?/gi;

export function sanitizeConnectObserverText(text: string): string {
  return text
    .replace(CONNECT_INVITE_PATTERN, '[Relay Connect invite redacted]')
    .replace(CREDENTIAL_PATTERN, '[credential redacted]');
}

export function formatUtcTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Invalid time';
  return `${date.toISOString().replace('T', ' ').replace('.000Z', 'Z').replace('Z', ' UTC')}`;
}

export function connectObserverUrlWithoutCapability(value: string): string {
  const url = new URL(value);
  url.searchParams.delete('key');
  url.hash = '';
  return url.toString();
}

export function shouldInitializeConnectObserver(
  previousMode: 'workspace' | 'connect' | null,
  previousIdentity: string | null,
  observerId: string | null,
  expiresAt: string | null,
  capability: string | null,
): boolean {
  if (previousMode !== 'connect') return true;
  const identity = `${observerId ?? ''}\u0000${expiresAt ?? ''}`;
  return previousIdentity !== identity || capability !== null;
}

export function connectObserverIdentity(observerId: string | null, expiresAt: string | null): string {
  return `${observerId ?? ''}\u0000${expiresAt ?? ''}`;
}

export function connectObserverExpiryDelay(expiresAt: string, now = Date.now()): number | null {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return null;
  return Math.max(0, Math.min(deadline - now, MAX_BROWSER_TIMEOUT_MS));
}

export type ConnectObservedMessage = DmMessage & {
  conversationId: string;
  participants: string[];
};

export async function loadConnectConversationMessages(
  relay: {
    dmMessagePage(
      conversationId: string,
      options: { limit: number; before?: string; after?: string },
    ): Promise<{ messages: DmMessage[]; nextBefore: string | null; exhausted: boolean }>;
  },
  conversation: WorkspaceDmConversation,
  after?: string,
): Promise<ConnectObservedMessage[]> {
  const messages: ConnectObservedMessage[] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;
  while (true) {
    const page = await relay.dmMessagePage(conversation.id, {
      limit: DM_PAGE_SIZE,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
    messages.push(
      ...page.messages.map((message) => ({
        ...message,
        conversationId: conversation.id,
        participants: conversation.participants,
      })),
    );
    if (page.exhausted) break;
    // The cursor comes from the raw server page. It must advance even when an
    // observer filter hides every row returned to this client.
    const cursor = page.nextBefore;
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    before = cursor;
  }
  return messages;
}

/**
 * Why a Connect observer read or login failed. `revoked` is the link itself:
 * the engine rejected or no longer recognises the capability (400/401/403/404).
 * Everything else (429, 5xx, a network error, no status) is `temporary`: the
 * link may be fine and the workspace busy, so it must not look revoked.
 */
export type ConnectObserverFailure = 'revoked' | 'temporary';

export function classifyConnectObserverStatus(status: number | null | undefined): ConnectObserverFailure {
  return status === 400 || status === 401 || status === 403 || status === 404 ? 'revoked' : 'temporary';
}

export function classifyConnectObserverError(error: unknown): ConnectObserverFailure {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return classifyConnectObserverStatus(typeof status === 'number' ? status : null);
}

/** Automatic retries after a temporary failure; then the page waits for "Try again". */
export const CONNECT_OBSERVER_MAX_RETRIES = 5;
const CONNECT_OBSERVER_RETRY_BASE_MS = 2_000;
const CONNECT_OBSERVER_RETRY_MAX_MS = 30_000;

/**
 * Delay before automatic retry `attempt` (0-based): 2s, 4s, 8s, 16s, 30s, or
 * the server's Retry-After when it is longer. A quota reset can be days away,
 * so the server's deadline is kept, limited only by the browser timer range
 * (a later retry just reads a fresh Retry-After). Null once retries are spent,
 * so a busy workspace is not polled indefinitely.
 */
export function connectObserverRetryDelay(attempt: number, retryAfterMs?: number | null): number | null {
  if (attempt >= CONNECT_OBSERVER_MAX_RETRIES) return null;
  const backoff = Math.min(CONNECT_OBSERVER_RETRY_BASE_MS * 2 ** attempt, CONNECT_OBSERVER_RETRY_MAX_MS);
  const serverDelay = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(retryAfterMs, MAX_BROWSER_TIMEOUT_MS)
    : 0;
  return Math.max(backoff, serverDelay);
}

/**
 * A `Retry-After` header as milliseconds: delta-seconds or an HTTP date.
 * Null when absent, malformed or not in the future.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms > 0 ? ms : null;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) && date > now ? date - now : null;
}

/**
 * The engine answers 404 `dm_conversation_not_found` when one conversation is
 * no longer visible to the observer (its filter was narrowed between listing
 * and reading). The capability is still valid for the others.
 */
export function isConnectConversationGone(error: unknown): boolean {
  return (error as { rawCode?: unknown } | null)?.rawCode === 'dm_conversation_not_found';
}
