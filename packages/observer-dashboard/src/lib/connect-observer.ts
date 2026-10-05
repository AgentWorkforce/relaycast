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
  previousIdentity: string | null,
  observerId: string | null,
  expiresAt: string | null,
  capability: string | null,
): boolean {
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
