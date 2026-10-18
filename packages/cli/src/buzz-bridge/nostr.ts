import { finalizeEvent, getEventHash, validateEvent, verifyEvent, type Event } from 'nostr-tools';

const HEX_64 = /^[0-9a-f]{64}$/;

export function isRoomMention(event: Event, channelId: string, botPubkey: string, botName?: string): boolean {
  try {
    const literal = botName
      ? new RegExp(`(?:^|\\s)@${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\s|[.,!?;:])`, 'u').test(event.content)
      : false;
    return validateEvent(event)
      && event.kind === 9
      && event.pubkey !== botPubkey
      && getEventHash(event) === event.id
      && verifyEvent(event)
      && event.tags.some((tag) => tag[0] === 'h' && tag[1] === channelId)
      && (event.tags.some((tag) => (tag[0] === 'p' || tag[0] === 'mention') && tag[1] === botPubkey) || literal);
  } catch { return false; }
}

export function rootEventId(event: Event): string {
  const explicit = event.tags.find((tag) => tag[0] === 'e' && tag[3] === 'root')?.[1];
  return explicit && HEX_64.test(explicit) ? explicit : event.id;
}

export function buildReply(input: {
  secretKey: Uint8Array;
  channelId: string;
  parentId: string;
  rootId: string;
  recipientPubkey: string;
  text: string;
  createdAt?: number;
}): Event {
  if (!input.text.trim() || Buffer.byteLength(input.text, 'utf8') > 65_536) {
    throw new Error('Buzz replies must contain 1–65536 UTF-8 bytes.');
  }
  if (![input.parentId, input.rootId, input.recipientPubkey].every((id) => HEX_64.test(id))) {
    throw new Error('Invalid Buzz thread or recipient ID.');
  }
  const tags: string[][] = [['h', input.channelId]];
  if (input.rootId !== input.parentId) tags.push(['e', input.rootId, '', 'root']);
  tags.push(['e', input.parentId, '', 'reply'], ['p', input.recipientPubkey]);
  return finalizeEvent({
    kind: 9,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    content: input.text,
    tags,
  }, input.secretKey);
}
