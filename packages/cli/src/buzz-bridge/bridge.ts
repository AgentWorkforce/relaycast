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

export class BuzzRoomBridge {
  private readonly buzzInFlight = new Map<string, Promise<boolean>>();
  private readonly relayInFlight = new Map<string, Promise<boolean>>();
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
    const active = this.relayInFlight.get(id);
    if (active) return active;
    const work = this.receiveRelayOnce(id);
    this.relayInFlight.set(id, work);
    try { return await work; } finally { this.relayInFlight.delete(id); }
  }

  private async receiveRelayOnce(id: string): Promise<boolean> {
    const existing = this.state.data.replies[id];
    if (existing) {
      if (!existing.published) await this.publishReply(id, existing.event);
      return false;
    }

    const message = await this.relay.message(id);
    if (message.agentName !== this.config.targetAgent || !message.threadId) return false;
    const request = Object.values(this.state.data.requests).find((item) => item.relayMessageId === message.threadId);
    if (!request) return false;

    const reply = buildReply({
      secretKey: this.config.secretKey,
      channelId: this.config.channelId,
      parentId: request.buzzEventId,
      rootId: request.rootEventId,
      recipientPubkey: request.senderPubkey,
      text: message.text,
    });
    await this.state.update((state) => { state.replies[id] = { event: reply, published: false }; });
    await this.publishReply(id, reply);
    return true;
  }

  async replayPending(): Promise<void> {
    for (const [id, record] of Object.entries(this.state.data.replies)) {
      if (!record.published) await this.publishReply(id, record.event);
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
      const relevant = page.filter((item) => item.id > cursor);
      newer.push(...relevant);
      if (page.length < 100 || relevant.length < page.length) break;
      before = page[page.length - 1]?.id;
      if (!before) break;
    }
    newer.sort((a, b) => a.id.localeCompare(b.id));
    for (const item of newer) {
      if (item.agentName === this.config.targetAgent) await this.receiveRelay(item.id);
      await this.state.update((state) => { state.relayCursor = item.id; });
    }
  }

  private async publishReply(id: string, event: Event): Promise<void> {
    await this.buzz.publish(event);
    await this.state.update((state) => { state.replies[id]!.published = true; });
  }
}
