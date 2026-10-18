import type { Event } from 'nostr-tools';
import { buildReply, isRoomMention, rootEventId } from './nostr.js';
import type { BridgeConfig } from './config.js';
import { StateStore } from './state.js';

export interface RelayMessage {
  id: string;
  agentName: string;
  text: string;
  threadId?: string | null;
}

export interface RelayPort {
  dm(to: string, text: string, options: { idempotencyKey: string }): Promise<{ conversationId: string; message: { id: string } }>;
  message(id: string): Promise<RelayMessage>;
  messages(conversationId: string, options: { limit: number; before?: string }): Promise<RelayMessage[]>;
}

export interface BuzzPort {
  publish(event: Event): Promise<void>;
}

/** Decimal snowflake order. A longer id is newer; equal lengths compare lexicographically. */
export function compareMessageIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

type RelayDisposition = 'published' | 'settled' | 'unmatched';

export class BuzzRoomBridge {
  private readonly buzzInFlight = new Map<string, Promise<boolean>>();
  private readonly relayInFlight = new Map<string, Promise<RelayDisposition>>();
  constructor(
    private readonly config: BridgeConfig,
    private readonly state: StateStore,
    private readonly relay: RelayPort,
    private readonly buzz: BuzzPort,
  ) {}

  get since(): number { return this.state.data.since; }

  async receiveBuzz(event: Event): Promise<boolean> {
    const active = this.buzzInFlight.get(event.id);
    if (active) return active;
    const work = this.receiveBuzzOnce(event);
    this.buzzInFlight.set(event.id, work);
    try { return await work; } finally { this.buzzInFlight.delete(event.id); }
  }

  private async receiveBuzzOnce(event: Event): Promise<boolean> {
    if (!isRoomMention(event, this.config.channelId, this.config.pubkey, this.config.botName)) return false;
    if (this.state.data.requests[event.id]) return false;

    const text = [
      `Buzz room ${this.config.channelId} · ${event.pubkey} · ${event.id}`,
      `buzz://message?channel=${this.config.channelId}&id=${event.id}`,
      'Reply to this Relay message to answer in the same Buzz thread.',
      '',
      event.content,
    ].join('\n');
    const sent = await this.relay.dm(this.config.targetAgent, text, { idempotencyKey: `buzz-room-${event.id}` });
    await this.state.update((state) => {
      state.requests[event.id] = {
        relayMessageId: sent.message.id,
        conversationId: sent.conversationId,
        buzzEventId: event.id,
        rootEventId: rootEventId(event),
        senderPubkey: event.pubkey,
        createdAt: event.created_at,
      };
      state.conversationId = sent.conversationId;
      if (!state.relayCursor) state.relayCursor = sent.message.id;
    });
    return true;
  }

  async receiveRelay(id: string): Promise<boolean> {
    return (await this.relayDisposition(id)) === 'published';
  }

  private relayDisposition(id: string): Promise<RelayDisposition> {
    const active = this.relayInFlight.get(id);
    if (active) return active;
    const work = this.receiveRelayOnce(id).finally(() => { this.relayInFlight.delete(id); });
    this.relayInFlight.set(id, work);
    return work;
  }

  private async receiveRelayOnce(id: string): Promise<RelayDisposition> {
    const existing = this.state.data.replies[id];
    if (existing) {
      if (!existing.skipped && existing.event && !existing.published) await this.publishReply(id, existing.event);
      return 'settled';
    }

    const message = await this.relay.message(id);
    if (message.agentName !== this.config.targetAgent || !message.threadId) return 'settled';
    const request = Object.values(this.state.data.requests).find((item) => item.relayMessageId === message.threadId);
    // The reply can arrive before relay.dm() saves the request row. Leave it
    // for the next catch-up instead of dropping it.
    if (!request) return 'unmatched';

    let reply: Event;
    try {
      reply = buildReply({
        secretKey: this.config.secretKey,
        channelId: this.config.channelId,
        parentId: request.buzzEventId,
        rootId: request.rootEventId,
        recipientPubkey: request.senderPubkey,
        text: message.text,
      });
    } catch (error) {
      await this.state.update((state) => { state.replies[id] = { published: false, skipped: true }; });
      console.error(`Buzz reply ${id} cannot be published: ${error instanceof Error ? error.message : String(error)}`);
      return 'settled';
    }
    await this.state.update((state) => { state.replies[id] = { event: reply, published: false }; });
    await this.publishReply(id, reply);
    return 'published';
  }

  async replayPending(): Promise<void> {
    for (const [id, record] of Object.entries(this.state.data.replies)) {
      if (record.published || record.skipped || !record.event) continue;
      try {
        await this.publishReply(id, record.event);
      } catch (error) {
        console.error(`Buzz reply ${id} was not published: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Reconcile replies missed by a WebSocket disconnect. The API lists newest first. */
  async catchUp(): Promise<void> {
    const conversationId = this.state.data.conversationId;
    const cursor = this.state.data.relayCursor;
    if (!conversationId || !cursor) return;
    let before: string | undefined;
    const newer: RelayMessage[] = [];
    for (;;) {
      const page = await this.relay.messages(conversationId, { limit: 100, ...(before ? { before } : {}) });
      const relevant = page.filter((item) => compareMessageIds(item.id, cursor) > 0);
      newer.push(...relevant);
      if (page.length < 100 || relevant.length < page.length) break;
      before = page[page.length - 1]?.id;
      if (!before) break;
    }
    newer.sort((a, b) => compareMessageIds(a.id, b.id));
    for (const item of newer) {
      if (item.agentName === this.config.targetAgent) {
        const disposition = await this.relayDisposition(item.id);
        if (disposition === 'unmatched') break;
      }
      await this.state.update((state) => { state.relayCursor = item.id; });
    }
  }

  private async publishReply(id: string, event: Event): Promise<void> {
    await this.buzz.publish(event);
    await this.state.update((state) => { state.replies[id]!.published = true; });
  }
}
