import type { DmMessage, WorkspaceDmConversation } from '@relaycast/sdk';

const DM_PAGE_SIZE = 100;

const CREDENTIAL_PATTERN = /\b(?:rk_live|at_live|nt_live|ot_live)_[A-Za-z0-9_-]+\b/g;
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

export type ConnectObservedMessage = DmMessage & {
  conversationId: string;
  participants: string[];
};

export async function loadConnectConversationMessages(
  relay: {
    dmMessages(
      conversationId: string,
      options: { limit: number; before?: string; after?: string },
    ): Promise<DmMessage[]>;
  },
  conversation: WorkspaceDmConversation,
  after?: string,
): Promise<ConnectObservedMessage[]> {
  const messages: ConnectObservedMessage[] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;
  while (true) {
    const page = await relay.dmMessages(conversation.id, {
      limit: DM_PAGE_SIZE,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
    messages.push(
      ...page.map((message) => ({
        ...message,
        conversationId: conversation.id,
        participants: conversation.participants,
      })),
    );
    if (page.length < DM_PAGE_SIZE) break;
    // The workspace history endpoint is ordered by descending fixed-width
    // snowflake id and its `before` cursor is id-based, not timestamp-based.
    const cursor = page.at(-1)?.id;
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    before = cursor;
  }
  return messages;
}
