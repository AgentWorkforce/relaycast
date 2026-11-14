/**
 * The split actor topology's hot path (prototype, `RELAYCAST_ACTORS_TOPOLOGY=split`).
 *
 * The Workspace actor stays the metadata owner. A DM send or channel post
 * from an agent token is routed here instead of to it:
 *
 *   1. resolve the sender, DM recipient or channel roster on the Workspace
 *      actor (cached briefly per token and target);
 *   2. commit the message on its Channel or Conversation actor, which
 *      answers the HTTP response and one hand-off per recipient inbox;
 *   3. answer the client, and hand each recipient's pending entries to its
 *      Inbox actor in the background.
 *
 * An inbox applies a hand-off idempotently and in per-source order; what it
 * accepted is confirmed to the source on that source's next post (or after
 * {@link CONFIRM_FLUSH_MS}), and until then rides along on the next hand-off.
 * A source's alarm redrives entries nobody confirmed (a gateway that died
 * mid hand-off).
 *
 * Node sockets (`/v1/node/ws`) keep their Workspace actor bridge for
 * registration and everything else, and get one extra actor socket per
 * bound agent, on its Inbox actor: {@link NodeSocketSplit}.
 */
import {
  INBOX_SEQ_BASE,
  channelActorId,
  conversationActorId,
  inboxActorId,
  type ActorHttpResponse,
  type AgentRef,
  type Confirmation,
  type InboxHandoff,
  type SourcePost,
  type SplitResolveResult,
} from '@relaycast/engine/gateway';
import WebSocket from 'ws';
import type { SourceActorName } from './actors.js';
import type { GatewayContext } from './context.js';
import { errorText } from './log.js';
import { socketTarget } from './ws.js';

/** How long a resolved sender / recipient / roster is reused. A membership change through this gateway drops it at once. */
export const RESOLVE_CACHE_MS = 5_000;
/** Confirmations not carried by a post within this long are sent on their own. */
export const CONFIRM_FLUSH_MS = 1_000;
/** One retry of a failed hand-off before the source's outbox and alarm take over. */
const HANDOFF_RETRY_MS = 250;
const MAX_CACHE_ENTRIES = 50_000;

const DM_KEYS = new Set(['to', 'text', 'mode']);
const CHANNEL_KEYS = new Set(['text', 'mode']);

type Target = { kind: 'dm'; to: string } | { kind: 'channel'; name: string };

interface HotPathSend {
  workspaceId: string;
  token: string;
  target: Target;
  text: string;
  mode: 'wait' | 'steer';
}

/**
 * The send this request is, when the split path serves it: an agent token,
 * no idempotency key, and only the body fields the split path implements
 * (`to`/`text`/`mode` for a DM, `text`/`mode` for a channel post). Anything
 * else goes to the Workspace actor's engine unchanged.
 */
export function hotPathSend(method: string | undefined, path: string, headers: [string, string][], body: Buffer | null, token: string, kind: string, workspaceId: string): HotPathSend | undefined {
  if (method !== 'POST' || kind !== 'agent' || body === null) return undefined;
  if (headers.some(([name]) => name === 'idempotency-key')) return undefined;
  let target: Target;
  let allowed: Set<string>;
  const channelMatch = /^\/v1\/channels\/([^/]+)\/messages$/.exec(path);
  if (path === '/v1/dm') {
    allowed = DM_KEYS;
    target = { kind: 'dm', to: '' };
  } else if (channelMatch) {
    allowed = CHANNEL_KEYS;
    let name: string;
    try {
      name = decodeURIComponent(channelMatch[1]!);
    } catch {
      return undefined;
    }
    target = { kind: 'channel', name };
  } else {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !allowed.has(key))) return undefined;
  if (typeof fields.text !== 'string' || fields.text.length === 0) return undefined;
  const mode = fields.mode ?? 'wait';
  if (mode !== 'wait' && mode !== 'steer') return undefined;
  if (target.kind === 'dm') {
    if (typeof fields.to !== 'string' || fields.to.length === 0) return undefined;
    target = { kind: 'dm', to: fields.to };
  }
  return { workspaceId, token, target, text: fields.text, mode };
}

export interface SplitRouter {
  /** Serve a hot-path send; `undefined` when the Workspace actor should answer it. */
  send(send: HotPathSend, signal: AbortSignal): Promise<ActorHttpResponse | undefined>;
  /** A write went to the Workspace actor: rosters and the directory may have changed. */
  invalidate(workspaceId: string): void;
  /** Hand-offs still running (tests, shutdown). */
  settled(): Promise<void>;
}

interface CacheEntry {
  at: number;
  generation: number;
  value: Promise<SplitResolveResult>;
}

export function createSplitRouter(ctx: GatewayContext, options: { now?: () => number } = {}): SplitRouter {
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const generations = new Map<string, number>();
  const generationOf = (workspaceId: string): number => generations.get(workspaceId) ?? 0;
  /** Accepted-through per recipient, per source actor, waiting to be confirmed. */
  const confirmations = new Map<string, { actorName: SourceActorName; byRecipient: Map<string, number>; timer?: NodeJS.Timeout }>();
  const inflight = new Set<Promise<unknown>>();

  function resolve(send: HotPathSend, signal: AbortSignal): Promise<SplitResolveResult> {
    const key = `${send.token}\u0000${send.target.kind}\u0000${send.target.kind === 'dm' ? send.target.to : send.target.name}`;
    const generation = generationOf(send.workspaceId);
    const hit = cache.get(key);
    if (hit && hit.generation === generation && now() - hit.at < RESOLVE_CACHE_MS) return hit.value;
    const value = ctx.actors.splitResolve(send.workspaceId, {
      token: send.token,
      ...(send.target.kind === 'dm' ? { dm_to: send.target.to } : { channel: send.target.name }),
    }, { signal });
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(key, { at: now(), generation, value });
    // A failed lookup is not cached.
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return value;
  }

  function takeConfirmations(sourceId: string): Confirmation[] | undefined {
    const pending = confirmations.get(sourceId);
    if (!pending) return undefined;
    confirmations.delete(sourceId);
    if (pending.timer) clearTimeout(pending.timer);
    return [...pending.byRecipient].map(([recipient, through]) => ({ recipient, through }));
  }

  function addConfirmation(actorName: SourceActorName, sourceId: string, recipient: string, through: number): void {
    let pending = confirmations.get(sourceId);
    if (!pending) {
      pending = { actorName, byRecipient: new Map() };
      confirmations.set(sourceId, pending);
    }
    if ((pending.byRecipient.get(recipient) ?? 0) < through) pending.byRecipient.set(recipient, through);
    pending.timer ??= setTimeout(() => {
      const list = takeConfirmations(sourceId);
      if (!list?.length) return;
      track(ctx.actors.sourceConfirm(actorName, sourceId, list).catch((error: unknown) => {
        // Unconfirmed entries are sent again and skipped by the inbox; nothing is lost.
        ctx.logger.warn('split.confirm_failed', { actor_id: sourceId, error: errorText(error) });
      }));
    }, CONFIRM_FLUSH_MS);
    pending.timer.unref?.();
  }

  function track(promise: Promise<unknown>): void {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise));
  }

  async function handOff(workspaceId: string, actorName: SourceActorName, sourceId: string, handoff: InboxHandoff): Promise<void> {
    const inboxId = inboxActorId(workspaceId, handoff.agent.id);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const accepted = await ctx.actors.inboxAccept(inboxId, handoff);
        if (accepted.through > 0) addConfirmation(actorName, sourceId, handoff.agent.id, accepted.through);
        return;
      } catch (error) {
        if (attempt >= 1) {
          // The entries stay in the source's outbox: the next post to this
          // recipient carries them again, and the source's alarm redrives them.
          ctx.logger.warn('split.handoff_failed', { workspace_id: workspaceId, actor_id: inboxId, error: errorText(error) });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, HANDOFF_RETRY_MS));
      }
    }
  }

  return {
    async send(send, signal) {
      const resolved = await resolve(send, signal);
      // Anything the split path does not serve gets the engine's own answer.
      if (!resolved.ok) return undefined;
      let actorName: SourceActorName;
      let sourceId: string;
      let input: SourcePost;
      if (send.target.kind === 'dm') {
        if (!resolved.dm) return undefined;
        actorName = 'Conversation';
        sourceId = conversationActorId(send.workspaceId, resolved.dm.pair_key);
        input = { kind: 'dm', sender: resolved.sender, conversationId: resolved.dm.conversation_id, recipient: resolved.dm.recipient, text: send.text, mode: send.mode };
      } else {
        if (!resolved.channel) return undefined;
        actorName = 'Channel';
        sourceId = channelActorId(send.workspaceId, resolved.channel.id);
        input = {
          kind: 'channel',
          sender: resolved.sender,
          channel: { id: resolved.channel.id, name: resolved.channel.name },
          recipients: resolved.channel.members,
          text: send.text,
          mode: send.mode,
        };
      }
      const confirmed = takeConfirmations(sourceId);
      let result;
      try {
        result = await ctx.actors.sourcePost(actorName, sourceId, confirmed?.length ? { ...input, confirmed } : input, { signal });
      } catch (error) {
        // Confirmations are idempotent: keep them for the next attempt.
        for (const { recipient, through } of confirmed ?? []) addConfirmation(actorName, sourceId, recipient, through);
        throw error;
      }
      // The message is committed with its outbox; delivery continues after the answer.
      for (const handoff of result.handoffs) track(handOff(send.workspaceId, actorName, sourceId, handoff));
      return {
        status: result.status,
        headers: [['content-type', 'application/json'], ['x-relaycast-topology', 'split']],
        body: result.body,
      };
    },

    invalidate(workspaceId) {
      generations.set(workspaceId, generationOf(workspaceId) + 1);
    },

    async settled() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}

/**
 * The split topology's part of one `/v1/node/ws` bridge. The client's
 * socket stays bridged to the Workspace actor (registration, heartbeats and
 * every frame outside the hot path); once the node registered, each agent
 * bound to it also gets an actor socket on its Inbox actor, whose `deliver`
 * frames go to the client. `delivery.ack` frames are routed by seq space:
 * inbox seqs start at {@link INBOX_SEQ_BASE}, so an ack at or past it goes
 * to the agent's inbox and reaches the Workspace actor only up to the last
 * seq the Workspace actor delivered.
 */
export class NodeSocketSplit {
  private readonly inboxes = new Map<string, { socket: WebSocket; agentId: string }>();
  private readonly workspaceSeq = new Map<string, number>();
  private readonly registerIds = new Set<string>();
  private readonly agentRegisterIds = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly ctx: GatewayContext,
    private readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly client: WebSocket,
    private readonly fail: (code: number, reason: string) => void,
  ) {}

  /**
   * A client frame on its way to the Workspace actor: the text to forward,
   * or `null` when the frame was handled here.
   */
  fromClient(text: string): string | null {
    const frame = parseFrame(text);
    if (!frame) return text;
    if (frame.type === 'node.register' && typeof frame.id === 'string') this.registerIds.add(frame.id);
    if (frame.type === 'agent.register' && typeof frame.id === 'string' && typeof frame.name === 'string') this.agentRegisterIds.set(frame.id, frame.name);
    if (frame.type !== 'delivery.ack' || typeof frame.agent !== 'string' || typeof frame.up_to_seq !== 'number') return text;
    const upTo = frame.up_to_seq;
    const inbox = this.inboxes.get(frame.agent);
    if (upTo >= INBOX_SEQ_BASE && inbox && inbox.socket.readyState === WebSocket.OPEN) inbox.socket.send(text);
    if (upTo < INBOX_SEQ_BASE) return text;
    const delivered = this.workspaceSeq.get(frame.agent);
    return delivered === undefined ? null : JSON.stringify({ ...frame, up_to_seq: delivered });
  }

  /** A Workspace actor frame on its way to the client. */
  fromWorkspace(text: string): void {
    const frame = parseFrame(text);
    if (!frame) return;
    if (frame.type === 'deliver' && typeof frame.agent === 'string' && typeof frame.seq === 'number') {
      this.workspaceSeq.set(frame.agent, Math.max(frame.seq, this.workspaceSeq.get(frame.agent) ?? 0));
      return;
    }
    if (frame.type !== 'reply' || frame.ok !== true || typeof frame.id !== 'string') return;
    if (this.registerIds.delete(frame.id)) {
      void this.ctx.actors.splitNodeAgents(this.workspaceId, this.nodeId)
        .then((agents) => { for (const agent of agents) this.attach(agent); })
        .catch((error: unknown) => this.attachFailed(error));
      return;
    }
    const name = this.agentRegisterIds.get(frame.id);
    if (name !== undefined) {
      this.agentRegisterIds.delete(frame.id);
      const data = frame.data as { agent_id?: unknown; name?: unknown } | undefined;
      if (typeof data?.agent_id === 'string') this.attach({ id: data.agent_id, name: typeof data.name === 'string' ? data.name : name });
    }
  }

  close(): void {
    this.closed = true;
    for (const { socket } of this.inboxes.values()) socket.close(1000, 'node socket closed');
    this.inboxes.clear();
  }

  private attachFailed(error: unknown): void {
    this.ctx.logger.error('split.inbox_attach_failed', { workspace_id: this.workspaceId, node_id: this.nodeId, error: errorText(error) });
    // Without its inbox sockets the node would miss hot-path deliveries: make it reconnect.
    this.fail(1011, 'inbox unavailable');
  }

  private attach(agent: AgentRef): void {
    if (this.closed || this.inboxes.has(agent.name)) return;
    const actorId = inboxActorId(this.workspaceId, agent.id);
    const metadata = { v: 1, kind: 'inbox', workspace_id: this.workspaceId, agent_id: agent.id, agent_name: agent.name };
    // Reserve the name so a second register reply does not open a second socket.
    const placeholder = { socket: undefined as unknown as WebSocket, agentId: agent.id };
    this.inboxes.set(agent.name, placeholder);
    void this.ctx.actors.findSplitWebsocket('Inbox', actorId, metadata).then((grant) => {
      if (this.closed) return;
      const target = socketTarget(grant.websocketUrl, this.ctx.config.socketOrigin);
      const socket = new WebSocket(target.url, {
        ...(target.headers ? { headers: target.headers } : {}),
        ...(target.servername ? { servername: target.servername } : {}),
      });
      placeholder.socket = socket;
      socket.on('message', (data) => {
        if (this.client.readyState === WebSocket.OPEN) this.client.send(data.toString());
      });
      socket.on('error', (error) => {
        this.ctx.logger.warn('split.inbox_socket_error', { workspace_id: this.workspaceId, actor_id: actorId, error: errorText(error) });
      });
      socket.on('close', (code) => {
        if (this.closed) return;
        // A replay on a new inbox socket would repeat frames this client
        // already has on the same connection: reconnect the client instead,
        // so a redelivery is one across connections, as on the engine.
        this.ctx.logger.warn('split.inbox_socket_closed', { workspace_id: this.workspaceId, actor_id: actorId, code });
        this.fail(1012, 'inbox socket closed');
      });
    }).catch((error: unknown) => this.attachFailed(error));
  }
}

function parseFrame(text: string): Record<string, unknown> | undefined {
  // Only frames that can matter here are parsed.
  if (!text.includes('"type"')) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
