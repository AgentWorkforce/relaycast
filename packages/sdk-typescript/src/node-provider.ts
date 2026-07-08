import {
  parseFleetRelaycastToBrokerMessage,
  type FleetCapability,
  type FleetCapabilityAcceptance,
  type FleetProviderIdentity,
  type FleetWireJsonValue,
  type NodeRegisterReplyData,
} from '@relaycast/types';
import { SDK_VERSION } from './version.js';

/**
 * A node provider client: it attaches a process to a node, registers a subset
 * of that node's capabilities against the engine's `/v1/node/ws`, and executes
 * their invokes. It is the language-neutral equivalent of the broker's Rust
 * provider — connection, registration, heartbeats, invoke dispatch, and the
 * handler-context helpers — with no local-broker dependency.
 *
 * Enrollment (reading the node token/URL from disk) layers on top of this in a
 * thin wrapper; the client itself takes an explicit token and base URL.
 */

type JsonObject = Record<string, FleetWireJsonValue>;

/** A capability's declaration alongside its handler. */
export interface NodeCapabilityOptions {
  /**
   * `action` (default) materializes an invokable handler; `capacity`
   * (`spawn:<harness>`, `release`) describes what the node can run and is never
   * materialized. Omit to let the engine classify by name.
   */
  kind?: 'action' | 'capacity';
  /** Claim a workspace-global alias for this action name. */
  global?: boolean;
  /** Queue invokes while this provider is offline instead of failing fast. */
  queue?: boolean;
  metadata?: JsonObject;
}

/** Context passed to every capability handler. */
export interface NodeHandlerContext {
  /** Informational view of the node this provider is attached to. */
  node: { name: string; capabilities: string[] };
  /** The invocation being handled. */
  invocationId: string;
  /**
   * Post a channel message, attributed to `from` (an agent name resolved in the
   * workspace). Resolves with the posted message.
   */
  sendMessage(input: NodeSendMessageInput): Promise<unknown>;
  /**
   * Spawn an agent through the node's capacity executor. Capacity-direct: it
   * never re-enters action dispatch, so a `spawn:<harness>` shadow handler that
   * delegates cannot recurse into itself. Resolves with the spawn placement.
   */
  spawnAgent(input: JsonObject): Promise<unknown>;
}

export interface NodeSendMessageInput {
  to: string;
  from: string;
  text: string;
  threadId?: string;
  mode?: 'wait' | 'steer';
  data?: JsonObject;
}

export type NodeCapabilityHandler = (
  input: FleetWireJsonValue,
  ctx: NodeHandlerContext,
) => unknown | Promise<unknown>;

interface RegisteredCapability {
  options: NodeCapabilityOptions;
  handler: NodeCapabilityHandler;
}

export interface NodeProviderOptions {
  /** Engine base URL; defaults to `https://cast.agentrelay.com`. */
  baseUrl?: string;
  /** The node's shared `nt_live_` token. */
  nodeToken: string;
  /** The enrolled node id. */
  nodeId: string;
  /** The node's name (the target others address). */
  nodeName: string;
  /**
   * Provider identity. `name` is stable across reconnects; `instanceId` is the
   * connection epoch and is regenerated on every connection when omitted (the
   * replace semantic).
   */
  provider: { name: string; instanceId?: string };
  /** Capabilities and their handlers, keyed by capability name. */
  capabilities?: Record<string, NodeCapabilityHandler | (NodeCapabilityOptions & { handler: NodeCapabilityHandler })>;
  /** Provider-level agent capacity reported at registration. */
  maxAgents?: number;
  tags?: string[];
  version?: string;
  machineId?: string;
  heartbeatIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitter?: boolean;
  /** Max reconnect attempts after an unexpected drop; defaults to unbounded. */
  maxReconnectAttempts?: number;
  onError?: (err: Error) => void;
  debug?: boolean;
}

/** Thrown when the engine rejects the provider's registration. */
export class NodeRegistrationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'NodeRegistrationError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

function randomId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class NodeProviderClient {
  private readonly baseUrl: string;
  private readonly nodeToken: string;
  private readonly nodeId: string;
  private readonly nodeName: string;
  private readonly providerName: string;
  private readonly initialInstanceId?: string;
  private readonly maxAgents: number;
  private readonly tags: string[];
  private readonly version: string;
  private readonly machineId?: string;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectJitter: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly onError?: (err: Error) => void;
  private readonly debug: boolean;

  private readonly capabilities = new Map<string, RegisteredCapability>();
  private readonly pending = new Map<string, PendingRequest>();

  private ws: WebSocket | null = null;
  private instanceId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private registered = false;

  private servePromise: Promise<void> | null = null;
  private resolveServe: (() => void) | null = null;
  private rejectServe: ((err: Error) => void) | null = null;
  private registerPromise: Promise<NodeRegisterReplyData> | null = null;
  private resolveRegister: ((data: NodeRegisterReplyData) => void) | null = null;
  private rejectRegister: ((err: Error) => void) | null = null;

  constructor(options: NodeProviderOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://cast.agentrelay.com').replace(/\/+$/, '');
    this.nodeToken = options.nodeToken;
    this.nodeId = options.nodeId;
    this.nodeName = options.nodeName;
    this.providerName = options.provider.name;
    this.initialInstanceId = options.provider.instanceId;
    this.maxAgents = options.maxAgents ?? 0;
    this.tags = options.tags ?? [];
    this.version = options.version ?? SDK_VERSION;
    this.machineId = options.machineId;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 500;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.reconnectJitter = options.reconnectJitter ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
    this.onError = options.onError;
    this.debug = options.debug ?? false;

    for (const [name, value] of Object.entries(options.capabilities ?? {})) {
      if (typeof value === 'function') {
        this.capability(name, value);
      } else {
        const { handler, ...opts } = value;
        this.capability(name, opts, handler);
      }
    }
  }

  /** Register a capability and its handler. */
  capability(name: string, handler: NodeCapabilityHandler): this;
  capability(name: string, options: NodeCapabilityOptions, handler: NodeCapabilityHandler): this;
  capability(
    name: string,
    optionsOrHandler: NodeCapabilityOptions | NodeCapabilityHandler,
    handler?: NodeCapabilityHandler,
  ): this {
    const options = typeof optionsOrHandler === 'function' ? {} : optionsOrHandler;
    const fn = typeof optionsOrHandler === 'function' ? optionsOrHandler : handler;
    if (!fn) throw new Error(`capability "${name}" requires a handler`);
    this.capabilities.set(name, { options, handler: fn });
    return this;
  }

  get connected(): boolean {
    return this.registered && this.ws?.readyState === 1;
  }

  /** Resolves once the provider is registered and its capabilities accepted. */
  whenRegistered(): Promise<NodeRegisterReplyData> {
    if (!this.registerPromise) {
      this.registerPromise = new Promise<NodeRegisterReplyData>((resolve, reject) => {
        this.resolveRegister = resolve;
        this.rejectRegister = reject;
      });
    }
    return this.registerPromise;
  }

  /**
   * Connect, register, and dispatch invokes until {@link stop} is called.
   * Reconnects with backoff on unexpected drops, re-registering with a fresh
   * instance id. The returned promise resolves on graceful {@link stop} and
   * rejects if the initial registration is rejected by the engine.
   */
  serve(): Promise<void> {
    if (this.servePromise) return this.servePromise;
    this.stopped = false;
    this.servePromise = new Promise<void>((resolve, reject) => {
      this.resolveServe = resolve;
      this.rejectServe = reject;
    });
    // `whenRegistered()` mirrors the same rejection; keep it from surfacing as
    // an unhandled rejection when a caller only awaits serve().
    this.whenRegistered().catch(() => {});
    this.openSocket();
    return this.servePromise;
  }

  private settleServe(err?: Error): void {
    if (err) this.rejectServe?.(err);
    else this.resolveServe?.();
    this.resolveServe = null;
    this.rejectServe = null;
  }

  /** Gracefully deregister the provider and close the connection. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.stopHeartbeat();
    if (this.ws && this.ws.readyState === 1 && this.registered && this.instanceId) {
      this.sendFrame({ type: 'node.deregister', provider: this.providerIdentity() });
    }
    this.rejectPending(new Error('node provider stopped'));
    this.closeSocket();
    this.registered = false;
    this.settleServe();
  }

  private providerIdentity(): FleetProviderIdentity {
    return { name: this.providerName, instance_id: this.instanceId ?? '' };
  }

  private openSocket(): void {
    if (this.stopped) return;
    // A fresh instance id per connection: reconnecting with a new id replaces the
    // previous attachment (the engine's reconnect-vs-duplicate arbitration).
    this.instanceId = this.reconnectAttempt === 0 && this.initialInstanceId
      ? this.initialInstanceId
      : randomId();
    this.registered = false;

    const url = new URL('/v1/node/ws', `${this.baseUrl.replace(/^http/, 'ws')}/`);
    url.searchParams.set('token', this.nodeToken);
    url.searchParams.set('origin_client', '@relaycast/sdk');
    url.searchParams.set('origin_version', SDK_VERSION);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      this.reportError(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.sendRegister();
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      this.handleFrame(String(event.data));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      const wasRegistered = this.registered;
      this.registered = false;
      this.rejectPending(new Error('node provider connection closed'));
      if (this.stopped) {
        this.settleServe();
        return;
      }
      // A rejected registration is deterministic — do not reconnect into the same
      // rejection; surface it and stop.
      if (this.rejectRegister && !wasRegistered && this.registrationRejected) {
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.reportError(new Error('node provider websocket error'));
    };
  }

  private registrationRejected = false;

  private sendRegister(): void {
    this.registrationRejected = false;
    const id = randomId();
    const capabilities: FleetCapability[] = [...this.capabilities.entries()].map(([name, cap]) => ({
      name,
      ...(cap.options.kind ? { kind: cap.options.kind } : {}),
      ...(cap.options.global ? { global: true } : {}),
      ...(cap.options.queue ? { queue: true } : {}),
      ...(cap.options.metadata ? { metadata: cap.options.metadata } : {}),
    }));
    this.request(id, {
      type: 'node.register',
      name: this.nodeName,
      node_id: this.nodeId,
      provider: this.providerIdentity(),
      capabilities,
      max_agents: this.maxAgents,
      tags: this.tags,
      version: this.version,
      ...(this.machineId ? { machine_id: this.machineId } : {}),
      resume_cursor: null,
    })
      .then((data) => this.onRegistered(data as NodeRegisterReplyData))
      .catch((err) => this.onRegisterFailed(err as Error));
  }

  private onRegistered(data: NodeRegisterReplyData): void {
    const rejected = (data.accepted_capabilities ?? []).filter((c: FleetCapabilityAcceptance) => !c.accepted);
    if (rejected.length > 0) {
      const detail = rejected.map((c) => `${c.name}${c.reason ? ` (${c.reason})` : ''}`).join(', ');
      this.onRegisterFailed(new NodeRegistrationError(`Capabilities rejected: ${detail}`, 'capabilities_rejected'));
      return;
    }
    this.registered = true;
    this.reconnectAttempt = 0;
    this.startHeartbeat();
    this.resolveRegister?.(data);
    this.resolveRegister = null;
    this.rejectRegister = null;
  }

  private onRegisterFailed(err: Error): void {
    this.registrationRejected = true;
    this.rejectRegister?.(err);
    this.rejectRegister = null;
    this.resolveRegister = null;
    this.reportError(err);
    // Close without reconnect; the onclose handler observes registrationRejected.
    this.closeSocket();
    if (!this.stopped) {
      this.stopped = true;
      this.settleServe(err);
    }
  }

  private handleFrame(raw: string): void {
    let message;
    try {
      message = parseFleetRelaycastToBrokerMessage(JSON.parse(raw));
    } catch (err) {
      if (this.debug) this.reportError(err);
      return;
    }
    switch (message.type) {
      case 'reply': {
        const p = this.pending.get(message.id);
        if (p) {
          this.pending.delete(message.id);
          p.resolve(message.data);
        }
        return;
      }
      case 'error': {
        const p = this.pending.get(message.id);
        if (p) {
          this.pending.delete(message.id);
          p.reject(new NodeRegistrationError(message.message, message.code));
        }
        return;
      }
      case 'action.invoke':
        void this.dispatchInvoke(message.invocation_id, message.action, message.input);
        return;
      default:
        // deliver / context.update / ping carry no work for a provider client.
        return;
    }
  }

  private async dispatchInvoke(invocationId: string, action: string, input: FleetWireJsonValue): Promise<void> {
    const cap = this.capabilities.get(action);
    if (!cap) {
      this.sendFrame({ type: 'action.result', invocation_id: invocationId, error: `No handler registered for action "${action}"` });
      return;
    }
    // A handler failure becomes an error result; the invocation is never dropped.
    let output: unknown;
    let handlerError: unknown;
    try {
      output = await cap.handler(input, this.makeContext(invocationId));
    } catch (err) {
      handlerError = err;
    }
    if (handlerError !== undefined) {
      this.sendFrame({ type: 'action.result', invocation_id: invocationId, error: errorMessage(handlerError) });
      return;
    }
    this.sendFrame({ type: 'action.result', invocation_id: invocationId, output: (output ?? null) as FleetWireJsonValue });
  }

  private makeContext(invocationId: string): NodeHandlerContext {
    return {
      node: { name: this.nodeName, capabilities: [...this.capabilities.keys()] },
      invocationId,
      sendMessage: (input) => this.request(randomId(), {
        type: 'node.message',
        to: input.to,
        from: input.from,
        text: input.text,
        ...(input.threadId ? { thread_id: input.threadId } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.data ? { data: input.data } : {}),
      }),
      // Capacity-direct: the engine always targets this connection's own node,
      // so the frame carries no node target.
      spawnAgent: (input) => this.request(randomId(), {
        type: 'node.spawn',
        input,
      }),
    };
  }

  /** Send a request frame keyed by `id` and await its reply/error. */
  private request(id: string, frame: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('node provider websocket is not open'));
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify({ v: 1, id, ...frame }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendFrame(frame: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify({ v: 1, ...frame }));
    } catch (err) {
      if (this.debug) this.reportError(err);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendFrame({
        type: 'node.heartbeat',
        provider: this.providerIdentity(),
        load: 0,
        active_agents: 0,
        handlers_live: true,
      });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      const err = new Error('node provider exhausted reconnect attempts');
      this.reportError(err);
      this.stopped = true;
      this.settleServe(err);
      return;
    }
    this.reconnectAttempt += 1;
    const exp = Math.min(this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempt - 1), this.reconnectMaxDelayMs);
    const delay = this.reconnectJitter ? Math.round(exp * (0.5 + Math.random())) : exp;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private closeSocket(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = null;
    }
  }

  private reportError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.onError) this.onError(error);
    else if (this.debug) console.warn('[relaycast node-provider]', error);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
