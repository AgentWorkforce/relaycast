import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { agent } from "@agent-relay/agent";
import { computeRetryDelayMs } from "@agent-relay/events";
import { createApp } from "@relayauth/server";
import { createSqliteStorage, type SqliteStorage } from "@relayauth/server/storage/sqlite";
import type { RelayAuthTokenClaims } from "@relayauth/types";

// M2 data-trigger acceptance lives in ./data-trigger-e2e.test.ts, which shells
// out to services/agent-gateway/tests/data-trigger-e2e.test.ts. That suite
// exercises the real gateway DO after relayfile watch registration and injects
// at the watch subscription boundary rather than provider HTTP webhook ingress.

type GatewayState = {
  registerCalls: number;
  unregisterCalls: number;
  lastScheduledFor: string;
  lastScheduleId: string;
  subscribers: Map<string, Set<OpenWebSocket>>;
  deliveries: Map<string, { agentId: string; event: GatewayEvent }>;
  inboxRegistrations: Map<string, string[]>;
  replyCalls: Array<{ threadId: string; text: string }>;
  dmCalls: Array<{ agentOrUser: string; text: string }>;
};

type GatewayEvent =
  | {
      id: string;
      workspace: string;
      type: "cron.tick";
      occurredAt: string;
      schedule: string;
      scheduledFor: string;
      attempt: number;
    }
  | {
      id: string;
      workspace: string;
      type: "relaycast.message";
      occurredAt: string;
      channel: string;
      messageId: string;
      threadId?: string;
      attempt: number;
      summary?: {
        title?: string;
        actor?: { id: string; displayName?: string };
      };
    };

function createGatewayState(): GatewayState {
  return {
    registerCalls: 0,
    unregisterCalls: 0,
    lastScheduledFor: "",
    lastScheduleId: "",
    subscribers: new Map(),
    deliveries: new Map(),
    inboxRegistrations: new Map(),
    replyCalls: [],
    dmCalls: [],
  };
}

let activeGatewayState = createGatewayState();
let scheduleSequence = 0;
const WORKSPACE_BOOTSTRAP_SCOPES = [
  "relayauth:token:create:*",
  "relayauth:token:manage:*",
  "relayauth:role:read:*",
  "relaycast:channel:read:*",
  "relaycast:channel:send:*",
  "relayfile:fs:read:*",
  "relayfile:fs:write:*",
] as const;

const TEST_RSA_KEY_PAIR = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_RS256_PRIVATE_KEY_PEM = TEST_RSA_KEY_PAIR.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const TEST_RS256_PUBLIC_KEY_PEM = TEST_RSA_KEY_PAIR.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

type TestRelayAuthApp = ReturnType<typeof createApp> & {
  bindings: {
    INTERNAL_SECRET: string;
    RELAYAUTH_SIGNING_KEY_PEM: string;
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: string;
  };
  close(): Promise<void> | void;
};

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signRs256(payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(unsigned), TEST_RS256_PRIVATE_KEY_PEM)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

function generateTestToken(claims: Partial<RelayAuthTokenClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const sub = claims.sub ?? "agent_test";
  const sponsorId = claims.sponsorId ?? "user_test";
  const workspaceId = claims.workspace_id ?? claims.wks ?? "ws_test";
  const payload: RelayAuthTokenClaims = {
    sub,
    org: claims.org ?? "org_test",
    wks: claims.wks ?? workspaceId,
    workspace_id: workspaceId,
    agent_name: claims.agent_name ?? sub,
    scopes: claims.scopes ?? ["*"],
    sponsorId,
    sponsorChain: claims.sponsorChain ?? [sponsorId, sub],
    token_type: claims.token_type ?? "access",
    iss: claims.iss ?? "relayauth:test",
    aud: claims.aud ?? ["relayauth", "relayfile"],
    exp: claims.exp ?? now + 3600,
    iat: claims.iat ?? now,
    jti: claims.jti ?? crypto.randomUUID(),
    nbf: claims.nbf,
    sid: claims.sid,
    meta: claims.meta,
    parentTokenId: claims.parentTokenId,
    budget: claims.budget,
  };

  return signRs256(payload);
}

function createTestRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: HeadersInit = {},
): Request {
  const initHeaders = new Headers(headers);
  const requestInit: RequestInit = { method, headers: initHeaders };
  if (body !== undefined) {
    if (!initHeaders.has("Content-Type")) {
      initHeaders.set("Content-Type", "application/json");
    }
    requestInit.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, requestInit);
}

async function assertJsonResponse<T>(response: Response, status: number): Promise<T> {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  return await response.json() as T;
}

function createTestApp(): TestRelayAuthApp {
  const storage: SqliteStorage = createSqliteStorage(":memory:");
  const bindings = {
    INTERNAL_SECRET: storage.INTERNAL_SECRET,
    RELAYAUTH_SIGNING_KEY_PEM: TEST_RS256_PRIVATE_KEY_PEM,
    RELAYAUTH_SIGNING_KEY_PEM_PUBLIC: TEST_RS256_PUBLIC_KEY_PEM,
  };

  storage.INTERNAL_SECRET = bindings.INTERNAL_SECRET;

  const app = createApp({
    storage,
    defaultBindings: bindings,
  }) as TestRelayAuthApp;
  app.bindings = bindings;
  app.close = () => storage.close();
  return app;
}

class OpenWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = OpenWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;

  private agentId: string | null = null;
  private closed = false;

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = OpenWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(payload: string): void {
    const message = JSON.parse(payload) as
      | { type: "subscribe"; agentId?: string }
      | {
          type: "register";
          schedule?:
            | string
            | { cron: string; tz?: string }
            | { at: string };
          inbox?: string[];
        }
      | { type: "unregister"; scheduleIds?: string[] }
      | { type: "ack"; eventId?: string }
      | { type: "nack"; eventId?: string; error?: string; noRetry?: boolean }
      | { type: "messages_reply"; requestId?: string; threadId?: string; text?: string }
      | { type: "messages_dm"; requestId?: string; agentOrUser?: string; text?: string }
      | { type: "pong" };

    switch (message.type) {
      case "subscribe": {
        this.agentId = message.agentId ?? "agent";
        const subscribers =
          activeGatewayState.subscribers.get(this.agentId) ?? new Set<OpenWebSocket>();
        subscribers.add(this);
        activeGatewayState.subscribers.set(this.agentId, subscribers);
        this.emit({ type: "connected" });
        return;
      }
      case "register": {
        activeGatewayState.registerCalls += 1;
        if (Array.isArray(message.inbox) && this.agentId) {
          activeGatewayState.inboxRegistrations.set(this.agentId, [...message.inbox]);
          this.emit({
            type: "registered",
            schedules: [],
            inbox: message.inbox,
          });
          return;
        }
        const scheduleId = `sched_${++scheduleSequence}`;
        const scheduledFor = readScheduledFor(message.schedule);
        activeGatewayState.lastScheduleId = scheduleId;
        activeGatewayState.lastScheduledFor = scheduledFor;
        this.emit({
          type: "registered",
          schedules: [{ gatewayScheduleId: scheduleId }],
        });
        const delayMs = Math.max(10, Date.parse(scheduledFor) - Date.now());
        setTimeout(() => {
          const agentId = this.agentId;
          if (!agentId) {
            return;
          }
          const subscribers = activeGatewayState.subscribers.get(agentId);
          if (!subscribers) {
            return;
          }
          const event: GatewayEvent = {
            id: `tick:${scheduleId}:${scheduledFor}`,
            workspace: "support",
            type: "cron.tick",
            occurredAt: scheduledFor,
            schedule: scheduledFor,
            scheduledFor,
            attempt: 1,
          };
          activeGatewayState.deliveries.set(event.id, { agentId, event });
          emitGatewayEvent(agentId, event);
        }, delayMs);
        return;
      }
      case "unregister":
        activeGatewayState.unregisterCalls += 1;
        this.emit({
          type: "unregistered",
          scheduleIds: message.scheduleIds ?? [],
        });
        return;
      case "ack":
        if (message.eventId) {
          activeGatewayState.deliveries.delete(message.eventId);
        }
        return;
      case "nack": {
        const eventId = message.eventId?.trim();
        if (!eventId) {
          return;
        }
        const delivery = activeGatewayState.deliveries.get(eventId);
        if (!delivery) {
          return;
        }
        if (message.noRetry) {
          activeGatewayState.deliveries.delete(eventId);
          return;
        }

        delivery.event = {
          ...delivery.event,
          attempt: delivery.event.attempt + 1,
        };
        setTimeout(() => {
          if (!activeGatewayState.deliveries.has(eventId)) {
            return;
          }
          emitGatewayEvent(delivery.agentId, delivery.event);
        }, computeRetryDelayMs(delivery.event.attempt - 1, () => 0));
        return;
      }
      case "messages_reply":
        activeGatewayState.replyCalls.push({
          threadId: message.threadId ?? "",
          text: message.text ?? "",
        });
        this.emit({
          type: "messages_result",
          requestId: message.requestId,
          id: `reply:${message.threadId ?? "unknown"}`,
        });
        return;
      case "messages_dm":
        activeGatewayState.dmCalls.push({
          agentOrUser: message.agentOrUser ?? "",
          text: message.text ?? "",
        });
        this.emit({
          type: "messages_result",
          requestId: message.requestId,
          id: `dm:${message.agentOrUser ?? "unknown"}`,
        });
        return;
      case "pong":
        return;
      default:
        this.onerror?.(new Error(`Unsupported websocket message type: ${(message as { type?: string }).type}`));
    }
  }

  close(code = 1000, reason = "closed"): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = OpenWebSocket.CLOSED;
    if (this.agentId) {
      const subscribers = activeGatewayState.subscribers.get(this.agentId);
      subscribers?.delete(this);
      if (subscribers?.size === 0) {
        activeGatewayState.subscribers.delete(this.agentId);
      }
    }
    this.onclose?.({ code, reason });
  }

  emit(message: unknown): void {
    if (this.closed) {
      return;
    }
    queueMicrotask(() => {
      if (!this.closed) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    });
  }
}

function emitGatewayEvent(agentId: string, event: GatewayEvent): void {
  activeGatewayState.deliveries.set(event.id, { agentId, event });
  const subscribers = activeGatewayState.subscribers.get(agentId);
  if (!subscribers) {
    return;
  }

  for (const socket of subscribers) {
    socket.emit({
      type: "event",
      event,
    });
  }
}

function installOpenWebSocket(state: GatewayState): () => void {
  activeGatewayState = state;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = OpenWebSocket as never;

  return () => {
    globalThis.WebSocket = originalWebSocket;
    activeGatewayState = createGatewayState();
  };
}

function installRelaycronFetchTrap(
  onCall: (request: Request) => void,
): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    if (request.url.startsWith("http://relaycron.test")) {
      onCall(request);
      throw new Error("relaycron HTTP should not be called by the SDK in M1");
    }
    return originalFetch(request);
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function readScheduledFor(
  schedule: string | { cron: string; tz?: string } | { at: string } | undefined,
): string {
  if (typeof schedule === "string") {
    return new Date(Date.now() + 50).toISOString();
  }
  if (schedule && "at" in schedule) {
    return new Date(schedule.at).toISOString();
  }
  return new Date(Date.now() + 50).toISOString();
}

async function issueWorkspaceToken() {
  const app = createTestApp();
  const response = await app.request(
    createTestRequest(
      "POST",
      "/v1/tokens/workspace",
      {
        workspaceId: "support",
        name: "workspace:support",
        scopes: [...WORKSPACE_BOOTSTRAP_SCOPES],
      },
      {
        Authorization: `Bearer ${generateTestToken({
          org: "org_proactive_runtime",
          wks: "support",
          scopes: [
            "relayauth:api-key:manage:*",
            "relayauth:token:read:*",
            ...WORKSPACE_BOOTSTRAP_SCOPES,
          ],
        })}`,
      },
    ),
    undefined,
    app.bindings,
  );

  const body = await assertJsonResponse<{ key: string }>(response, 201);
  return { app, key: body.key };
}

test(
  "M1 acceptance: one workspace token should register a one-shot tick and retry the handler once",
  async (t) => {
    const { app: relayauthApp, key: workspaceToken } = await issueWorkspaceToken();
    const gatewayState = createGatewayState();
    const restoreWebSocket = installOpenWebSocket(gatewayState);
    let handlerCalls = 0;
    let firstAttemptAt = 0;

    t.after(() => {
      restoreWebSocket();
      relayauthApp.close();
    });

    const scheduledFor = new Date(Date.now() + 50).toISOString();
    const handle = agent({
      workspace: "support",
      schedule: { at: scheduledFor },
      onEvent(_ctx, event) {
        if (event.type !== "cron.tick") {
          return;
        }

        handlerCalls += 1;
        if (handlerCalls === 1) {
          firstAttemptAt = Date.now();
          throw new Error("fail once");
        }
      },
      options: {
        apiKey: workspaceToken,
        gatewayUrl: "ws://gateway.test/v1/agent-events",
        relaycronBaseUrl: "http://relaycron.test",
        handleSignals: false,
      },
    });

    await handle.ready;
    assert.equal(gatewayState.registerCalls, 1);

    const scheduledForMs = Date.parse(gatewayState.lastScheduledFor);
    assert.equal(Number.isNaN(scheduledForMs), false);

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    assert.equal(handlerCalls, 2);
    assert.ok(firstAttemptAt >= scheduledForMs);
    assert.ok(firstAttemptAt - scheduledForMs <= 1_000);

    await handle.stop();
    assert.equal(gatewayState.unregisterCalls, 1);
  },
);

test(
  "M1 schedule registration uses the gateway websocket control plane instead of relaycron HTTP",
  async (t) => {
    const { app: relayauthApp, key: workspaceToken } = await issueWorkspaceToken();
    const gatewayState = createGatewayState();
    const restoreWebSocket = installOpenWebSocket(gatewayState);
    let relaycronCalls = 0;
    const restoreFetch = installRelaycronFetchTrap(() => {
      relaycronCalls += 1;
    });

    t.after(() => {
      restoreFetch();
      restoreWebSocket();
      relayauthApp.close();
    });

    const handle = agent({
      workspace: "support",
      schedule: { at: new Date(Date.now() + 50).toISOString() },
      onEvent() {},
      options: {
        apiKey: workspaceToken,
        gatewayUrl: "ws://gateway.test/v1/agent-events",
        relaycronBaseUrl: "http://relaycron.test",
        handleSignals: false,
      },
    });

    await handle.ready;

    assert.equal(gatewayState.registerCalls, 1);
    assert.equal(relaycronCalls, 0);

    await handle.stop();
  },
);

test(
  "M3 acceptance: inbox registration delivers relaycast messages, retries once, and routes replies and DMs",
  async (t) => {
    const { app: relayauthApp, key: workspaceToken } = await issueWorkspaceToken();
    const gatewayState = createGatewayState();
    const restoreWebSocket = installOpenWebSocket(gatewayState);
    const seen: string[] = [];

    t.after(() => {
      restoreWebSocket();
      relayauthApp.close();
    });

    const handle = agent({
      workspace: "support",
      inbox: ["#support-agents", "@self"],
      async onEvent(ctx, event) {
        if (event.type !== "relaycast.message") {
          return;
        }

        seen.push(`${event.channel}:${event.messageId}:${event.attempt}`);
        if (event.messageId === "msg-thread-1" && event.attempt === 1) {
          throw new Error("retry once");
        }

        if (event.threadId) {
          await ctx.messages.reply(event.threadId, `reply:${event.messageId}`);
          return;
        }

        await ctx.messages.dm("@teammate", `dm:${event.messageId}`);
      },
      options: {
        apiKey: workspaceToken,
        gatewayUrl: "ws://gateway.test/v1/agent-events",
        handleSignals: false,
      },
    });

    await handle.ready;
    assert.deepEqual(gatewayState.inboxRegistrations.get("support"), ["#support-agents", "@self"]);

    emitGatewayEvent("support", {
      id: "relaycast:support:support-agents:msg-thread-1",
      workspace: "support",
      type: "relaycast.message",
      occurredAt: "2026-05-12T00:00:00.000Z",
      channel: "support-agents",
      messageId: "msg-thread-1",
      threadId: "thread-1",
      attempt: 1,
      summary: {
        title: "Thread question",
        actor: { id: "usr_1", displayName: "Ada" },
      },
    });
    emitGatewayEvent("support", {
      id: "relaycast:support:dm:msg-dm-1",
      workspace: "support",
      type: "relaycast.message",
      occurredAt: "2026-05-12T00:00:01.000Z",
      channel: "@self",
      messageId: "msg-dm-1",
      attempt: 1,
      summary: {
        title: "Direct question",
        actor: { id: "usr_2", displayName: "Grace" },
      },
    });

    await waitFor(() => seen.includes("support-agents:msg-thread-1:2"));
    await waitFor(() => seen.includes("@self:msg-dm-1:1"));

    assert.deepEqual(seen, [
      "support-agents:msg-thread-1:1",
      "@self:msg-dm-1:1",
      "support-agents:msg-thread-1:2",
    ]);
    assert.deepEqual(gatewayState.replyCalls, [
      { threadId: "thread-1", text: "reply:msg-thread-1" },
    ]);
    assert.deepEqual(gatewayState.dmCalls, [
      { agentOrUser: "@teammate", text: "dm:msg-dm-1" },
    ]);

    await handle.stop();
  },
);

test(
  "M3 ordering: relaycast inbox events preserve delivery order when concurrency is 1",
  async (t) => {
    const { app: relayauthApp, key: workspaceToken } = await issueWorkspaceToken();
    const gatewayState = createGatewayState();
    const restoreWebSocket = installOpenWebSocket(gatewayState);
    const seen: string[] = [];

    t.after(() => {
      restoreWebSocket();
      relayauthApp.close();
    });

    const handle = agent({
      workspace: "support",
      inbox: ["#support-agents"],
      async onEvent(_ctx, event) {
        if (event.type === "relaycast.message") {
          seen.push(event.messageId);
        }
      },
      options: {
        apiKey: workspaceToken,
        gatewayUrl: "ws://gateway.test/v1/agent-events",
        handleSignals: false,
      },
    });

    await handle.ready;
    emitGatewayEvent("support", {
      id: "relaycast:support:support-agents:msg-1",
      workspace: "support",
      type: "relaycast.message",
      occurredAt: "2026-05-12T00:00:00.000Z",
      channel: "support-agents",
      messageId: "msg-1",
      attempt: 1,
    });
    emitGatewayEvent("support", {
      id: "relaycast:support:support-agents:msg-2",
      workspace: "support",
      type: "relaycast.message",
      occurredAt: "2026-05-12T00:00:01.000Z",
      channel: "support-agents",
      messageId: "msg-2",
      attempt: 1,
    });

    await waitFor(() => seen.length === 2);
    assert.deepEqual(seen, ["msg-1", "msg-2"]);

    await handle.stop();
  },
);

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
