import { DurableObject } from "cloudflare:workers";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  FeatureNotImplementedError,
  type StructuredLogEntry,
} from "@agent-relay/events";
import { minimatch } from "minimatch";

import { EventCoalescer } from "./coalesce.js";
import { markEventSeen } from "./dedup.js";
import {
  buildRelayfileChangedEnvelope,
  buildRelaycastMessageEnvelope,
  buildStartupEnvelope,
  type AgentEvent,
  type RelaycastMessageEvent,
} from "./envelope-builder.js";
import { buildDlqPath, writeGatewayDlqRecord } from "./dlq.js";
import { expandGatewayEvent, type GatewayExpandLevel, type GatewayExpandResult } from "./expand.js";
import {
  WorkspaceInboxSubscriber,
  createDefaultRelaycastInboxClient,
  type RelaycastInboxClientFactory,
  type RelaycastInboxDeliveryAccepted,
  type RelaycastInboxMessageEvent,
  type RelaycastInboxRegistration,
} from "./inbox-subscriber.js";
import { AgentClient, HttpClient } from "@relaycast/sdk";
import {
  introspectToken,
  issueAgentToken,
  introspectWorkspaceToken,
  refreshAgentToken,
  type RelayAuthEnv,
  type RelayAuthTokenClaims,
} from "./relayauth-client.js";
import {
  parseReplayOnStart,
  readReplayEvents,
  type ReplayOnStart,
} from "./replay.js";
import {
  cancelCronSchedule,
  normalizeScheduleSpec,
  registerCronSchedules,
  type RegisteredCronSchedule,
  type RelaycronEnv,
  type ScheduleSpec,
} from "./relaycron-client.js";
import {
  computeRetryDelayMs,
  DEFAULT_RETRY_POLICY,
} from "./retry.js";
import {
  buildMetricsSnapshot,
  ensureMetricsState,
  type WorkspaceMetricsState,
  recordCostMetric,
  recordDropMetric,
  recordDurationMetric,
  recordReceivedMetric,
  recordRetryMetric,
} from "./metrics.js";
import { buildResourceSummary } from "./summary-builder.js";
import {
  claimVfsWatchDelivery,
  onVfsWatchEvent,
  releaseVfsWatchDelivery,
  shouldSuppressRelayfileWatchDelivery,
  vfsWatchDedupeKey,
  WorkspaceWatchSubscriber,
  type RelayfileWatchEvent,
  type VfsWatchDispatchCandidate,
  type VfsWatchEvent,
} from "./watch-subscriber.js";
import {
  extractTraceContextFromCarrier,
  extractTraceContextFromHeaders,
  injectTraceContextIntoCarrier,
  recordSpanError,
  withGatewaySpan,
} from "./otel.js";
import {
  RelayFileApiError,
  RelayFileClient,
  type FilesystemEvent,
} from "@relayfile/sdk";

function isRelayFileApiError(error: unknown): error is RelayFileApiError {
  return (
    error instanceof RelayFileApiError
    || (
      error instanceof Error
      && error.name === "RelayFileApiError"
      && typeof (error as { status?: unknown }).status === "number"
      && typeof (error as { code?: unknown }).code === "string"
    )
  );
}

type GatewayBindings = RelayAuthEnv &
  RelaycronEnv & {
    WORKSPACE_GATEWAY_DO: DurableObjectNamespace;
    CLOUD_WEB_WORKER?: {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
    PROACTIVE_RUNTIME_WORKER?: {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
    RELAYFILE_URL?: string;
    RELAYCAST_URL?: string;
    CLOUD_WEB_BASE_URL?: string;
    NANGO_BASE_URL?: string;
    NANGO_SECRET_KEY?: string;
  };

type MessageRpcOptions = {
  idempotencyKey?: string;
};

type WatchRegistration = {
  glob: string;
  replayOnStart: ReplayOnStart;
  coalesceMs: number;
  maxBacklog?: number;
  handlerTimeoutMs?: number;
};

type InboxRegistration = {
  selector: string;
};

type InboxDeploymentCandidate = {
  agentId: string;
  deployedName?: string | null;
  inboxSelectors?: string[];
};

type AgentRecord = {
  agentId: string;
  agentName: string;
  workspace: string;
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  lastTokenCheckAt?: string;
  schedules: RegisteredCronSchedule[];
  watches?: WatchRegistration[];
  inbox?: InboxRegistration[];
  maxBacklog?: number;
  handlerTimeoutMs?: number;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
};

type DeliveryRecord = {
  id: string;
  eventId: string;
  event: AgentEvent;
  attempt: number;
  dueAt: string;
  inflight: boolean;
  inflightAt?: string;
  enqueuedAt: string;
  lastError?: string;
};

type WorkspaceState = {
  workspace?: string;
  agents: Record<string, AgentRecord>;
  queues: Record<string, DeliveryRecord[]>;
  metrics?: WorkspaceMetricsState;
};

type PendingApprovalWaiter = {
  agentId: string;
  requestId: string;
  socket: WebSocket;
};

type ClientMessage =
  | { type: "ping" }
  | { type: "pong" }
  | {
      type: "subscribe";
      workspace?: string;
      agentId?: string;
      apiKey?: string;
    }
  | {
      type: "register";
      schedule?: ScheduleSpec | ScheduleSpec[];
      watch?: unknown;
      inbox?: unknown;
    }
  | { type: "once"; requestId?: string; key?: string }
  | { type: "once_release"; key?: string }
  | { type: "unregister"; scheduleIds?: string[] }
  | { type: "ack"; eventId: string }
  | { type: "nack"; eventId: string; error?: string; noRetry?: boolean }
  | {
      type: "expand";
      requestId?: string;
      eventId: string;
      level?: GatewayExpandLevel;
      params?: {
        cursor?: string;
        limit?: number;
      };
    }
  | { type: "files_read"; requestId?: string; path?: string }
  | {
      type: "files_write";
      requestId?: string;
      path?: string;
      body?: unknown;
      meta?: Record<string, unknown>;
    }
  | { type: "files_delete"; requestId?: string; path?: string; baseRevision?: string }
  | { type: "files_list"; requestId?: string; glob?: string }
  | {
      type: "messages_post";
      requestId?: string;
      channel?: string;
      text?: string;
      opts?: MessageRpcOptions;
    }
  | {
      type: "messages_reply";
      requestId?: string;
      threadId?: string;
      text?: string;
      opts?: MessageRpcOptions;
    }
  | {
      type: "messages_dm";
      requestId?: string;
      agentOrUser?: string;
      text?: string;
      opts?: MessageRpcOptions;
    }
  | { type: "log"; entry?: StructuredLogEntry | null }
  | { type: "approval_wait"; requestId?: string; approvalId?: string }
  | { type: "refresh_agent_token" };

type SocketAttachment = {
  workspace?: string;
  agentId?: string;
  agentName?: string;
  authenticated?: boolean;
  legacyProtocol?: boolean;
  role?: "agent" | "observer";
};

type AgentActivityRecord = {
  id: string;
  kind:
    | "session.connected"
    | "session.disconnected"
    | "agent.registered"
    | "agent.unregistered"
    | "event.enqueued"
    | "event.acknowledged"
    | "event.retried"
    | "event.failed"
    | "log";
  occurredAt: string;
  eventId?: string;
  eventType?: string;
  level?: string;
  message?: string;
  attempt?: number;
  queueDepth?: number;
  detail?: Record<string, unknown>;
};

type AgentInspectorSummary = {
  agentId: string;
  agentName: string;
  workspace: string;
  status: "online" | "offline";
  queueDepth: number;
  scheduleCount: number;
  watchCount: number;
  inboxCount: number;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  deployStartedAt: string | null;
  lastEvent: string | null;
  lastEventAt: string;
  lastError: string | null;
};

const STATE_KEY = "workspace-state";
const SOCKET_TAG = "agent-gateway";
const MAX_BACKLOG = 1_000;
const HANDLER_TIMEOUT_MS = 5 * 60_000;
const DLQ_PREFIX = "dlq:/_dlq/";
const ONCE_PREFIX = "once:";
const ONCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EXPANSION_CACHE_ENTRIES = 256;
const DEFAULT_WATCH_COALESCE_MS = 200;
const DEFAULT_RELAYCAST_URL = "https://cast.agentrelay.com";
const RELAYCAST_DELIVERY_ID_TTL_MS = 30 * 60_000;
const MAX_RELAYCAST_DELIVERY_IDS = 2_000;
const RELAYCAST_DELIVERY_FEED_LIMIT = 200;
const APPROVAL_GLOB = "/approvals/*.json";
const AGENT_TOKEN_TTL_MS = 60 * 60 * 1_000;
const AGENT_TOKEN_REFRESH_WINDOW_MS = Math.floor(AGENT_TOKEN_TTL_MS * 0.2);
const TOKEN_MAINTENANCE_INTERVAL_MS = 5_000;
const RELAYAUTH_TOKEN_READ_SCOPE = "relayauth:token:read:*";

export class WorkspaceGatewayDO extends DurableObject<GatewayBindings> {
  private relayfileClient: RelayFileClient | null = null;
  private watchSubscriber: WorkspaceWatchSubscriber | null = null;
  private inboxSubscriber: WorkspaceInboxSubscriber | null = null;
  private readonly watchCoalescer = new EventCoalescer();
  private readonly expansionCache = new Map<string, Promise<GatewayExpandResult>>();
  private readonly pendingApprovals = new Map<string, PendingApprovalWaiter[]>();
  private relaycastClientFactory: RelaycastInboxClientFactory | null = null;
  /**
   * Correlates relaycast `delivery.accepted` events to envelope acks/nacks:
   * `${agentId}:${messageId}` -> engine delivery id. In-memory with a bounded
   * size and TTL; misses (DO restart, channel recipients without their own
   * realtime connection) fall back to the engine's durable deliveries feed.
   */
  private readonly relaycastDeliveryIds = new Map<
    string,
    { deliveryId: string; expiresAt: number }
  >();

  constructor(ctx: DurableObjectState, env: GatewayBindings) {
    super(ctx, env);
    this.installWebSocketAutoResponse();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/ws") {
      return this.handleWebSocketUpgrade(request);
    }

    if (request.method === "GET" && url.pathname === "/poll") {
      return this.handleLongPoll(request);
    }

    if (request.method === "GET" && url.pathname === "/agents") {
      return this.handleAgentsRequest(request);
    }

    const agentMatch = matchInspectorAgentPath(url.pathname);
    if (request.method === "GET" && agentMatch) {
      if (agentMatch.events) {
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
          return this.handleAgentEventsObserverUpgrade(request, agentMatch.agentId);
        }
        return this.handleAgentEventsRequest(request, agentMatch.agentId);
      }
      return this.handleAgentDetailRequest(request, agentMatch.agentId);
    }

    if (request.method === "POST" && url.pathname === "/internal/enqueue") {
      return this.handleInternalEnqueue(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/vfs-watch") {
      return this.handleVfsWatchDispatch(request);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/internal/vfs-dedupe/check" ||
        url.pathname === "/internal/vfs-dedupe/record" ||
        url.pathname === "/internal/vfs-dedupe/claim" ||
        url.pathname === "/internal/vfs-dedupe/release")
    ) {
      return this.handleVfsDedupeBroker(request, url.pathname);
    }

    if (request.method === "GET" && url.pathname === "/metrics") {
      return this.handleMetricsRequest(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/cost") {
      return this.handleInternalCostIngest(request);
    }

    return jsonResponse(
      {
        ok: false,
        error: {
          code: "not_found",
          message: "route not found",
        },
      },
      { status: 404 },
    );
  }

  async alarm(): Promise<void> {
    await this.runTokenMaintenance();
    await this.drainDeliveries();
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      return;
    }
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      this.sendError(ws, "parse_error", "Invalid message payload");
      return;
    }

    const attachment = readSocketAttachment(ws);
    if (
      attachment?.role === "observer"
      && parsed.type !== "ping"
      && parsed.type !== "pong"
    ) {
      this.sendError(
        ws,
        "observer_read_only",
        "observer sockets cannot send agent control messages",
      );
      return;
    }

    const agentId = attachment?.agentId;

    try {
      switch (parsed.type) {
        case "ping":
          this.sendToSocket(ws, { type: "pong" });
          return;
        case "pong":
          return;
        case "subscribe":
          await this.handleSubscribe(ws, parsed);
          return;
        case "register":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before registering schedules",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleRegister(agentId, ws, parsed);
          });
          return;
        case "once":
          if (!agentId) {
            this.sendError(ws, "unauthorized", "authenticate before using ctx.once()");
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleOnce(agentId, ws, parsed.key, parsed.requestId);
          });
          return;
        case "once_release":
          if (!agentId) {
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleOnceRelease(agentId, parsed.key);
          });
          return;
        case "unregister":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before unregistering schedules",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleUnregister(agentId, ws, parsed.scheduleIds ?? []);
          });
          return;
        case "ack":
          if (!agentId) {
            return;
          }
          await this.handleAck(agentId, parsed.eventId);
          return;
        case "nack":
          if (!agentId) {
            return;
          }
          await this.handleNack(
            agentId,
            parsed.eventId,
            parsed.error,
            parsed.noRetry === true,
          );
          return;
        case "expand":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before expanding event payloads",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleExpand(agentId, ws, parsed);
          });
          return;
        case "files_read":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before reading workspace files",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleFilesRead(agentId, ws, parsed);
          });
          return;
        case "files_write":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before writing workspace files",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleFilesWrite(agentId, ws, parsed);
          });
          return;
        case "files_delete":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before deleting workspace files",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleFilesDelete(agentId, ws, parsed);
          });
          return;
        case "files_list":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before listing workspace files",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleFilesList(agentId, ws, parsed);
          });
          return;
        case "messages_post":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before posting workspace messages",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleMessagesPost(agentId, ws, parsed);
          });
          return;
        case "messages_reply":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before replying to workspace messages",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleMessagesReply(agentId, ws, parsed);
          });
          return;
        case "messages_dm":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before sending workspace DMs",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleMessagesDm(agentId, ws, parsed);
          });
          return;
        case "log":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before emitting structured logs",
            );
            return;
          }
          await this.handleStructuredLog(agentId, parsed.entry);
          return;
        case "approval_wait":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before waiting on approvals",
            );
            return;
          }
          await this.withClientMessageSpan(agentId, parsed, async () => {
            await this.handleApprovalWait(agentId, ws, parsed);
          });
          return;
        case "refresh_agent_token":
          if (!agentId) {
            this.sendError(
              ws,
              "unauthorized",
              "authenticate before refreshing the agent token",
            );
            return;
          }
          await this.handleRefreshAgentToken(agentId, ws);
          return;
        default:
          this.sendError(
            ws,
            "unsupported_message_type",
            "Unsupported message type",
          );
      }
    } catch (error) {
      this.sendError(
        ws,
        "internal_error",
        error instanceof Error ? error.message : "internal error",
      );
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleSocketDisconnect(ws, "socket closed");
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleSocketDisconnect(ws, "socket error");
  }

  private async withClientMessageSpan<T>(
    agentId: string | undefined,
    message: ClientMessage,
    fn: () => Promise<T>,
  ): Promise<T> {
    const record = message as Record<string, unknown>;
    return await withGatewaySpan(
      `agent.gateway.ws.${message.type}`,
      {
        kind: SpanKind.SERVER,
        context: extractTraceContextFromCarrier(record),
        attributes: {
          "relay.message_type": message.type,
          ...(agentId ? { "relay.agent_id": agentId } : {}),
          ...(typeof record.requestId === "string" && record.requestId.trim()
            ? { "relay.request_id": record.requestId.trim() }
            : {}),
        },
      },
      fn,
    );
  }

  private completeDeliverySpan(
    agentId: string,
    entry: DeliveryRecord | undefined,
    status: "ok" | "error",
    message?: string,
  ): void {
    if (!entry?.inflightAt) {
      return;
    }

    const startedAtMs = Date.parse(entry.inflightAt);
    if (!Number.isFinite(startedAtMs)) {
      return;
    }

    const span = trace.getTracer("agent-gateway").startSpan(
      "agent.gateway.event.delivery",
      {
        kind: SpanKind.PRODUCER,
        startTime: startedAtMs,
        attributes: {
          "relay.agent_id": agentId,
          "relay.workspace": entry.event.workspace,
          "relay.event_type": entry.event.type,
          "relay.event_id": entry.event.id,
        },
      },
      extractTraceContextFromCarrier(
        entry.event as unknown as Record<string, unknown>,
      ),
    );

    if (status === "error") {
      recordSpanError(span, message ?? "delivery failed");
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const workspace = readRequiredHeader(
      request,
      "x-agent-gateway-workspace",
    );
    const requestedAgentId = request.headers.get("x-agent-gateway-agent-id")?.trim()
      || undefined;
    const agentName =
      request.headers.get("x-agent-gateway-agent-name")?.trim() || requestedAgentId;
    const refreshToken =
      request.headers.get("x-agent-gateway-refresh-token")?.trim() || undefined;
    const accessTokenExpiresAt =
      request.headers.get("x-agent-gateway-access-token-expires-at")?.trim()
      || undefined;
    const refreshTokenExpiresAt =
      request.headers.get("x-agent-gateway-refresh-token-expires-at")?.trim()
      || undefined;
    const accessToken =
      request.headers.get("x-agent-gateway-agent-token")?.trim() || undefined;
    const legacyProtocol =
      request.headers.get("x-agent-gateway-legacy-protocol")?.trim() === "1";

    if (!workspace) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "bad_request",
            message: "Missing workspace binding for gateway websocket",
          },
        },
        { status: 400 },
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(
      server,
      requestedAgentId ? [SOCKET_TAG, `agent:${requestedAgentId}`] : [SOCKET_TAG],
    );
    server.serializeAttachment?.({
      workspace,
      agentId: requestedAgentId,
      agentName,
      authenticated: Boolean(accessToken && requestedAgentId),
      legacyProtocol,
      role: "agent",
    } satisfies SocketAttachment);

    if (accessToken && requestedAgentId) {
      const startupReason = await this.resolveStartupReason(requestedAgentId);
      await this.persistAuthenticatedSession({
        workspace,
        agentId: requestedAgentId,
        agentName: agentName ?? requestedAgentId,
        accessToken,
        refreshToken,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
      });
      this.sendConnected(server);
      if (!legacyProtocol) {
        this.sendAuthOk(server, {
          workspace,
          agentId: requestedAgentId,
          agentToken: accessToken,
          agentTokenExpiresAt: accessTokenExpiresAt,
        });
      }
      await this.enqueueStartupEvent(requestedAgentId, workspace, startupReason);
      await this.ensureWatchSubscription();
      await this.replayRegisteredWatchEvents(requestedAgentId);
    }

    await this.drainDeliveries();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleSubscribe(
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "subscribe" }>,
  ): Promise<void> {
    const existing = readSocketAttachment(ws);
    if (existing?.authenticated && existing.agentId) {
      this.sendConnected(ws);
      if (existing.legacyProtocol !== true) {
        this.sendToSocket(ws, {
          type: "subscribed",
          workspace: existing.workspace,
          agentId: existing.agentId,
        });
      }
      return;
    }

    const workspaceToken =
      typeof message.apiKey === "string" ? message.apiKey.trim() : "";
    if (!workspaceToken) {
      this.sendError(
        ws,
        "missing_authorization",
        "subscribe requires an apiKey workspace token",
      );
      return;
    }

    const claims = await introspectWorkspaceToken(this.env, workspaceToken);
    if (!claims || claims.token_type === "refresh") {
      this.sendError(ws, "invalid_token", "Workspace token is invalid");
      return;
    }

    const workspace = resolveSubscribedWorkspace(message, existing, claims);
    await this.assertWorkspaceBinding(workspace);
    const requestedAgentId =
      typeof message.agentId === "string" && message.agentId.trim()
        ? message.agentId.trim()
        : existing?.agentId;
    const agentId = sanitizeAgentId(requestedAgentId || `agent-${claims.sub}`);
    const agentName = existing?.agentName?.trim() || agentId;
    const startupReason = await this.resolveStartupReason(agentId);
    const issuedAgentToken = await issueAgentToken(this.env, {
      workspaceToken,
      workspaceClaims: claims,
      agentId,
      agentName,
      audience: [
        this.env.RELAY_AGENT_AUDIENCE?.trim() || "agent-gateway",
        "relayfile",
      ],
    });

    ws.serializeAttachment?.({
      workspace,
      agentId,
      agentName,
      authenticated: true,
      legacyProtocol: existing?.legacyProtocol === true,
      role: "agent",
    } satisfies SocketAttachment);

    await this.persistAuthenticatedSession({
      workspace,
      agentId,
      agentName,
      accessToken: issuedAgentToken.accessToken,
      refreshToken: issuedAgentToken.refreshToken,
      accessTokenExpiresAt: issuedAgentToken.accessTokenExpiresAt,
      refreshTokenExpiresAt: issuedAgentToken.refreshTokenExpiresAt,
    });

    this.sendConnected(ws);
    if (existing?.legacyProtocol !== true) {
      this.sendAuthOk(ws, {
        workspace,
        agentId,
        agentToken: issuedAgentToken.accessToken,
        agentTokenExpiresAt: issuedAgentToken.accessTokenExpiresAt,
      });
      this.sendToSocket(ws, {
        type: "subscribed",
        workspace,
        agentId,
      });
    }
    await this.enqueueStartupEvent(agentId, workspace, startupReason);
    await this.ensureWatchSubscription();
    await this.replayRegisteredWatchEvents(agentId);
    await this.drainDeliveries();
  }

  private async handleLongPoll(request: Request): Promise<Response> {
    const workspace = readRequiredHeader(request, "x-agent-gateway-workspace");
    const agentId = readRequiredHeader(request, "x-agent-gateway-agent-id");
    if (!workspace || !agentId) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "bad_request",
            message: "workspace and agentId are required for long-poll delivery",
          },
        },
        { status: 400 },
      );
    }

    const startupReason = await this.resolveStartupReason(agentId);
    await this.persistAuthenticatedSession({
      workspace,
      agentId,
      agentName: request.headers.get("x-agent-gateway-agent-name")?.trim() || agentId,
    });
    await this.enqueueStartupEvent(agentId, workspace, startupReason);
    await this.replayRegisteredWatchEvents(agentId);

    const state = await this.loadState();
    const queue = state.queues[agentId] ?? [];
    const nowMs = Date.now();
    const ready = queue.filter((entry) => {
      const dueMs = Date.parse(entry.dueAt);
      return !entry.inflight && (!Number.isFinite(dueMs) || dueMs <= nowMs);
    });

    state.queues[agentId] = queue.filter((entry) => !ready.includes(entry));
    if (ready.length > 0) {
      await this.saveState(state);
    }

    return jsonResponse({
      ok: true,
      data: {
        events: ready.map((entry) => entry.event),
      },
    });
  }

  private async handleAgentsRequest(request: Request): Promise<Response> {
    const workspace = readRequiredHeader(request, "x-agent-gateway-workspace");
    const state = await this.loadState();
    this.assertStateWorkspace(state, workspace);
    return jsonResponse({
      ok: true,
      data: {
        agents: Object.values(state.agents)
          .map((agent) => this.buildAgentSummary(state, agent))
          .sort((left, right) => left.agentId.localeCompare(right.agentId)),
      },
    });
  }

  private async handleAgentDetailRequest(
    request: Request,
    agentId: string,
  ): Promise<Response> {
    const workspace = readRequiredHeader(request, "x-agent-gateway-workspace");
    const state = await this.loadState();
    this.assertStateWorkspace(state, workspace);
    const agent = state.agents[agentId];
    if (!agent) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "not_found",
            message: `agent ${agentId} not found`,
          },
        },
        { status: 404 },
      );
    }

    return jsonResponse({
      ok: true,
      data: {
        agent: {
          ...this.buildAgentSummary(state, agent),
          schedules: agent.schedules,
          watches: agent.watches ?? [],
          inbox: agent.inbox ?? [],
          policy: {
            maxBacklog: agent.maxBacklog ?? MAX_BACKLOG,
            handlerTimeoutMs: agent.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS,
          },
          recentEvents: this.buildAgentActivity(state, agentId),
        },
      },
    });
  }

  private async handleAgentEventsRequest(
    request: Request,
    agentId: string,
  ): Promise<Response> {
    const workspace = readRequiredHeader(request, "x-agent-gateway-workspace");
    const state = await this.loadState();
    this.assertStateWorkspace(state, workspace);
    if (!state.agents[agentId]) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "not_found",
            message: `agent ${agentId} not found`,
          },
        },
        { status: 404 },
      );
    }

    return jsonResponse({
      ok: true,
      data: {
        events: this.buildAgentActivity(state, agentId),
      },
    });
  }

  private async handleAgentEventsObserverUpgrade(
    request: Request,
    agentId: string,
  ): Promise<Response> {
    const workspace = readRequiredHeader(request, "x-agent-gateway-workspace");
    const state = await this.loadState();
    this.assertStateWorkspace(state, workspace);
    if (!state.agents[agentId]) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "not_found",
            message: `agent ${agentId} not found`,
          },
        },
        { status: 404 },
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [SOCKET_TAG, `observer:${agentId}`]);
    server.serializeAttachment?.({
      workspace,
      agentId,
      authenticated: true,
      role: "observer",
    } satisfies SocketAttachment);
    this.sendToSocket(server, {
      type: "snapshot",
      events: this.buildAgentActivity(state, agentId),
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleInternalEnqueue(request: Request): Promise<Response> {
    return await withGatewaySpan(
      "agent.gateway.internal.enqueue",
      {
        kind: SpanKind.SERVER,
        context: extractTraceContextFromHeaders(request.headers),
        attributes: {
          "relay.route": "/internal/enqueue",
        },
      },
      async () => {
        const body = (await request.json().catch(() => null)) as
          | {
              agentId?: unknown;
              event?: unknown;
            }
          | null;

        const agentId =
          typeof body?.agentId === "string" ? body.agentId.trim() : "";
        const event = isAgentEvent(body?.event) ? body.event : null;
        if (!agentId || !event) {
          return jsonResponse(
            {
              ok: false,
              error: {
                code: "bad_request",
                message: "agentId and event are required",
              },
            },
            { status: 400 },
          );
        }

        await this.assertWorkspaceBinding(event.workspace);
        const accepted = await this.enqueueEvent(agentId, event);
        return jsonResponse({
          ok: true,
          data: {
            accepted,
            eventId: event.id,
          },
        });
      },
    );
  }

  private async handleVfsWatchDispatch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as Partial<VfsWatchEvent> | null;
    const event = normalizeVfsWatchEvent(body);
    if (!event) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "bad_request",
            message: "workspaceId, path, writeId, and occurredAt are required",
          },
        },
        { status: 400 },
      );
    }

    await this.assertWorkspaceBinding(event.workspaceId);
    const result = await onVfsWatchEvent(event, {
      storage: this.ctx.storage,
      readCandidateAgents: async () => this.readVfsWatchCandidateAgents(event.workspaceId),
      deliver: async (candidate, payload) => {
        return this.deliverVfsWatchDeploymentTrigger(event.workspaceId, candidate.agentId, {
          id: payload.eventId,
          type: `integration.${payload.provider ?? "relayfile"}.${event.eventType ?? payload.type}`,
          eventType: event.eventType ?? payload.type,
          provider: payload.provider,
          workspaceId: event.workspaceId,
          deliveryId: event.writeId,
          occurredAt: payload.timestamp,
          paths: [payload.path],
          resource: event.payload ?? {
            path: payload.path,
            provider: payload.provider,
            revision: payload.revision,
            digest: payload.digest,
            contentHash: payload.contentHash,
            summary: payload.summary,
          },
        });
      },
      log: (entry) => {
        console.log(JSON.stringify(entry));
      },
    });

    return jsonResponse({ ok: true, data: result });
  }

  private async readVfsWatchCandidateAgents(
    workspaceId: string,
  ): Promise<VfsWatchDispatchCandidate[]> {
    const response = await this.fetchProactiveRuntimeInternal("/api/internal/proactive-runtime/vfs-watch/candidates", {
      workspaceId,
    });
    if (!response.ok) {
      throw new Error(`Cloud Web candidate read failed with ${response.status}`);
    }
    const payload = await response.json().catch(() => null) as
      | { ok?: boolean; data?: { agents?: unknown } }
      | null;
    if (!payload?.ok || !Array.isArray(payload.data?.agents)) {
      throw new Error("Cloud Web candidate read returned an invalid response");
    }
    return payload.data.agents as VfsWatchDispatchCandidate[];
  }

  private async deliverVfsWatchDeploymentTrigger(
    workspaceId: string,
    agentId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchProactiveRuntimeInternal("/api/internal/proactive-runtime/vfs-watch/deliver", {
      workspaceId,
      agentId,
      payload,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Cloud Web deployment trigger delivery failed with ${response.status}${text ? `: ${text}` : ""}`);
    }
    return response.json().catch(() => null);
  }

  private async readInboxDeploymentCandidates(
    workspaceId: string,
    selector: string,
  ): Promise<InboxDeploymentCandidate[]> {
    const response = await this.fetchProactiveRuntimeInternal("/api/internal/proactive-runtime/inbox/candidates", {
      workspaceId,
      selector,
    });
    if (!response.ok) {
      throw new Error(`Cloud Web inbox candidate read failed with ${response.status}`);
    }
    const payload = await response.json().catch(() => null) as
      | { ok?: boolean; data?: { agents?: unknown } }
      | null;
    if (!payload?.ok || !Array.isArray(payload.data?.agents)) {
      throw new Error("Cloud Web inbox candidate read returned an invalid response");
    }
    return payload.data.agents as InboxDeploymentCandidate[];
  }

  private async deliverInboxDeploymentTrigger(
    workspaceId: string,
    agentId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchProactiveRuntimeInternal("/api/internal/proactive-runtime/inbox/deliver", {
      workspaceId,
      agentId,
      deliveryId: payload.deliveryId,
      payload,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Cloud Web inbox deployment delivery failed with ${response.status}${text ? `: ${text}` : ""}`);
    }
    return response.json().catch(() => null);
  }

  private async fetchCloudWebInternal(path: string, body: unknown): Promise<Response> {
    const secret = this.env.AGENT_GATEWAY_INTERNAL_SECRET?.trim();
    if (!secret) {
      throw new Error("AGENT_GATEWAY_INTERNAL_SECRET is not configured");
    }
    const headers = injectTraceContextIntoCarrier({
      "content-type": "application/json",
      "x-agent-gateway-secret": secret,
    });
    const requestInit: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    };
    const request = new Request(`https://cloud-web.internal${path}`, requestInit);
    if (this.env.CLOUD_WEB_WORKER?.fetch) {
      return this.env.CLOUD_WEB_WORKER.fetch(request);
    }
    const baseUrl = this.env.CLOUD_WEB_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error("CLOUD_WEB_WORKER service binding is not configured");
    }
    return fetch(`${baseUrl.replace(/\/+$/u, "")}${path}`, requestInit);
  }

  private async fetchProactiveRuntimeInternal(path: string, body: unknown): Promise<Response> {
    const secret = this.env.AGENT_GATEWAY_INTERNAL_SECRET?.trim();
    if (!secret) {
      throw new Error("AGENT_GATEWAY_INTERNAL_SECRET is not configured");
    }
    const headers = injectTraceContextIntoCarrier({
      "content-type": "application/json",
      "x-agent-gateway-secret": secret,
    });
    const requestInit: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    };
    const request = new Request(`https://proactive-runtime.internal${path}`, requestInit);
    if (this.env.PROACTIVE_RUNTIME_WORKER?.fetch) {
      return this.env.PROACTIVE_RUNTIME_WORKER.fetch(request);
    }
    return this.fetchCloudWebInternal(path, body);
  }

  private async handleVfsDedupeBroker(
    request: Request,
    pathname: string,
  ): Promise<Response> {
    const body = (await request.json().catch(() => null)) as
      | { workspaceId?: unknown; agentId?: unknown; writeId?: unknown }
      | null;
    const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
    const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
    const writeId = typeof body?.writeId === "string" ? body.writeId.trim() : "";
    if (!workspaceId || !agentId || !writeId) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "bad_request",
            message: "workspaceId, agentId, and writeId are required",
          },
        },
        { status: 400 },
      );
    }

    await this.assertWorkspaceBinding(workspaceId);
    if (pathname.endsWith("/release")) {
      await releaseVfsWatchDelivery(this.ctx.storage, workspaceId, agentId, writeId);
      return jsonResponse({
        ok: true,
        data: {
          dedupe: "released",
        },
      });
    }

    if (pathname.endsWith("/check")) {
      const existing = await this.ctx.storage.get<{ expiresAt?: number }>(
        vfsWatchDedupeKey(workspaceId, agentId, writeId),
      );
      return jsonResponse({
        ok: true,
        data: {
          dedupe:
            existing && typeof existing.expiresAt === "number" && existing.expiresAt > Date.now()
              ? "skipped"
              : "first",
        },
      });
    }

    const claim = await claimVfsWatchDelivery(
      this.ctx.storage,
      workspaceId,
      agentId,
      writeId,
    );

    return jsonResponse({
      ok: true,
      data: {
        dedupe: claim === "claimed" ? "first" : "skipped",
      },
    });
  }

  private async handleRegister(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "register" }>,
  ): Promise<void> {
    const rawSchedules = normalizeScheduleArray(message.schedule);
    const scheduleProvided = message.schedule !== undefined;
    const watchProvided = message.watch !== undefined;
    const inboxProvided = message.inbox !== undefined;
    const requestedWatches = normalizeWatchRegistrations(message.watch);
    const requestedInbox = normalizeInboxRegistrations(message.inbox);
    if (!scheduleProvided && !watchProvided && !inboxProvided) {
      this.sendError(ws, "bad_request", "schedule, watch, or inbox is required");
      return;
    }

    const state = await this.loadState();
    this.assertStateWorkspace(state, state.agents[agentId]?.workspace);
    const agent = state.agents[agentId];
    if (!agent) {
      throw new Error(`agent ${agentId} is not registered`);
    }

    let schedules: RegisteredCronSchedule[] = [];
    let createdSchedulesToRollback: RegisteredCronSchedule[] = [];
    if (scheduleProvided) {
      const requestedSchedules: Array<{
        input: ScheduleSpec;
        normalized: ReturnType<typeof normalizeScheduleSpec>;
      }> = [];
      const requestedFingerprints = new Set<string>();
      for (const schedule of rawSchedules) {
        const normalized = normalizeScheduleSpec(schedule);
        const fingerprint = scheduleFingerprint(normalized);
        if (requestedFingerprints.has(fingerprint)) {
          continue;
        }
        requestedFingerprints.add(fingerprint);
        requestedSchedules.push({ input: schedule, normalized });
      }

      const existingByFingerprint = new Map<string, RegisteredCronSchedule>();
      for (const schedule of agent.schedules) {
        const fingerprint = scheduleFingerprint(schedule);
        if (!existingByFingerprint.has(fingerprint)) {
          existingByFingerprint.set(fingerprint, schedule);
        }
      }
      const schedulesToCreate = requestedSchedules.filter(
        ({ normalized }) => !existingByFingerprint.has(scheduleFingerprint(normalized)),
      );

      try {
        const created = schedulesToCreate.length > 0
          ? await registerCronSchedules(this.env, {
              workspace: agent.workspace,
              agentId,
              schedules: schedulesToCreate.map(({ input }) => input),
            })
          : [];
        createdSchedulesToRollback = created;

        for (const schedule of created) {
          existingByFingerprint.set(scheduleFingerprint(schedule), schedule);
        }

        schedules = requestedSchedules
          .map(({ normalized }) => existingByFingerprint.get(scheduleFingerprint(normalized)))
          .filter((schedule): schedule is RegisteredCronSchedule => Boolean(schedule));

        const retainedGatewayScheduleIds = new Set(
          schedules.map((schedule) => schedule.gatewayScheduleId),
        );
        const schedulesToCancel = agent.schedules.filter(
          (schedule) => !retainedGatewayScheduleIds.has(schedule.gatewayScheduleId),
        );

        for (const schedule of schedulesToCancel) {
          await cancelCronSchedule(this.env, schedule.relaycronScheduleId);
        }
      } catch (error) {
        await cancelRegisteredCronSchedulesBestEffort(this.env, createdSchedulesToRollback);
        throw error;
      }

      agent.schedules = dedupeRegisteredSchedules(schedules);
    }

    if (watchProvided) {
      agent.watches = requestedWatches;
      agent.maxBacklog = requestedWatches.find((watch) => watch.maxBacklog !== undefined)?.maxBacklog;
      agent.handlerTimeoutMs =
        requestedWatches.find((watch) => watch.handlerTimeoutMs !== undefined)?.handlerTimeoutMs;
    }
    if (inboxProvided) {
      agent.inbox = requestedInbox;
    }
    state.agents[agentId] = agent;
    try {
      await this.saveState(state);
    } catch (error) {
      await cancelRegisteredCronSchedulesBestEffort(this.env, createdSchedulesToRollback);
      throw error;
    }
    await this.ensureWatchSubscription(state);
    await this.ensureInboxSubscription(state);
    if (watchProvided && requestedWatches.length > 0) {
      await this.replayRegisteredWatchEvents(agentId, state, requestedWatches);
    }

    this.sendToSocket(ws, {
      type: "registered",
      schedules,
      watches: agent.watches ?? [],
      inbox: agent.inbox ?? [],
    });
  }

  private async handleUnregister(
    agentId: string,
    ws: WebSocket,
    scheduleIds: string[],
  ): Promise<void> {
    const state = await this.loadState();
    const agent = state.agents[agentId];
    if (!agent) {
      throw new Error(`agent ${agentId} is not registered`);
    }

    const normalizedIds = scheduleIds.map((value) => value.trim()).filter(Boolean);
    const targets =
      normalizedIds.length > 0
        ? agent.schedules.filter((schedule) =>
            normalizedIds.includes(schedule.gatewayScheduleId),
          )
        : [...agent.schedules];

    for (const schedule of targets) {
      await cancelCronSchedule(this.env, schedule.relaycronScheduleId);
    }

    agent.schedules = agent.schedules.filter(
      (schedule) => !targets.some((target) => target.gatewayScheduleId === schedule.gatewayScheduleId),
    );
    state.agents[agentId] = agent;
    await this.saveState(state);

    this.sendToSocket(ws, {
      type: "unregistered",
      scheduleIds: targets.map((schedule) => schedule.gatewayScheduleId),
    });
  }

  private async handleAck(agentId: string, eventId: string): Promise<void> {
    const state = await this.loadState();
    const queue = state.queues[agentId] ?? [];
    const index = queue.findIndex((entry) => entry.eventId === eventId);
    if (index < 0) {
      return;
    }

    const entry = queue[index];
    this.recordAttemptDurationMetric(state, agentId, entry);
    queue.splice(index, 1);
    this.completeDeliverySpan(agentId, entry, "ok");
    this.clearEventExpansionCache(eventId);
    state.queues[agentId] = queue;
    await this.saveState(state);
    if (entry.event.type === "relaycast.message") {
      await this.settleRelaycastDelivery(agentId, entry.event as RelaycastMessageEvent);
    }
    this.broadcastAgentActivity(agentId, {
      id: `event.acknowledged:${eventId}:${Date.now()}`,
      kind: "event.acknowledged",
      occurredAt: new Date().toISOString(),
      eventId,
      eventType: entry.event.type,
      attempt: entry.attempt,
      queueDepth: queue.length,
    });
    await this.drainDeliveries();
  }

  private async handleNack(
    agentId: string,
    eventId: string,
    errorMessage: string | undefined,
    noRetry: boolean,
  ): Promise<void> {
    const state = await this.loadState();
    const queue = state.queues[agentId] ?? [];
    const index = queue.findIndex((entry) => entry.eventId === eventId);
    if (index < 0) {
      return;
    }

    const entry = queue[index];
    this.recordAttemptDurationMetric(state, agentId, entry);
    this.completeDeliverySpan(
      agentId,
      entry,
      "error",
      errorMessage?.trim() || "handler returned nack",
    );
    if (
      noRetry ||
      entry.attempt >= DEFAULT_RETRY_POLICY.maxAttempts
    ) {
      queue.splice(index, 1);
      this.clearEventExpansionCache(eventId);
      state.queues[agentId] = queue;
      await this.saveState(state);
      await this.writeFailedEvent(agentId, entry.event, errorMessage);
      this.sendDeliveryFailed(agentId, entry.event, errorMessage ?? "delivery failed");
      if (entry.event.type === "relaycast.message") {
        await this.failRelaycastDelivery(
          agentId,
          entry.event as RelaycastMessageEvent,
          errorMessage?.trim() || "handler returned nack",
        );
      }
      this.broadcastAgentActivity(agentId, {
        id: `event.failed:${eventId}:${Date.now()}`,
        kind: "event.failed",
        occurredAt: new Date().toISOString(),
        eventId,
        eventType: entry.event.type,
        attempt: entry.attempt,
        queueDepth: queue.length,
        message: errorMessage ?? "delivery failed",
      });
      await this.drainDeliveries();
      return;
    }

    entry.attempt += 1;
    entry.event.attempt = entry.attempt;
    entry.inflight = false;
    entry.inflightAt = undefined;
    entry.lastError = errorMessage?.trim() || "handler returned nack";
    entry.dueAt = new Date(
      Date.now() + computeRetryDelayMs(entry.attempt - 1),
    ).toISOString();

    recordRetryMetric(ensureMetricsState(state), {
      agentId,
      eventType: entry.event.type,
    });
    state.queues[agentId] = queue;
    await this.saveState(state);
    this.broadcastAgentActivity(agentId, {
      id: `event.retried:${eventId}:${Date.now()}`,
      kind: "event.retried",
      occurredAt: new Date().toISOString(),
      eventId,
      eventType: entry.event.type,
      attempt: entry.attempt,
      queueDepth: queue.length,
      message: entry.lastError,
    });
    await this.scheduleNextAlarm(state);
  }

  private async handleRefreshAgentToken(
    agentId: string,
    ws: WebSocket,
  ): Promise<void> {
    const state = await this.loadState();
    const agent = state.agents[agentId];
    if (!agent?.refreshToken) {
      this.sendError(
        ws,
        "missing_refresh_token",
        "No refresh token is available for this agent session",
      );
      return;
    }

    const refreshed = await refreshAgentToken(this.env, agent.refreshToken);
    agent.accessToken = refreshed.accessToken;
    agent.refreshToken = refreshed.refreshToken;
    agent.accessTokenExpiresAt = refreshed.accessTokenExpiresAt;
    agent.refreshTokenExpiresAt = refreshed.refreshTokenExpiresAt;
    state.agents[agentId] = agent;
    await this.saveState(state);

    this.sendToSocket(ws, {
      type: "agent_token",
      agentToken: refreshed.accessToken,
      agentTokenExpiresAt: refreshed.accessTokenExpiresAt,
      refreshToken: refreshed.refreshToken,
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
      tokenType: refreshed.tokenType,
    });
  }

  private async persistAuthenticatedSession(input: {
    workspace: string;
    agentId: string;
    agentName: string;
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
  }): Promise<void> {
    const state = await this.loadState();
    this.assertStateWorkspace(state, input.workspace);
    state.workspace = input.workspace;
    const existing = state.agents[input.agentId];
    state.agents[input.agentId] = {
      ...(existing ?? {
        agentId: input.agentId,
        schedules: [],
      }),
      agentId: input.agentId,
      agentName: input.agentName,
      workspace: input.workspace,
      accessToken: input.accessToken ?? existing?.accessToken,
      refreshToken: input.refreshToken ?? existing?.refreshToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt ?? existing?.accessTokenExpiresAt,
      refreshTokenExpiresAt:
        input.refreshTokenExpiresAt ?? existing?.refreshTokenExpiresAt,
      lastConnectedAt: new Date().toISOString(),
    };
    await this.saveState(state);
    this.broadcastAgentActivity(input.agentId, {
      id: `session.connected:${input.agentId}:${state.agents[input.agentId].lastConnectedAt}`,
      kind: "session.connected",
      occurredAt: state.agents[input.agentId].lastConnectedAt ?? new Date().toISOString(),
      message: `${input.agentName} connected`,
    });
  }

  private async handleSocketDisconnect(
    ws: WebSocket,
    reason: string,
  ): Promise<void> {
    const attachment = readSocketAttachment(ws);
    if (attachment?.role === "observer") {
      return;
    }
    const agentId = attachment?.agentId;
    const orphanedApprovals = this.removePendingApprovalWaitersForSocket(ws);
    if (!agentId) {
      await this.ensureWatchSubscription();
      return;
    }

    const state = await this.loadState();
    const agent = state.agents[agentId];
    if (agent) {
      agent.lastDisconnectedAt = new Date().toISOString();
      state.agents[agentId] = agent;
    }

    const queue = state.queues[agentId] ?? [];
    let changed = false;
    const retained: DeliveryRecord[] = [];
    for (const entry of queue) {
      if (!entry.inflight) {
        retained.push(entry);
        continue;
      }

      changed = true;
      this.completeDeliverySpan(agentId, entry, "error", reason);
      if (entry.attempt >= DEFAULT_RETRY_POLICY.maxAttempts) {
        this.recordAttemptDurationMetric(state, agentId, entry);
        this.clearEventExpansionCache(entry.eventId);
        await this.writeFailedEvent(agentId, entry.event, reason);
        this.sendDeliveryFailed(agentId, entry.event, reason);
        if (entry.event.type === "relaycast.message") {
          await this.failRelaycastDelivery(
            agentId,
            entry.event as RelaycastMessageEvent,
            reason,
          );
        }
        continue;
      }

      this.recordAttemptDurationMetric(state, agentId, entry);
      entry.attempt += 1;
      entry.event.attempt = entry.attempt;
      entry.inflight = false;
      entry.inflightAt = undefined;
      entry.lastError = reason;
      entry.dueAt = new Date(
        Date.now() + computeRetryDelayMs(entry.attempt - 1),
      ).toISOString();
      recordRetryMetric(ensureMetricsState(state), {
        agentId,
        eventType: entry.event.type,
      });
      retained.push(entry);
    }

    state.queues[agentId] = retained;
    await this.saveState(state);
    this.broadcastAgentActivity(agentId, {
      id: `session.disconnected:${agentId}:${Date.now()}`,
      kind: "session.disconnected",
      occurredAt: agent?.lastDisconnectedAt ?? new Date().toISOString(),
      message: `${agent?.agentName ?? agentId} disconnected`,
    });
    await Promise.all(
      orphanedApprovals.map(async (approvalId) => {
        try {
          await this.getRelayfileClient().deleteFile({
            workspaceId: agent?.workspace ?? state.workspace ?? "",
            path: `/pending-approvals/${approvalId}.json`,
            baseRevision: "*",
          });
        } catch {
          // Best-effort cleanup for abandoned approval artifacts.
        }
      }),
    );
    await this.ensureWatchSubscription(state);
    if (changed) {
      await this.scheduleNextAlarm(state);
    }
  }

  private async enqueueEvent(
    agentId: string,
    event: AgentEvent,
    requestedMaxBacklog?: number,
  ): Promise<boolean> {
    const tracedEvent = injectTraceContextIntoCarrier({
      ...event,
    }) as AgentEvent;
    const dedupKey = `${event.workspace}:${agentId}:${event.id}`;
    const accepted = await markEventSeen(this.ctx.storage, dedupKey);
    if (!accepted) {
      return false;
    }

    const state = await this.loadState();
    this.assertStateWorkspace(state, event.workspace);
    state.workspace = state.workspace ?? event.workspace;

    if (!state.agents[agentId]) {
      state.agents[agentId] = {
        agentId,
        agentName: agentId,
        workspace: event.workspace,
        schedules: [],
      };
    }

    const queue = state.queues[agentId] ?? [];
    const metrics = ensureMetricsState(state);
    recordReceivedMetric(metrics, {
      agentId,
      eventType: event.type,
    });
    const maxBacklog = requestedMaxBacklog ?? state.agents[agentId]?.maxBacklog ?? MAX_BACKLOG;
    if (queue.length >= maxBacklog) {
      const dropIndex = queue.findIndex((entry) => this.isDroppableBacklogEvent(entry.event));
      if (dropIndex >= 0) {
        const [dropped] = queue.splice(dropIndex, 1);
        if (dropped) {
          recordDropMetric(metrics, {
            agentId,
            eventType: dropped.event.type,
          });
        }
        console.warn(
          JSON.stringify({
            event: "relayfile.changed.dropped",
            workspace: event.workspace,
            agentId,
            droppedEventId: dropped?.eventId ?? null,
            droppedEventType: dropped?.event.type ?? null,
            maxBacklog,
          }),
        );
      } else if (this.isDroppableBacklogEvent(event)) {
        recordDropMetric(metrics, {
          agentId,
          eventType: event.type,
        });
        console.warn(
          JSON.stringify({
            event: "relayfile.changed.dropped",
            workspace: event.workspace,
            agentId,
            droppedEventId: event.id,
            droppedEventType: event.type,
            maxBacklog,
          }),
        );
        return false;
      }
    }
    const delivery: DeliveryRecord = {
      id: crypto.randomUUID(),
      eventId: tracedEvent.id,
      event: tracedEvent,
      attempt: Math.max(1, tracedEvent.attempt),
      dueAt: new Date().toISOString(),
      inflight: false,
      enqueuedAt: new Date().toISOString(),
    };
    queue.push(delivery);
    state.queues[agentId] = queue;
    await this.saveState(state);
    this.broadcastAgentActivity(agentId, {
      id: `event.enqueued:${delivery.eventId}:${delivery.id}`,
      kind: "event.enqueued",
      occurredAt: delivery.enqueuedAt,
      eventId: delivery.eventId,
      eventType: delivery.event.type,
      attempt: delivery.attempt,
      queueDepth: queue.length,
      detail: {
        resource: delivery.event.resource,
      },
    });

    await this.drainDeliveries();
    return true;
  }

  private isDroppableBacklogEvent(event: AgentEvent): boolean {
    return event.type !== "cron.tick" && event.type !== "relaycast.message";
  }

  private getHandlerTimeoutMsForAgent(state: WorkspaceState, agentId: string): number {
    return state.agents[agentId]?.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS;
  }

  private async drainDeliveries(): Promise<void> {
    const state = await this.loadState();
    await this.expireInflightDeliveries(state);
    const nowMs = Date.now();
    let mutated = false;

    for (const [agentId, queue] of Object.entries(state.queues)) {
      const head = queue[0];
      if (!head || head.inflight) {
        continue;
      }

      const dueMs = Date.parse(head.dueAt);
      if (!Number.isFinite(dueMs) || dueMs > nowMs) {
        continue;
      }

      const socket = this.findSocket(agentId);
      if (!socket) {
        continue;
      }

      const attachment = readSocketAttachment(socket);
      if (attachment?.legacyProtocol === true) {
        queue.shift();
        mutated = true;
        await this.sendEventWithTrace(agentId, socket, head.event);
        continue;
      }

      head.inflight = true;
      head.inflightAt = new Date().toISOString();
      mutated = true;
      await this.sendEventWithTrace(agentId, socket, head.event);
    }

    if (mutated) {
      await this.saveState(state);
    }

    await this.scheduleNextAlarm(state);
  }

  private async scheduleNextAlarm(state: WorkspaceState): Promise<void> {
    const nowMs = Date.now();
    const deliveryDueTimes = Object.entries(state.queues)
      .flatMap(([agentId, queue]) =>
        queue.map((entry) =>
          entry.inflight
            ? Date.parse(entry.inflightAt ?? "") + this.getHandlerTimeoutMsForAgent(state, agentId)
            : Date.parse(entry.dueAt),
        ),
      )
      .filter((value) => Number.isFinite(value) && value > nowMs);
    const tokenDueTimes = Object.entries(state.agents)
      .map(([agentId, agent]) => this.getNextAgentMaintenanceDueMs(agentId, agent, nowMs))
      .filter((value): value is number => Number.isFinite(value));
    const nextDueTimes = [...deliveryDueTimes, ...tokenDueTimes];

    if (nextDueTimes.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(Math.min(...nextDueTimes));
  }

  private async loadState(): Promise<WorkspaceState> {
    return (
      (await this.ctx.storage.get<WorkspaceState>(STATE_KEY)) ?? {
        agents: {},
        queues: {},
      }
    );
  }

  private async saveState(state: WorkspaceState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  private async ensureWatchSubscription(state?: WorkspaceState): Promise<void> {
    const currentState = state ?? await this.loadState();
    const globs = collectWorkspaceWatchGlobs(currentState);
    if (this.pendingApprovals.size > 0 && !globs.includes(APPROVAL_GLOB)) {
      globs.push(APPROVAL_GLOB);
    }
    if (globs.length === 0) {
      await this.watchSubscriber?.close();
      this.watchSubscriber = null;
      return;
    }

    const workspace = currentState.workspace ?? firstWorkspaceFromState(currentState);
    if (!workspace) {
      return;
    }

    if (!this.watchSubscriber) {
      this.watchSubscriber = new WorkspaceWatchSubscriber(
        this.getRelayfileClient(),
        workspace,
        async (event) => {
          await this.handleRelayfileWorkspaceEvent(workspace, event);
        },
        async (error) => {
          this.logRelayfileWatchError(error);
        },
      );
    }

    await this.watchSubscriber.update(globs);
  }

  private async ensureInboxSubscription(state?: WorkspaceState): Promise<void> {
    const currentState = state ?? await this.loadState();
    for (const agent of Object.values(currentState.agents)) {
      if (agent.accessToken?.trim() && (agent.inbox?.length ?? 0) > 0) {
        await this.ensureFreshAgentRecord(agent.agentId, currentState);
      }
    }
    const registrations = collectWorkspaceInboxRegistrations(currentState);
    if (registrations.length === 0) {
      await this.inboxSubscriber?.close();
      this.inboxSubscriber = null;
      return;
    }

    const workspace = currentState.workspace ?? firstWorkspaceFromState(currentState);
    if (!workspace) {
      return;
    }

    if (!this.inboxSubscriber) {
      this.inboxSubscriber = new WorkspaceInboxSubscriber(
        this.env.RELAYCAST_URL?.trim() || DEFAULT_RELAYCAST_URL,
        this.getRelaycastInboxClientFactory(),
        async (selector, event) => {
          await this.handleRelaycastChannelEvent(workspace, selector, event);
        },
        async (agentId, event) => {
          await this.handleRelaycastSelfEvent(workspace, agentId, event);
        },
        async (error) => {
          this.logRelaycastInboxError(error);
        },
        (agentId, event) => {
          this.recordRelaycastDeliveryId(agentId, event);
        },
      );
    }

    await this.inboxSubscriber.update(registrations);
  }

  private getRelayfileClient(): RelayFileClient {
    if (!this.relayfileClient) {
      this.relayfileClient = new RelayFileClient({
        baseUrl: this.env.RELAYFILE_URL,
        readCache: {},
        token: async () => {
          const state = await this.loadState();
          for (const agentId of Object.keys(state.agents)) {
            const agent = await this.ensureFreshAgentRecord(agentId, state);
            if (agent?.accessToken?.trim()) {
              return agent.accessToken.trim();
            }
          }
          throw new Error("no relayfile-capable access token is available for watch replay");
        },
      });
    }
    return this.relayfileClient;
  }

  private getRelaycastInboxClientFactory(): RelaycastInboxClientFactory {
    if (this.relaycastClientFactory) {
      return this.relaycastClientFactory;
    }

    return ({ accessToken, baseUrl }) =>
      createDefaultRelaycastInboxClient({ accessToken, baseUrl });
  }

  private async replayRegisteredWatchEvents(
    agentId: string,
    state?: WorkspaceState,
    watches?: WatchRegistration[],
  ): Promise<void> {
    const currentState = state ?? await this.loadState();
    const agent = currentState.agents[agentId];
    const registrations = watches ?? agent?.watches ?? [];
    if (!agent || registrations.length === 0) {
      return;
    }

    const replayModes = [...new Set(
      registrations
        .map((watch) => watch.replayOnStart)
        .filter((value) => value !== "none"),
    )];
    if (replayModes.length === 0) {
      return;
    }

    try {
      for (const replayOnStart of replayModes) {
        const replayEvents = await readReplayEvents(this.getRelayfileClient(), {
          workspace: agent.workspace,
          replayOnStart,
          globs: registrations
            .filter((watch) => watch.replayOnStart === replayOnStart)
            .map((watch) => watch.glob),
        });

        for (const event of replayEvents) {
          // cloud#2029: the stored-feed replay path is the one an operator mute
          // can't bracket — a drain tombstone re-delivered on a later watch
          // registration would spam subscribers. Suppress drain-marked deletes
          // here too (they still cleared the mount via the live feed).
          if (shouldSuppressRelayfileWatchDelivery(event)) {
            continue;
          }
          const watch = registrations.find((candidate) =>
            candidate.replayOnStart === replayOnStart
            && matchesWatchGlob(event.path, candidate.glob),
          );
          if (!watch) {
            continue;
          }
          this.scheduleRelayfileEventForAgent(agentId, agent.workspace, watch, event);
        }
      }
    } catch (error) {
      this.logRelayfileWatchError(error);
    }
  }

  private async handleRelayfileWorkspaceEvent(
    workspace: string,
    event: RelayfileWatchEvent,
  ): Promise<void> {
    // cloud#2029: a legacy-draft-drain tombstone must reach mounts via the
    // relayfile feed but must NOT fan out as an agent-watch notification.
    if (shouldSuppressRelayfileWatchDelivery(event)) {
      return;
    }
    await this.resolvePendingApprovalsFromEvent(workspace, event);
    const state = await this.loadState();
    for (const agent of Object.values(state.agents)) {
      const watch = agent.watches?.find((candidate) =>
        matchesWatchGlob(event.path, candidate.glob),
      );
      if (!watch) {
        continue;
      }
      this.scheduleRelayfileEventForAgent(agent.agentId, workspace, watch, event);
    }
  }

  private async handleRelaycastChannelEvent(
    workspace: string,
    selector: string,
    event: RelaycastInboxMessageEvent,
  ): Promise<void> {
    const state = await this.loadState();
    const deliveredIdentities = new Set<string>();
    for (const agent of Object.values(state.agents)) {
      if (!agent.inbox?.some((registration) => registration.selector === selector)) {
        continue;
      }
      if (relaycastEventFromMatchesAgent(event, agent)) {
        continue;
      }
      addAgentDeliveryIdentities(deliveredIdentities, agent);
      await this.scheduleRelaycastEventForAgent(
        agent.agentId,
        workspace,
        event,
        state.agents[agent.agentId]?.maxBacklog,
      );
    }
    await this.deliverRelaycastEventForDeployments(
      workspace,
      selector,
      event,
      deliveredIdentities,
    );
  }

  private async handleRelaycastSelfEvent(
    workspace: string,
    agentId: string,
    event: RelaycastInboxMessageEvent,
  ): Promise<void> {
    const state = await this.loadState();
    const deliveredIdentities = new Set<string>();
    const agent = state.agents[agentId];
    if (agent && !relaycastEventFromMatchesAgent(event, agent)) {
      addAgentDeliveryIdentities(deliveredIdentities, agent);
      await this.scheduleRelaycastEventForAgent(
        agentId,
        workspace,
        event,
        state.agents[agentId]?.maxBacklog,
      );
    }
    await this.deliverRelaycastEventForDeployments(
      workspace,
      "@self",
      event,
      deliveredIdentities,
      { recipientAgentId: agentId },
    );
  }

  private async deliverRelaycastEventForDeployments(
    workspace: string,
    selector: string,
    event: RelaycastInboxMessageEvent,
    deliveredIdentities: ReadonlySet<string>,
    options: { recipientAgentId?: string } = {},
  ): Promise<void> {
    let candidates: InboxDeploymentCandidate[];
    try {
      candidates = await this.readInboxDeploymentCandidates(workspace, selector);
    } catch (error) {
      this.logRelaycastInboxError(error);
      return;
    }

    for (const candidate of candidates) {
      if (
        selector === "@self"
        && options.recipientAgentId
        && candidate.agentId !== options.recipientAgentId
      ) {
        continue;
      }
      if (candidateInboxIdentityMatches(candidate, deliveredIdentities)) {
        continue;
      }
      if (relaycastEventFromMatchesDeployment(event, candidate)) {
        continue;
      }
      try {
        const envelope = await buildRelaycastMessageEnvelope({
          workspace,
          eventId: event.id,
          channel: event.channel,
          messageId: event.messageId,
          text: event.text,
          threadId: event.threadId,
          occurredAt: event.occurredAt,
          from: event.from,
        });
        await this.deliverInboxDeploymentTrigger(
          workspace,
          candidate.agentId,
          {
            ...envelope,
            deliveryId: `relaycast:${workspace}:${candidate.agentId}:${event.messageId}`,
          },
        );
      } catch (error) {
        this.logRelaycastInboxError(error);
      }
    }
  }

  private async scheduleRelaycastEventForAgent(
    agentId: string,
    workspace: string,
    event: RelaycastInboxMessageEvent,
    requestedMaxBacklog?: number,
  ): Promise<void> {
    try {
      const envelope = await buildRelaycastMessageEnvelope({
        workspace,
        eventId: event.id,
        channel: event.channel,
        messageId: event.messageId,
        text: event.text,
        threadId: event.threadId,
        occurredAt: event.occurredAt,
        from: event.from,
      });
      await this.enqueueEvent(agentId, envelope, requestedMaxBacklog);
    } catch (error) {
      this.logRelaycastInboxError(error);
    }
  }

  private scheduleRelayfileEventForAgent(
    agentId: string,
    workspace: string,
    watch: WatchRegistration,
    event: Pick<FilesystemEvent, "eventId" | "type" | "path" | "revision" | "timestamp" | "provider"> & {
      contentHash?: string;
      digest?: string;
      summary?: Awaited<ReturnType<typeof buildResourceSummary>>;
    },
  ): void {
    const key = `${workspace}:${agentId}:${event.path}`;
    this.watchCoalescer.schedule(key, watch.coalesceMs, async () => {
      try {
        const summary = await this.buildRelayfileEventSummary(workspace, event);
        const envelope = await buildRelayfileChangedEnvelope({
          workspace,
          path: event.path,
          watch: watch.glob,
          provider: event.provider,
          occurredAt: event.timestamp,
          eventId: event.eventId,
          revision: event.revision,
          digest: event.digest,
          contentHash: event.contentHash,
          type: event.type,
          summary,
        });
        await this.enqueueEvent(agentId, envelope, watch.maxBacklog);
      } catch (error) {
        this.logRelayfileWatchError(error);
      }
    });
  }

  private async buildRelayfileEventSummary(
    workspace: string,
    event: Pick<FilesystemEvent, "eventId" | "path" | "provider"> & {
      summary?: Awaited<ReturnType<typeof buildResourceSummary>>;
    },
  ) {
    if (event.summary && Object.keys(event.summary).length > 0) {
      return event.summary;
    }

    try {
      const resource = await this.loadRelayfileResourceForSummary(workspace, event);
      return resource ? buildResourceSummary(event.provider ?? "relayfile", resource) : undefined;
    } catch (error) {
      this.logRelayfileWatchError(error);
      return undefined;
    }
  }

  private async loadRelayfileResourceForSummary(
    workspace: string,
    event: Pick<FilesystemEvent, "eventId" | "path">,
  ): Promise<unknown> {
    const client = this.getRelayfileClient() as RelayFileClient & {
      getResourceAtEvent?: (
        eventId: string,
        options?: { workspace?: string; workspaceId?: string; path?: string },
      ) => Promise<{ data?: unknown } | unknown>;
    };

    if (typeof client.getResourceAtEvent === "function" && event.eventId?.trim()) {
      return client.getResourceAtEvent(event.eventId, {
        workspace,
        path: event.path,
      });
    }

    const file = await client.readFile(workspace, event.path);
    if (/json/i.test(file.contentType)) {
      try {
        return JSON.parse(file.content);
      } catch {
        return file.content;
      }
    }

    return file.content;
  }

  private logRelayfileWatchError(error: unknown): void {
    const attachment = this.ctx.getWebSockets()
      .map((socket) => readSocketAttachment(socket))
      .find((candidate) => candidate?.workspace || candidate?.agentId);
    console.error(JSON.stringify({
      event: "agent_gateway_watch_error",
      workspace: attachment?.workspace ?? null,
      agentId: attachment?.agentId ?? null,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  private logRelaycastInboxError(error: unknown): void {
    const attachment = this.ctx.getWebSockets()
      .map((socket) => readSocketAttachment(socket))
      .find((candidate) => candidate?.workspace || candidate?.agentId);
    console.error(JSON.stringify({
      event: "agent_gateway_inbox_error",
      workspace: attachment?.workspace ?? null,
      agentId: attachment?.agentId ?? null,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  private buildAgentSummary(
    state: WorkspaceState,
    agent: AgentRecord,
  ): AgentInspectorSummary {
    const events = this.buildAgentActivity(state, agent.agentId);
    const lastEvent = events[0];
    const lastError = events.find((event) =>
      (event.kind === "event.failed" || event.kind === "event.retried") &&
      typeof event.message === "string" &&
      event.message.trim(),
    )?.message ?? null;
    return {
      agentId: agent.agentId,
      agentName: agent.agentName,
      workspace: agent.workspace,
      status: this.findSocket(agent.agentId) ? "online" : "offline",
      queueDepth: state.queues[agent.agentId]?.length ?? 0,
      scheduleCount: agent.schedules.length,
      watchCount: agent.watches?.length ?? 0,
      inboxCount: agent.inbox?.length ?? 0,
      lastConnectedAt: agent.lastConnectedAt ?? null,
      lastDisconnectedAt: agent.lastDisconnectedAt ?? null,
      deployStartedAt: null,
      lastEvent: lastEvent?.kind ?? null,
      lastEventAt:
        lastEvent?.occurredAt
        ?? agent.lastConnectedAt
        ?? agent.lastDisconnectedAt
        ?? new Date(0).toISOString(),
      lastError,
    };
  }

  private buildAgentActivity(
    state: WorkspaceState,
    agentId: string,
  ): AgentActivityRecord[] {
    const agent = state.agents[agentId];
    const queue = state.queues[agentId] ?? [];
    const events: AgentActivityRecord[] = [];

    if (agent?.lastConnectedAt) {
      events.push({
        id: `session.connected:${agentId}:${agent.lastConnectedAt}`,
        kind: "session.connected",
        occurredAt: agent.lastConnectedAt,
        message: `${agent.agentName} connected`,
      });
    }

    if (agent?.lastDisconnectedAt) {
      events.push({
        id: `session.disconnected:${agentId}:${agent.lastDisconnectedAt}`,
        kind: "session.disconnected",
        occurredAt: agent.lastDisconnectedAt,
        message: `${agent.agentName} disconnected`,
      });
    }

    if (agent && (agent.schedules.length > 0 || (agent.watches?.length ?? 0) > 0 || (agent.inbox?.length ?? 0) > 0)) {
      events.push({
        id: `agent.registered:${agentId}`,
        kind: "agent.registered",
        occurredAt: agent.lastConnectedAt ?? new Date(0).toISOString(),
        detail: {
          schedules: agent.schedules.length,
          watches: agent.watches?.length ?? 0,
          inbox: agent.inbox?.length ?? 0,
        },
      });
    }

    for (const entry of queue) {
      events.push({
        id: `event.enqueued:${entry.eventId}:${entry.id}`,
        kind: entry.lastError ? "event.retried" : "event.enqueued",
        occurredAt: entry.enqueuedAt,
        eventId: entry.eventId,
        eventType: entry.event.type,
        attempt: entry.attempt,
        queueDepth: queue.length,
        message: entry.lastError,
        detail: {
          inflight: entry.inflight,
          dueAt: entry.dueAt,
          resource: entry.event.resource,
        },
      });
    }

    return events
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
      .slice(0, 100);
  }

  private findSocket(agentId: string): WebSocket | null {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readSocketAttachment(socket);
      if (attachment?.agentId === agentId && attachment.role !== "observer") {
        return socket;
      }
    }
    return null;
  }

  private sendToSocket(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Socket closed between lookup and send.
    }
  }

  private broadcastAgentActivity(agentId: string, activity: AgentActivityRecord): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readSocketAttachment(socket);
      if (attachment?.role === "observer" && attachment.agentId === agentId) {
        this.sendToSocket(socket, {
          type: "activity",
          activity,
        });
      }
    }
  }

  private async sendEventWithTrace(
    agentId: string,
    socket: WebSocket,
    event: AgentEvent,
  ): Promise<void> {
    const parentContext = extractTraceContextFromCarrier(
      event as unknown as Record<string, unknown>,
    );
    const outboundEvent = injectTraceContextIntoCarrier(
      { ...event },
      parentContext,
    );
    this.sendToSocket(socket, {
      type: "event",
      event: outboundEvent,
    });
  }

  private sendConnected(socket: WebSocket): void {
    this.sendToSocket(socket, {
      type: "connected",
    });
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.sendToSocket(socket, {
      type: "error",
      error: message,
      code,
      message,
    });
  }

  private sendFilesError(
    socket: WebSocket,
    requestId: string | undefined,
    code: string,
    message: string,
  ): void {
    this.sendToSocket(socket, {
      type: "files_error",
      requestId,
      code,
      message,
    });
  }

  private sendFilesRpcError(
    socket: WebSocket,
    requestId: string | undefined,
    error: unknown,
    fallbackMessage: string,
  ): void {
    if (isRelayFileApiError(error)) {
      this.sendFilesError(socket, requestId, error.code, error.message);
      return;
    }

    this.sendFilesError(
      socket,
      requestId,
      "internal_error",
      error instanceof Error ? error.message : fallbackMessage,
    );
  }

  private sendMessagesError(
    socket: WebSocket,
    requestId: string | undefined,
    code: string,
    message: string,
  ): void {
    this.sendToSocket(socket, {
      type: "messages_error",
      requestId,
      code,
      message,
    });
  }

  private sendMessagesRpcError(
    socket: WebSocket,
    requestId: string | undefined,
    error: unknown,
    fallbackMessage: string,
  ): void {
    this.sendMessagesError(
      socket,
      requestId,
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "internal_error",
      error instanceof Error ? error.message : fallbackMessage,
    );
  }

  private sendApprovalError(
    socket: WebSocket,
    requestId: string | undefined,
    code: string,
    message: string,
  ): void {
    this.sendToSocket(socket, {
      type: "approval_error",
      requestId,
      code,
      message,
    });
  }

  private sendDeliveryFailed(agentId: string, event: AgentEvent, message: string): void {
    const socket = this.findSocket(agentId);
    if (!socket) {
      return;
    }
    this.sendToSocket(socket, {
      type: "delivery_failed",
      error: message,
      event,
    });
  }

  private sendAuthOk(
    socket: WebSocket,
    input: {
      workspace: string;
      agentId: string;
      agentToken?: string;
      agentTokenExpiresAt?: string;
    },
  ): void {
    this.sendToSocket(socket, {
      type: "auth_ok",
      workspace: input.workspace,
      agentId: input.agentId,
      agent_id: input.agentId,
      ...(input.agentToken ? { agentToken: input.agentToken } : {}),
      ...(input.agentTokenExpiresAt
        ? { agentTokenExpiresAt: input.agentTokenExpiresAt }
        : { agentTokenExpiresAt: null }),
    });
  }

  private installWebSocketAutoResponse(): void {
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(
          JSON.stringify({ type: "ping" }),
          JSON.stringify({ type: "pong" }),
        ),
      );
      this.ctx.setHibernatableWebSocketEventTimeout(30_000);
    } catch {
      // The local type/runtime surface may not expose hibernation helpers.
    }
  }

  private async writeFailedEvent(
    agentId: string,
    event: AgentEvent,
    errorMessage?: string,
  ): Promise<void> {
    const state = await this.loadState();
    const agent = state.agents[agentId];
    let record:
      | Awaited<ReturnType<typeof writeGatewayDlqRecord>>
      | {
          path: string;
          workspace: string;
          agentId: string;
          event: AgentEvent;
          error: string;
          failedAt: string;
        };

    if (agent?.accessToken) {
      try {
        record = await writeGatewayDlqRecord({
          workspace: event.workspace,
          agentId,
          event,
          errorMessage,
          relayfileAccessToken: agent.accessToken,
          relayfileUrl: this.env.RELAYFILE_URL,
        });
      } catch (writeError) {
        record = {
          path: buildDlqPath(event.workspace, event.id),
          workspace: event.workspace,
          agentId,
          event,
          error:
            writeError instanceof Error
              ? writeError.message
              : errorMessage ?? "delivery failed",
          failedAt: new Date().toISOString(),
        };
        await this.ctx.storage.put(`${DLQ_PREFIX}${event.id}.json`, record);
      }
    } else {
      record = {
        path: buildDlqPath(event.workspace, event.id),
        workspace: event.workspace,
        agentId,
        event,
        error: errorMessage ?? "delivery failed",
        failedAt: new Date().toISOString(),
      };
      await this.ctx.storage.put(`${DLQ_PREFIX}${event.id}.json`, record);
    }

    console.error(JSON.stringify({
      event: "agent_gateway_dlq_write",
      workspace: event.workspace,
      agentId,
      eventId: event.id,
      path: record.path,
      error: record.error,
      occurredAt: record.failedAt,
    }));
  }

  private async handleExpand(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "expand" }>,
  ): Promise<void> {
    const requestId = message.requestId?.trim();
    const level = message.level ?? "full";
    const state = await this.loadState();
    const event = this.findEventForAgent(state, agentId, message.eventId);
    if (!event) {
      this.sendToSocket(ws, {
        type: "expand_error",
        requestId,
        code: "not_found",
        message: `event ${message.eventId} is not inflight for ${agentId}`,
      });
      return;
    }

    const agent = state.agents[agentId];
    if (!agent?.accessToken) {
      this.sendToSocket(ws, {
        type: "expand_error",
        requestId,
        code: "missing_access_token",
        message: "No relayfile-capable access token is available for this session",
      });
      return;
    }

    const cacheKey = `${event.id}:${level}:${JSON.stringify({
      cursor: message.params?.cursor ?? null,
      limit: message.params?.limit ?? null,
    })}`;
    let pending = this.expansionCache.get(cacheKey);
    if (!pending) {
      pending = expandGatewayEvent({
        workspace: event.workspace,
        event,
        level,
        threadOptions: level === "thread" ? message.params : undefined,
        relayfileAccessToken: agent.accessToken,
        relayfileUrl: this.env.RELAYFILE_URL,
        nangoBaseUrl: this.env.NANGO_BASE_URL,
        nangoSecretKey: this.env.NANGO_SECRET_KEY,
      });
      this.expansionCache.set(cacheKey, pending);
      this.enforceExpansionCacheLimit();
    }

    try {
      const expansion = await pending;
      this.sendToSocket(ws, {
        type: "expand_result",
        requestId,
        expansion,
      });
    } catch (error) {
      if (!this.isRetryableExpansionError(error)) {
        this.expansionCache.delete(cacheKey);
      }
      this.sendToSocket(ws, {
        type: "expand_error",
        requestId,
        code: this.expandErrorCode(error),
        message: error instanceof Error ? error.message : "expand failed",
      });
    }
  }

  private async handleFilesRead(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "files_read" }>,
  ): Promise<void> {
    const requestId = message.requestId?.trim();
    const path = normalizeWorkspacePath(message.path);
    if (!path) {
      this.sendFilesError(ws, requestId, "bad_request", "files.read requires a non-empty path");
      return;
    }

    const session = await this.resolveRelayfileSession(agentId);
    if (!session) {
      this.sendFilesError(
        ws,
        requestId,
        "missing_access_token",
        "No relayfile-capable access token is available for this session",
      );
      return;
    }

    if (!isRelayfilePathAllowed(path, session.pathGlobs)) {
      this.sendFilesError(
        ws,
        requestId,
        "permission_denied",
        buildPathScopeErrorMessage(path, session.pathGlobs),
      );
      return;
    }

    try {
      const file = await this.readRelayfileFileForSession(session, path);
      this.sendToSocket(ws, {
        type: "files_read_result",
        requestId,
        file,
      });
    } catch (error) {
      if (isRelayFileApiError(error) && error.status === 404) {
        this.sendToSocket(ws, {
          type: "files_read_result",
          requestId,
          file: null,
        });
        return;
      }
      this.sendFilesRpcError(ws, requestId, error, "files.read failed");
    }
  }

  private async handleFilesWrite(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "files_write" }>,
  ): Promise<void> {
    const requestId = message.requestId?.trim();
    const path = normalizeWorkspacePath(message.path);
    if (!path) {
      this.sendFilesError(ws, requestId, "bad_request", "files.write requires a non-empty path");
      return;
    }

    const session = await this.resolveRelayfileSession(agentId);
    if (!session) {
      this.sendFilesError(
        ws,
        requestId,
        "missing_access_token",
        "No relayfile-capable access token is available for this session",
      );
      return;
    }

    const serialized = serializeGatewayWriteBody(message.body, message.meta);
    if (!isRelayfilePathAllowed(path, session.pathGlobs)) {
      this.sendFilesError(
        ws,
        requestId,
        "permission_denied",
        buildPathScopeErrorMessage(path, session.pathGlobs),
      );
      return;
    }

    try {
      await session.client.writeFile({
        workspaceId: session.workspace,
        path,
        baseRevision: normalizeOptionalString(message.meta?.baseRevision) ?? "*",
        content: serialized.content,
        ...(serialized.contentType ? { contentType: serialized.contentType } : {}),
        ...(serialized.encoding ? { encoding: serialized.encoding } : {}),
        ...(serialized.semantics ? { semantics: serialized.semantics } : {}),
        ...(serialized.contentIdentity
          ? { contentIdentity: serialized.contentIdentity }
          : {}),
      });
      this.sendToSocket(ws, {
        type: "files_write_result",
        requestId,
      });
    } catch (error) {
      this.sendFilesRpcError(ws, requestId, error, "files.write failed");
    }
  }

  private async handleFilesDelete(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "files_delete" }>,
  ): Promise<void> {
    const requestId = message.requestId?.trim();
    const path = normalizeWorkspacePath(message.path);
    if (!path) {
      this.sendFilesError(ws, requestId, "bad_request", "files.delete requires a non-empty path");
      return;
    }

    const session = await this.resolveRelayfileSession(agentId);
    if (!session) {
      this.sendFilesError(
        ws,
        requestId,
        "missing_access_token",
        "No relayfile-capable access token is available for this session",
      );
      return;
    }

    if (!isRelayfilePathAllowed(path, session.pathGlobs)) {
      this.sendFilesError(
        ws,
        requestId,
        "permission_denied",
        buildPathScopeErrorMessage(path, session.pathGlobs),
      );
      return;
    }

    try {
      await session.client.deleteFile({
        workspaceId: session.workspace,
        path,
        baseRevision: normalizeOptionalString(message.baseRevision) ?? "*",
      });
      this.sendToSocket(ws, {
        type: "files_delete_result",
        requestId,
      });
    } catch (error) {
      this.sendFilesRpcError(ws, requestId, error, "files.delete failed");
    }
  }

  private async handleFilesList(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "files_list" }>,
  ): Promise<void> {
    const requestId = message.requestId?.trim();
    const glob = normalizeWorkspacePath(message.glob);
    if (!glob) {
      this.sendFilesError(ws, requestId, "bad_request", "files.list requires a non-empty glob");
      return;
    }

    const session = await this.resolveRelayfileSession(agentId);
    if (!session) {
      this.sendFilesError(
        ws,
        requestId,
        "missing_access_token",
        "No relayfile-capable access token is available for this session",
      );
      return;
    }

    try {
      const entries = await this.listWorkspaceFiles(session.client, session.workspace, glob);
      this.sendToSocket(ws, {
        type: "files_list_result",
        requestId,
        entries,
      });
    } catch (error) {
      this.sendFilesRpcError(ws, requestId, error, "files.list failed");
    }
  }

  private async handleMessagesPost(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "messages_post" }>,
  ): Promise<void> {
    const requestId = message.requestId?.trim();
    const channel = normalizeOptionalString(message.channel);
    const text = normalizeOptionalString(message.text);
    if (!channel || !text) {
      this.sendMessagesError(
        ws,
        requestId,
        "bad_request",
        "messages.post requires a non-empty channel and text",
      );
      return;
    }

    try {
      const result = await this.postRelaycastChannelMessage(agentId, channel, text, message.opts);
      this.sendToSocket(ws, {
        type: "messages_result",
        requestId,
        id: result.id,
      });
    } catch (error) {
      this.sendMessagesRpcError(ws, requestId, error, "messages.post failed");
    }
  }

  private async handleMessagesReply(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "messages_reply" }>,
  ): Promise<void> {
    const requestId = message.requestId?.trim();
    const threadId = normalizeOptionalString(message.threadId);
    const text = normalizeOptionalString(message.text);
    if (!threadId || !text) {
      this.sendMessagesError(
        ws,
        requestId,
        "bad_request",
        "messages.reply requires a non-empty threadId and text",
      );
      return;
    }

    try {
      const result = await this.replyRelaycastMessage(agentId, threadId, text, message.opts);
      this.sendToSocket(ws, {
        type: "messages_result",
        requestId,
        id: result.id,
      });
    } catch (error) {
      this.sendMessagesRpcError(ws, requestId, error, "messages.reply failed");
    }
  }

  private async handleMessagesDm(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "messages_dm" }>,
  ): Promise<void> {
    const requestId = message.requestId?.trim();
    const agentOrUser = normalizeOptionalString(message.agentOrUser);
    const text = normalizeOptionalString(message.text);
    if (!agentOrUser || !text) {
      this.sendMessagesError(
        ws,
        requestId,
        "bad_request",
        "messages.dm requires a non-empty agentOrUser and text",
      );
      return;
    }

    try {
      const result = await this.sendRelaycastDm(agentId, agentOrUser, text, message.opts);
      this.sendToSocket(ws, {
        type: "messages_result",
        requestId,
        id: result.id,
      });
    } catch (error) {
      this.sendMessagesRpcError(ws, requestId, error, "messages.dm failed");
    }
  }

  private async handleApprovalWait(
    agentId: string,
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "approval_wait" }>,
  ): Promise<void> {
    const requestId = message.requestId?.trim();
    const approvalId = normalizeOptionalString(message.approvalId);
    if (!requestId || !approvalId) {
      this.sendApprovalError(
        ws,
        requestId,
        "bad_request",
        "approval.wait requires a non-empty requestId and approvalId",
      );
      return;
    }

    try {
      const resolved = await this.tryResolveApproval(approvalId);
      if (resolved !== undefined) {
        this.sendToSocket(ws, {
          type: "approval_result",
          requestId,
          approval: resolved,
        });
        return;
      }

      const waiters = this.pendingApprovals.get(approvalId) ?? [];
      waiters.push({ agentId, requestId, socket: ws });
      this.pendingApprovals.set(approvalId, waiters);
      await this.ensureWatchSubscription();
    } catch (error) {
      this.sendApprovalError(
        ws,
        requestId,
        "internal_error",
        error instanceof Error ? error.message : "approval wait failed",
      );
    }
  }

  private async handleStructuredLog(
    agentId: string,
    entry: StructuredLogEntry | null | undefined,
  ): Promise<void> {
    const session = await this.resolveRelayfileSession(agentId);
    if (!session) {
      throw new Error("structured logging requires an authenticated relayfile session");
    }

    const record = normalizeStructuredLogEntry(entry, {
      workspace: session.workspace,
      agentId,
    });
    const path = buildWorkspaceLogPath(session.workspace, record.ts);

    let existingContent = "";
    let baseRevision = "*";
    try {
      const file = await session.client.readFile(session.workspace, path);
      if (typeof file.content === "string") {
        existingContent = file.content;
      }
      if (typeof file.revision === "string" && file.revision.trim()) {
        baseRevision = file.revision;
      }
    } catch (error) {
      if (!isRelayfileNotFound(error)) {
        throw error;
      }
    }

    const separator =
      existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n" : "";
    await session.client.writeFile({
      workspaceId: session.workspace,
      path,
      baseRevision,
      content: `${existingContent}${separator}${JSON.stringify(record)}\n`,
      contentType: "application/x-ndjson",
      encoding: "utf-8",
    });
    this.broadcastAgentActivity(agentId, {
      id: `log:${agentId}:${record.ts}:${crypto.randomUUID()}`,
      kind: "log",
      occurredAt: record.ts,
      level: record.level,
      message: record.msg,
      ...(typeof record.eventId === "string" ? { eventId: record.eventId } : {}),
    });
  }

  private async resolveRelayfileSession(agentId: string): Promise<{
    workspace: string;
    client: RelayFileClient;
    pathGlobs?: string[];
  } | null> {
    const state = await this.loadState();
    const agent = await this.ensureFreshAgentRecord(agentId, state);
    if (!agent?.accessToken?.trim()) {
      return null;
    }

    return {
      workspace: agent.workspace,
      client: new RelayFileClient({
        baseUrl: this.env.RELAYFILE_URL,
        token: agent.accessToken.trim(),
        readCache: {},
      }),
      pathGlobs: readPathGlobsFromAccessToken(agent.accessToken),
    };
  }

  private async readRelayfileFileForSession(
    session: {
      workspace: string;
      client: RelayFileClient;
      pathGlobs?: string[];
    },
    path: string,
  ) {
    const candidates = [
      path,
      ...slackAliasReadCandidatesFromPathGlobs(path, session.pathGlobs),
    ];
    let notFound: unknown;

    for (const candidate of candidates) {
      if (!isRelayfilePathAllowed(candidate, session.pathGlobs)) {
        continue;
      }

      try {
        return await session.client.readFile(session.workspace, candidate);
      } catch (error) {
        if (!isRelayFileApiError(error) || error.status !== 404) {
          throw error;
        }
        notFound ??= error;
      }
    }

    throw notFound ?? new RelayFileApiError(404, {
      code: "not_found",
      message: "file not found",
    });
  }

  private async resolveRelaycastSession(agentId: string): Promise<{
    token: string;
  } | null> {
    const state = await this.loadState();
    const agent = await this.ensureFreshAgentRecord(agentId, state);
    if (!agent?.accessToken?.trim()) {
      return null;
    }

    return {
      token: agent.accessToken.trim(),
    };
  }

  private async ensureFreshAgentRecord(
    agentId: string,
    state?: WorkspaceState,
  ): Promise<AgentRecord | null> {
    const currentState = state ?? await this.loadState();
    const agent = currentState.agents[agentId];
    if (!agent?.accessToken?.trim()) {
      return null;
    }

    if (!shouldRefreshAgentToken(agent.accessTokenExpiresAt)) {
      return agent;
    }

    const refreshToken = agent.refreshToken?.trim();
    if (!refreshToken) {
      return isTokenExpired(agent.accessTokenExpiresAt) ? null : agent;
    }

    try {
      const refreshed = await refreshAgentToken(this.env, refreshToken);
      const updated: AgentRecord = {
        ...agent,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
      };
      currentState.agents[agentId] = updated;
      await this.saveState(currentState);

      const socket = this.findSocket(agentId);
      if (socket) {
        this.sendToSocket(socket, {
          type: "agent_token",
          agentToken: refreshed.accessToken,
          agentTokenExpiresAt: refreshed.accessTokenExpiresAt,
          refreshToken: refreshed.refreshToken,
          refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
          tokenType: refreshed.tokenType,
        });
      }

      return updated;
    } catch (error) {
      if (!isTokenExpired(agent.accessTokenExpiresAt)) {
        console.warn(JSON.stringify({
          event: "agent_gateway_token_refresh_failed",
          agentId,
          error: error instanceof Error ? error.message : String(error),
        }));
        return agent;
      }

      currentState.agents[agentId] = {
        ...agent,
        accessToken: undefined,
      };
      await this.saveState(currentState);
      this.findSocket(agentId)?.close(4001, "agent token refresh failed");
      throw error;
    }
  }

  private async runTokenMaintenance(): Promise<void> {
    const state = await this.loadState();
    const nowIso = new Date().toISOString();
    let mutated = false;

    for (const agentId of Object.keys(state.agents)) {
      const agent = state.agents[agentId];
      if (!agent?.accessToken?.trim()) {
        continue;
      }

      if (shouldRefreshAgentToken(agent.accessTokenExpiresAt)) {
        try {
          const refreshed = await this.ensureFreshAgentRecord(agentId, state);
          if (refreshed) {
            refreshed.lastTokenCheckAt = nowIso;
            state.agents[agentId] = refreshed;
            mutated = true;
          }
        } catch {
          // Expired or revoked refresh flows already update state and close sockets.
        }
        continue;
      }

      if (!this.findSocket(agentId)) {
        continue;
      }
      if (!canIntrospectAgentToken(agent.accessToken)) {
        continue;
      }
      if (!shouldRunTokenIntrospection(agent.lastTokenCheckAt)) {
        continue;
      }

      const introspection = await introspectToken(
        this.env,
        agent.accessToken,
        agent.accessToken,
      );
      const current = state.agents[agentId];
      if (!current) {
        continue;
      }

      current.lastTokenCheckAt = nowIso;
      if (introspection && introspection.active === false) {
        current.accessToken = undefined;
        state.agents[agentId] = current;
        mutated = true;
        this.findSocket(agentId)?.close(
          4001,
          introspection.reason === "workspace_token_revoked" || introspection.revoked
            ? "agent token revoked"
            : "agent token inactive",
        );
        continue;
      }

      state.agents[agentId] = current;
      mutated = true;
    }

    if (mutated) {
      await this.saveState(state);
    }
  }

  private getNextAgentMaintenanceDueMs(
    agentId: string,
    agent: AgentRecord,
    nowMs: number,
  ): number | null {
    const dueTimes: number[] = [];
    const refreshDueMs = getAgentTokenRefreshDueMs(agent.accessTokenExpiresAt);
    if (Number.isFinite(refreshDueMs)) {
      dueTimes.push(Math.max(nowMs, refreshDueMs));
    }

    if (this.findSocket(agentId) && canIntrospectAgentToken(agent.accessToken)) {
      const lastCheckMs = Date.parse(agent.lastTokenCheckAt ?? "");
      const nextCheckMs = Number.isFinite(lastCheckMs)
        ? lastCheckMs + TOKEN_MAINTENANCE_INTERVAL_MS
        : nowMs + TOKEN_MAINTENANCE_INTERVAL_MS;
      dueTimes.push(Math.max(nowMs, nextCheckMs));
    }

    if (dueTimes.length === 0) {
      return null;
    }

    return Math.min(...dueTimes);
  }

  private async listWorkspaceFiles(
    client: RelayFileClient,
    workspace: string,
    glob: string,
  ): Promise<unknown[]> {
    const entries: unknown[] = [];
    let cursor: string | undefined;
    const prefix = globToQueryPrefix(glob);

    do {
      const page = await client.queryFiles(workspace, {
        path: prefix,
        cursor,
        limit: 1_000,
      });
      for (const item of page.items ?? []) {
        if (matchesWatchGlob(item.path, glob)) {
          entries.push(item);
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    return entries;
  }

  private async postRelaycastChannelMessage(
    agentId: string,
    channel: string,
    text: string,
    opts?: MessageRpcOptions,
  ): Promise<{ id: string }> {
    const name = channel.startsWith("#") ? channel.slice(1) : channel;
    return await this.relaycastRequest(
      agentId,
      `/v1/channels/${encodeURIComponent(name)}/messages`,
      {
        text,
        mode: "wait",
      },
      opts,
    );
  }

  private async replyRelaycastMessage(
    agentId: string,
    threadId: string,
    text: string,
    opts?: MessageRpcOptions,
  ): Promise<{ id: string }> {
    return await this.relaycastRequest(
      agentId,
      `/v1/messages/${encodeURIComponent(threadId)}/replies`,
      {
        text,
      },
      opts,
    );
  }

  private async sendRelaycastDm(
    agentId: string,
    agentOrUser: string,
    text: string,
    opts?: MessageRpcOptions,
  ): Promise<{ id: string }> {
    const normalizedTarget = agentOrUser.startsWith("@")
      ? agentOrUser.slice(1)
      : agentOrUser;
    return await this.relaycastRequest(
      agentId,
      "/v1/dm",
      {
        to: normalizedTarget,
        text,
        mode: "wait",
      },
      opts,
    );
  }

  private async relaycastRequest(
    agentId: string,
    path: string,
    body: Record<string, unknown>,
    opts?: MessageRpcOptions,
  ): Promise<{ id: string }> {
    const session = await this.resolveRelaycastSession(agentId);
    if (!session) {
      throw new Error("No relaycast-capable access token is available for this session");
    }

    const headers = new Headers({
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    });
    const idempotencyKey = opts?.idempotencyKey?.trim() || crypto.randomUUID();
    headers.set("Idempotency-Key", idempotencyKey);
    headers.set("X-Idempotency-Key", idempotencyKey);

    const response = await fetch(new URL(path, resolveRelaycastBaseUrl(this.env.RELAYCAST_URL)), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw await readRelaycastError(response, path);
    }

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const id =
      typeof payload?.id === "string"
        ? payload.id
        : typeof payload?.messageId === "string"
          ? payload.messageId
          : null;
    if (!id) {
      throw new Error(`relaycast request ${path} did not include a message id`);
    }

    return { id };
  }

  private recordRelaycastDeliveryId(
    agentId: string,
    event: RelaycastInboxDeliveryAccepted,
  ): void {
    const key = `${agentId}:${event.messageId}`;
    this.pruneRelaycastDeliveryIds();
    if (
      !this.relaycastDeliveryIds.has(key)
      && this.relaycastDeliveryIds.size >= MAX_RELAYCAST_DELIVERY_IDS
    ) {
      const oldest = this.relaycastDeliveryIds.keys().next().value;
      if (oldest !== undefined) {
        this.relaycastDeliveryIds.delete(oldest);
      }
    }
    this.relaycastDeliveryIds.delete(key);
    this.relaycastDeliveryIds.set(key, {
      deliveryId: event.deliveryId,
      expiresAt: Date.now() + RELAYCAST_DELIVERY_ID_TTL_MS,
    });
  }

  private takeRelaycastDeliveryId(
    agentId: string,
    messageId: string,
  ): string | undefined {
    const key = `${agentId}:${messageId}`;
    const entry = this.relaycastDeliveryIds.get(key);
    if (!entry) {
      return undefined;
    }
    this.relaycastDeliveryIds.delete(key);
    return entry.expiresAt > Date.now() ? entry.deliveryId : undefined;
  }

  private pruneRelaycastDeliveryIds(): void {
    const now = Date.now();
    for (const [key, entry] of this.relaycastDeliveryIds.entries()) {
      if (entry.expiresAt <= now) {
        this.relaycastDeliveryIds.delete(key);
      }
    }
  }

  private createRelaycastAgentClient(token: string): AgentClient {
    // No retries: settlement is best-effort and must not stall the ack/nack
    // path behind backoff sleeps.
    return new AgentClient(
      new HttpClient({
        apiKey: token,
        baseUrl: resolveRelaycastBaseUrl(this.env.RELAYCAST_URL),
        retryPolicy: { maxRetries: 0 },
      }),
      { autoHeartbeatMs: false },
    );
  }

  /**
   * Resolve the engine delivery id for (agent, message). Fast path is the
   * correlation map fed by `delivery.accepted` realtime events; on a miss the
   * durable deliveries feed (`/v1/deliveries`, non-terminal rows for the
   * acting agent) is consulted, which covers DO restarts and channel
   * recipients whose deliveries are not visible on the shared realtime
   * connection.
   */
  private async resolveRelaycastDeliveryId(
    agentId: string,
    messageId: string,
    client: AgentClient,
  ): Promise<string | undefined> {
    const correlated = this.takeRelaycastDeliveryId(agentId, messageId);
    if (correlated) {
      return correlated;
    }

    const items = await client.deliveries({ limit: RELAYCAST_DELIVERY_FEED_LIMIT });
    if (!Array.isArray(items)) {
      return undefined;
    }
    return items.find((item) => item?.messageId === messageId)?.id;
  }

  /**
   * Propagate a gateway envelope ack into the relaycast engine's durable
   * delivery ledger by acking the per-recipient delivery row.
   *
   * Best-effort: failures are logged and swallowed so an engine outage never
   * breaks the gateway ack path. When neither the correlation map nor the
   * durable feed yields a delivery row there is nothing left to settle (the
   * row is already terminal or was never created) and the ack is skipped.
   */
  private async settleRelaycastDelivery(
    agentId: string,
    envelope: Pick<RelaycastMessageEvent, "messageId" | "channel">,
  ): Promise<void> {
    try {
      const session = await this.resolveRelaycastSession(agentId);
      if (!session) {
        return;
      }

      const client = this.createRelaycastAgentClient(session.token);
      const deliveryId = await this.resolveRelaycastDeliveryId(
        agentId,
        envelope.messageId,
        client,
      );
      if (!deliveryId) {
        console.warn(JSON.stringify({
          event: "agent_gateway_relaycast_delivery_settle_skipped",
          outcome: "ack",
          agentId,
          messageId: envelope.messageId,
          channel: envelope.channel,
          reason: "no delivery row found",
        }));
        return;
      }

      await client.ackDelivery(deliveryId);
    } catch (error) {
      console.warn(JSON.stringify({
        event: "agent_gateway_relaycast_delivery_settle_failed",
        outcome: "ack",
        agentId,
        messageId: envelope.messageId,
        channel: envelope.channel,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  /**
   * Propagate a terminal gateway delivery failure (nack with no retry,
   * exhausted retries, or handler timeout DLQ) into the relaycast engine's
   * durable delivery ledger via `failDelivery`.
   *
   * Best-effort: failures are logged and swallowed so an engine outage never
   * breaks the gateway DLQ path.
   */
  private async failRelaycastDelivery(
    agentId: string,
    envelope: Pick<RelaycastMessageEvent, "messageId" | "channel">,
    reason: string,
  ): Promise<void> {
    try {
      const session = await this.resolveRelaycastSession(agentId);
      if (!session) {
        return;
      }

      const client = this.createRelaycastAgentClient(session.token);
      const deliveryId = await this.resolveRelaycastDeliveryId(
        agentId,
        envelope.messageId,
        client,
      );
      if (!deliveryId) {
        console.warn(JSON.stringify({
          event: "agent_gateway_relaycast_delivery_settle_skipped",
          outcome: "fail",
          agentId,
          messageId: envelope.messageId,
          channel: envelope.channel,
          reason: "no delivery row found",
        }));
        return;
      }

      // The gateway has exhausted its own retries, so the engine should not
      // expect another attempt through this path.
      await client.failDelivery(deliveryId, { error: reason, retryable: false });
    } catch (error) {
      console.warn(JSON.stringify({
        event: "agent_gateway_relaycast_delivery_settle_failed",
        outcome: "fail",
        agentId,
        messageId: envelope.messageId,
        channel: envelope.channel,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async tryResolveApproval(
    approvalId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const workspace = await this.resolveWorkspace();
    if (!workspace) {
      return undefined;
    }

    try {
      const file = await this.getRelayfileClient().readFile(
        workspace,
        `/approvals/${approvalId}.json`,
      );
      return parseApprovalFile(file.content);
    } catch (error) {
      if (isRelayFileApiError(error) && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private async resolveWorkspace(): Promise<string | undefined> {
    const state = await this.loadState();
    return state.workspace ?? firstWorkspaceFromState(state);
  }

  private removePendingApprovalWaitersForSocket(socket: WebSocket): string[] {
    const orphanedApprovals: string[] = [];
    for (const [approvalId, waiters] of this.pendingApprovals.entries()) {
      const retained = waiters.filter((waiter) => waiter.socket !== socket);
      if (retained.length === 0) {
        this.pendingApprovals.delete(approvalId);
        orphanedApprovals.push(approvalId);
        continue;
      }
      if (retained.length !== waiters.length) {
        this.pendingApprovals.set(approvalId, retained);
      }
    }
    return orphanedApprovals;
  }

  private async resolvePendingApprovalsFromEvent(
    workspace: string,
    event: RelayfileWatchEvent,
  ): Promise<void> {
    const approvalId = readApprovalIdFromPath(event.path);
    if (!approvalId || !this.pendingApprovals.has(approvalId)) {
      return;
    }

    try {
      const file = await this.getRelayfileClient().readFile(
        workspace,
        `/approvals/${approvalId}.json`,
      );
      const approval = parseApprovalFile(file.content);
      const waiters = this.pendingApprovals.get(approvalId) ?? [];
      this.pendingApprovals.delete(approvalId);
      for (const waiter of waiters) {
        this.sendToSocket(waiter.socket, {
          type: "approval_result",
          requestId: waiter.requestId,
          approval,
        });
      }
      await this.ensureWatchSubscription();
    } catch (error) {
      const waiters = this.pendingApprovals.get(approvalId) ?? [];
      if (isRelayFileApiError(error) && error.status === 404) {
        return;
      }
      this.pendingApprovals.delete(approvalId);
      for (const waiter of waiters) {
        this.sendApprovalError(
          waiter.socket,
          waiter.requestId,
          "internal_error",
          error instanceof Error ? error.message : "failed to resolve approval",
        );
      }
      await this.ensureWatchSubscription();
    }
  }

  private findEventForAgent(
    state: WorkspaceState,
    agentId: string,
    eventId: string,
  ): AgentEvent | null {
    const queue = state.queues[agentId] ?? [];
    return queue.find((entry) => entry.eventId === eventId)?.event ?? null;
  }

  private clearEventExpansionCache(eventId: string): void {
    for (const key of [...this.expansionCache.keys()]) {
      if (key.startsWith(`${eventId}:`)) {
        this.expansionCache.delete(key);
      }
    }
  }

  private enforceExpansionCacheLimit(): void {
    while (this.expansionCache.size > MAX_EXPANSION_CACHE_ENTRIES) {
      const oldestKey = this.expansionCache.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.expansionCache.delete(oldestKey);
    }
  }

  private expandErrorCode(error: unknown): string {
    if (error instanceof FeatureNotImplementedError) {
      return error.code;
    }
    return "expand_failed";
  }

  private isRetryableExpansionError(error: unknown): boolean {
    return error instanceof FeatureNotImplementedError;
  }

  private async handleOnce(
    agentId: string,
    ws: WebSocket,
    key: string | undefined,
    requestId: string | undefined,
  ): Promise<void> {
    const normalizedKey = key?.trim();
    if (!normalizedKey) {
      this.sendError(ws, "bad_request", "ctx.once() requires a non-empty key");
      return;
    }

    const storageKey = `${ONCE_PREFIX}${agentId}:${normalizedKey}`;
    const existing = readOnceLock(await this.ctx.storage.get(storageKey));
    if (existing && !isExpiredOnceLock(existing)) {
      this.sendToSocket(ws, {
        type: "once_result",
        requestId,
        acquired: false,
      });
      return;
    }

    await this.ctx.storage.put(storageKey, {
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ONCE_TTL_MS).toISOString(),
    });
    this.sendToSocket(ws, {
      type: "once_result",
      requestId,
      acquired: true,
    });
  }

  private async handleOnceRelease(
    agentId: string,
    key: string | undefined,
  ): Promise<void> {
    const normalizedKey = key?.trim();
    if (!normalizedKey) {
      return;
    }
    await this.ctx.storage.delete(`${ONCE_PREFIX}${agentId}:${normalizedKey}`);
  }

  private async expireInflightDeliveries(state: WorkspaceState): Promise<void> {
    const nowMs = Date.now();
    let mutated = false;

    for (const [agentId, queue] of Object.entries(state.queues)) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const entry = queue[index];
        if (!entry?.inflight) {
          continue;
        }

        const inflightAtMs = Date.parse(entry.inflightAt ?? "");
        if (!Number.isFinite(inflightAtMs) || inflightAtMs + this.getHandlerTimeoutMsForAgent(state, agentId) > nowMs) {
          continue;
        }

        mutated = true;
        this.completeDeliverySpan(agentId, entry, "error", "handler timed out");
        console.warn(JSON.stringify({
          event: "agent_gateway_handler_timeout",
          workspace: entry.event.workspace,
          agentId,
          eventId: entry.event.id,
          eventType: entry.event.type,
          occurredAt: new Date(nowMs).toISOString(),
        }));
        if (entry.attempt >= DEFAULT_RETRY_POLICY.maxAttempts) {
          this.recordAttemptDurationMetric(state, agentId, entry);
          queue.splice(index, 1);
          await this.writeFailedEvent(agentId, entry.event, "handler timed out");
          this.sendDeliveryFailed(agentId, entry.event, "handler timed out");
          if (entry.event.type === "relaycast.message") {
            await this.failRelaycastDelivery(
              agentId,
              entry.event as RelaycastMessageEvent,
              "handler timed out",
            );
          }
          continue;
        }

        this.recordAttemptDurationMetric(state, agentId, entry);
        entry.attempt += 1;
        entry.event.attempt = entry.attempt;
        entry.inflight = false;
        entry.inflightAt = undefined;
        entry.lastError = "handler timed out";
        entry.dueAt = new Date(
          Date.now() + computeRetryDelayMs(entry.attempt - 1),
        ).toISOString();
        recordRetryMetric(ensureMetricsState(state), {
          agentId,
          eventType: entry.event.type,
        });
      }
    }

    if (mutated) {
      await this.saveState(state);
    }
  }

  private async handleMetricsRequest(request: Request): Promise<Response> {
    const workspace =
      readRequiredHeader(request, "x-agent-gateway-workspace")
      ?? await this.resolveWorkspace();
    const state = await this.loadState();
    const url = new URL(request.url);
    const agentId = normalizeOptionalString(url.searchParams.get("agentId") ?? undefined);
    const windowCandidate = Number(url.searchParams.get("windowMinutes"));

    return jsonResponse({
      ok: true,
      data: buildMetricsSnapshot(workspace ?? "", state.metrics, {
        ...(agentId ? { agentId } : {}),
        ...(Number.isFinite(windowCandidate) ? { windowMinutes: windowCandidate } : {}),
      }),
    });
  }

  private async handleInternalCostIngest(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as
      | {
          agentId?: unknown;
          eventType?: unknown;
          costUsd?: unknown;
          inputTokens?: unknown;
          outputTokens?: unknown;
          occurredAt?: unknown;
        }
      | null;

    const agentId = normalizeOptionalString(body?.agentId);
    const eventType = normalizeOptionalString(body?.eventType);
    const costUsd = typeof body?.costUsd === "number" ? body.costUsd : Number(body?.costUsd);
    const inputTokens = typeof body?.inputTokens === "number" ? body.inputTokens : Number(body?.inputTokens);
    const outputTokens = typeof body?.outputTokens === "number" ? body.outputTokens : Number(body?.outputTokens);
    const occurredAt = normalizeOptionalString(body?.occurredAt);

    if (!agentId || !eventType || !Number.isFinite(costUsd) || costUsd < 0) {
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "bad_request",
            message: "agentId, eventType, and non-negative costUsd are required",
          },
        },
        { status: 400 },
      );
    }

    const state = await this.loadState();
    recordCostMetric(ensureMetricsState(state), {
      agentId,
      eventType,
      costUsd,
      ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
      ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
      ...(occurredAt ? { ts: occurredAt } : {}),
    });
    await this.saveState(state);

    return jsonResponse({ ok: true });
  }

  private recordAttemptDurationMetric(
    state: WorkspaceState,
    agentId: string,
    entry: DeliveryRecord | undefined,
  ): void {
    if (!entry?.inflightAt) {
      return;
    }

    const startedAtMs = Date.parse(entry.inflightAt);
    if (!Number.isFinite(startedAtMs)) {
      return;
    }

    recordDurationMetric(ensureMetricsState(state), {
      agentId,
      eventType: entry.event.type,
      durationMs: Date.now() - startedAtMs,
    });
  }

  private async resolveStartupReason(
    agentId: string,
  ): Promise<"cold-start" | "redeploy"> {
    const state = await this.loadState();
    return state.agents[agentId] ? "redeploy" : "cold-start";
  }

  private async enqueueStartupEvent(
    agentId: string,
    workspace: string,
    reason: "cold-start" | "redeploy",
  ): Promise<void> {
    const event = await buildStartupEnvelope({
      workspace,
      agentId,
      reason,
    });
    await this.enqueueEvent(agentId, event);
  }

  private async assertWorkspaceBinding(workspace: string): Promise<void> {
    const state = await this.loadState();
    this.assertStateWorkspace(state, workspace);
  }

  private assertStateWorkspace(state: WorkspaceState, workspace: string | undefined): void {
    const expected = state.workspace?.trim();
    const received = workspace?.trim();
    if (expected && received && expected !== received) {
      throw new Error(
        `workspace mismatch for durable object: expected ${expected}, received ${received}`,
      );
    }
  }
}

function normalizeScheduleArray(
  value: ScheduleSpec | ScheduleSpec[] | undefined,
): ScheduleSpec[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readRequiredHeader(request: Request, name: string): string {
  return request.headers.get(name)?.trim() || "";
}

function readSocketAttachment(ws: WebSocket): SocketAttachment | null {
  try {
    const attachment = ws.deserializeAttachment?.() as unknown;
    if (
      typeof attachment === "object" &&
      attachment !== null
    ) {
      return {
        workspace:
          typeof (attachment as { workspace?: unknown }).workspace === "string"
            ? (attachment as { workspace: string }).workspace
            : undefined,
        agentId:
          typeof (attachment as { agentId?: unknown }).agentId === "string"
            ? (attachment as { agentId: string }).agentId
            : undefined,
        agentName:
          typeof (attachment as { agentName?: unknown }).agentName === "string"
            ? (attachment as { agentName: string }).agentName
            : undefined,
        authenticated:
          typeof (attachment as { authenticated?: unknown }).authenticated === "boolean"
            ? (attachment as { authenticated: boolean }).authenticated
            : false,
        legacyProtocol:
          typeof (attachment as { legacyProtocol?: unknown }).legacyProtocol === "boolean"
            ? (attachment as { legacyProtocol: boolean }).legacyProtocol
            : false,
        role:
          (attachment as { role?: unknown }).role === "observer"
          || (attachment as { role?: unknown }).role === "agent"
            ? (attachment as { role: "agent" | "observer" }).role
            : undefined,
      };
    }
  } catch {
    // Ignore sockets without attachments.
  }
  return null;
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { workspace?: unknown }).workspace === "string" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { occurredAt?: unknown }).occurredAt === "string" &&
    typeof (value as { attempt?: unknown }).attempt === "number" &&
    typeof (value as { resource?: unknown }).resource === "object"
  );
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function resolveSubscribedWorkspace(
  message: Extract<ClientMessage, { type: "subscribe" }>,
  attachment: SocketAttachment | null,
  claims: RelayAuthTokenClaims,
): string {
  const requested =
    typeof message.workspace === "string" && message.workspace.trim()
      ? message.workspace.trim()
      : attachment?.workspace?.trim();
  const workspace = claims.wks.trim();

  if (requested && requested !== workspace) {
    throw new Error(
      `workspace mismatch: requested ${requested} but token is bound to ${workspace}`,
    );
  }

  return requested || workspace;
}

function sanitizeAgentId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "agent").slice(0, 96);
}

function normalizeWatchRegistrations(value: unknown): WatchRegistration[] {
  if (value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    return [createWatchRegistration(value, "none", DEFAULT_WATCH_COALESCE_MS)];
  }

  if (Array.isArray(value)) {
    return dedupeWatchRegistrations(value.flatMap((entry) => normalizeWatchRegistrations(entry)));
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as {
    glob?: unknown;
    globs?: unknown;
    path?: unknown;
    paths?: unknown;
    replayOnStart?: unknown;
    replay?: unknown;
    coalesceMs?: unknown;
    maxBacklog?: unknown;
    handlerTimeoutMs?: unknown;
  };
  const rawGlobs = record.glob ?? record.globs ?? record.path ?? record.paths;
  const replayOnStart = normalizeReplayOnStartValue(record.replayOnStart ?? record.replay);
  const coalesceMs = normalizeCoalesceMs(record.coalesceMs);
  const maxBacklog = normalizeMaxBacklog(record.maxBacklog);
  const handlerTimeoutMs = normalizeHandlerTimeoutMs(record.handlerTimeoutMs);
  const globs = Array.isArray(rawGlobs) ? rawGlobs : [rawGlobs];

  return dedupeWatchRegistrations(
    globs
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((glob) => createWatchRegistration(glob, replayOnStart, coalesceMs, maxBacklog, handlerTimeoutMs)),
  );
}

function normalizeInboxRegistrations(value: unknown): InboxRegistration[] {
  if (value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    const registration = createInboxRegistration(value);
    return registration ? [registration] : [];
  }

  if (Array.isArray(value)) {
    return dedupeInboxRegistrations(value.flatMap((entry) => normalizeInboxRegistrations(entry)));
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as {
    selector?: unknown;
    selectors?: unknown;
    channel?: unknown;
    channels?: unknown;
  };
  const rawSelectors =
    record.selector
    ?? record.selectors
    ?? record.channel
    ?? record.channels;
  const selectors = Array.isArray(rawSelectors) ? rawSelectors : [rawSelectors];

  return dedupeInboxRegistrations(
    selectors
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .flatMap((selector) => {
        const registration = createInboxRegistration(selector);
        return registration ? [registration] : [];
      }),
  );
}

function createWatchRegistration(
  glob: string,
  replayOnStart: ReplayOnStart,
  coalesceMs: number,
  maxBacklog?: number,
  handlerTimeoutMs?: number,
): WatchRegistration {
  const trimmed = glob.trim();
  return {
    glob: trimmed.startsWith("/") ? trimmed : `/${trimmed}`,
    replayOnStart,
    coalesceMs,
    ...(maxBacklog !== undefined ? { maxBacklog } : {}),
    ...(handlerTimeoutMs !== undefined ? { handlerTimeoutMs } : {}),
  };
}

function createInboxRegistration(selector: string): InboxRegistration | null {
  const trimmed = selector.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "@self") {
    return { selector: "@self" };
  }
  if (trimmed.startsWith("@")) {
    return null;
  }
  return {
    selector: trimmed.startsWith("#") ? trimmed.slice(1) : trimmed,
  };
}

function dedupeWatchRegistrations(
  registrations: WatchRegistration[],
): WatchRegistration[] {
  const seen = new Set<string>();
  const deduped: WatchRegistration[] = [];
  for (const registration of registrations) {
    const key = [
      registration.glob,
      registration.replayOnStart,
      registration.coalesceMs,
      registration.maxBacklog ?? "",
      registration.handlerTimeoutMs ?? "",
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(registration);
  }
  return deduped;
}

function dedupeInboxRegistrations(
  registrations: InboxRegistration[],
): InboxRegistration[] {
  const seen = new Set<string>();
  const deduped: InboxRegistration[] = [];
  for (const registration of registrations) {
    if (seen.has(registration.selector)) {
      continue;
    }
    seen.add(registration.selector);
    deduped.push(registration);
  }
  return deduped;
}

function addAgentDeliveryIdentities(
  identities: Set<string>,
  agent: Pick<AgentRecord, "agentId" | "agentName">,
): void {
  identities.add(`id:${agent.agentId}`);
  if (agent.agentName.trim()) {
    identities.add(`name:${agent.agentName.trim().toLowerCase()}`);
  }
}

function candidateInboxIdentityMatches(
  candidate: InboxDeploymentCandidate,
  identities: ReadonlySet<string>,
): boolean {
  if (identities.has(`id:${candidate.agentId}`)) {
    return true;
  }
  const deployedName = candidate.deployedName?.trim().toLowerCase();
  return Boolean(deployedName && identities.has(`name:${deployedName}`));
}

function relaycastEventFromMatchesAgent(
  event: RelaycastInboxMessageEvent,
  agent: Pick<AgentRecord, "agentId" | "agentName">,
): boolean {
  return relaycastActorMatchesIdentity(event.from, {
    id: agent.agentId,
    name: agent.agentName,
  });
}

function relaycastEventFromMatchesDeployment(
  event: RelaycastInboxMessageEvent,
  candidate: InboxDeploymentCandidate,
): boolean {
  return relaycastActorMatchesIdentity(event.from, {
    id: candidate.agentId,
    name: candidate.deployedName ?? undefined,
  });
}

function relaycastActorMatchesIdentity(
  actor: RelaycastInboxMessageEvent["from"],
  identity: { id: string; name?: string },
): boolean {
  const actorId = actor?.id?.trim();
  if (actorId && actorId === identity.id) {
    return true;
  }
  const actorName = actor?.displayName?.trim().toLowerCase();
  const identityName = identity.name?.trim().toLowerCase();
  return Boolean(actorName && identityName && actorName === identityName);
}

function normalizeReplayOnStartValue(value: unknown): ReplayOnStart {
  if (typeof value !== "string") {
    return "none";
  }
  const parsed = parseReplayOnStart(value);
  switch (parsed.kind) {
    case "last":
      return `last:${parsed.count}`;
    case "since":
      return `since:${parsed.sinceIso}`;
    default:
      return "none";
  }
}

function normalizeCoalesceMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_WATCH_COALESCE_MS;
  }
  return Math.floor(value);
}

function normalizeMaxBacklog(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.floor(value);
}

function normalizeHandlerTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.floor(value);
}

function normalizeWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeSemantics(
  value: unknown,
): {
  properties?: Record<string, string>;
  relations?: string[];
  permissions?: string[];
  comments?: string[];
} | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const semantics = {
    ...(normalizeStringMap(record.properties)
      ? { properties: normalizeStringMap(record.properties) }
      : {}),
    ...(normalizeStringArray(record.relations)
      ? { relations: normalizeStringArray(record.relations) }
      : {}),
    ...(normalizeStringArray(record.permissions)
      ? { permissions: normalizeStringArray(record.permissions) }
      : {}),
    ...(normalizeStringArray(record.comments)
      ? { comments: normalizeStringArray(record.comments) }
      : {}),
  };

  return Object.keys(semantics).length > 0 ? semantics : undefined;
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key.trim(), typeof item === "string" ? item.trim() : String(item)] as const)
    .filter(([key, item]) => key.length > 0 && item.length > 0);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : undefined;
}

function normalizeContentIdentity(
  value: unknown,
): { kind: string; key: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const kind = normalizeOptionalString(record.kind);
  const key = normalizeOptionalString(record.key);
  return kind && key ? { kind, key } : undefined;
}

function serializeGatewayWriteBody(
  body: unknown,
  meta: Record<string, unknown> | undefined,
): {
  content: string;
  contentType?: string;
  encoding?: "utf-8" | "base64";
  semantics?: {
    properties?: Record<string, string>;
    relations?: string[];
    permissions?: string[];
    comments?: string[];
  };
  contentIdentity?: { kind: string; key: string };
} {
  const contentType = normalizeOptionalString(meta?.contentType);
  const encoding = meta?.encoding === "utf-8" || meta?.encoding === "base64"
    ? meta.encoding
    : undefined;
  const semantics = normalizeSemantics(meta?.semantics);
  const contentIdentity = normalizeContentIdentity(meta?.contentIdentity);

  if (typeof body === "string") {
    return {
      content: body,
      ...(contentType ? { contentType } : {}),
      ...(encoding ? { encoding } : {}),
      ...(semantics ? { semantics } : {}),
      ...(contentIdentity ? { contentIdentity } : {}),
    };
  }

  return {
    content: JSON.stringify(body),
    contentType: contentType ?? "application/json",
    encoding: encoding ?? "utf-8",
    ...(semantics ? { semantics } : {}),
    ...(contentIdentity ? { contentIdentity } : {}),
  };
}

function globToQueryPrefix(glob: string): string {
  const normalized = normalizeWorkspacePath(glob) ?? "/";
  const wildcardIndex = normalized.search(/[*?[{]/);
  if (wildcardIndex < 0) {
    return normalized;
  }

  const prefix = normalized.slice(0, wildcardIndex);
  const lastSlash = prefix.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }

  return prefix.slice(0, lastSlash) || "/";
}

function readPathGlobsFromAccessToken(
  token: string | undefined,
): string[] | undefined {
  if (!token?.trim()) {
    return undefined;
  }

  const claims = decodeJwtPayload(token);
  const meta = claims?.meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return undefined;
  }

  const raw = (meta as Record<string, unknown>).pathGlobs;
  const parsed = typeof raw === "string"
    ? safeJsonParse(raw)
    : raw;
  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const globs = parsed
    .map((value) => normalizeWorkspacePath(value))
    .filter((value): value is string => Boolean(value));
  return globs.length > 0 ? globs : undefined;
}

function isRelayfilePathAllowed(
  path: string,
  pathGlobs: string[] | undefined,
): boolean {
  if (!pathGlobs || pathGlobs.length === 0) {
    return true;
  }

  return pathGlobs.some((glob) => matchesWatchGlob(path, glob));
}

function buildPathScopeErrorMessage(
  path: string,
  pathGlobs: string[] | undefined,
): string {
  if (!pathGlobs || pathGlobs.length === 0) {
    return `Path ${path} is not permitted for this token`;
  }

  return `Path ${path} is outside the token path globs: ${pathGlobs.join(", ")}`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readOnceLock(value: unknown): { acquiredAt?: string; expiresAt?: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as { acquiredAt?: string; expiresAt?: string };
}

function isExpiredOnceLock(value: { expiresAt?: string }): boolean {
  const expiresAtMs = Date.parse(value.expiresAt ?? "");
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function resolveRelaycastBaseUrl(baseUrl: string | undefined): string {
  const normalized = baseUrl?.trim() || DEFAULT_RELAYCAST_URL;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

async function readRelaycastError(response: Response, path: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string }; message?: string }
    | null;
  const code = payload?.error?.code?.trim();
  const message = payload?.error?.message?.trim() || payload?.message?.trim();
  const error = new Error(
    message
      ? `relaycast request failed (${response.status}) ${path}: ${message}`
      : `relaycast request failed (${response.status}) ${path}`,
  ) as Error & { code?: string };
  if (code) {
    error.code = code;
  }
  return error;
}

function readApprovalIdFromPath(path: string): string | undefined {
  const match = /^\/approvals\/([^/]+)\.json$/u.exec(path.trim());
  return match?.[1];
}

function parseApprovalFile(content: unknown): Record<string, unknown> {
  if (typeof content === "string") {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }

  throw new Error("approval file did not contain a valid JSON object");
}

function collectWorkspaceWatchGlobs(state: WorkspaceState): string[] {
  return [...new Set(
    Object.values(state.agents)
      .flatMap((agent) => agent.watches ?? [])
      .map((watch) => watch.glob),
  )];
}

function collectWorkspaceInboxRegistrations(state: WorkspaceState): RelaycastInboxRegistration[] {
  return Object.values(state.agents)
    .filter((agent) =>
      Boolean(agent.accessToken?.trim()) && (agent.inbox?.length ?? 0) > 0,
    )
    .map((agent) => ({
      agentId: agent.agentId,
      accessToken: agent.accessToken!.trim(),
      selectors: (agent.inbox ?? []).map((registration) => registration.selector),
    }));
}

function firstWorkspaceFromState(state: WorkspaceState): string | undefined {
  return Object.values(state.agents)[0]?.workspace;
}

function matchesWatchGlob(path: string, glob: string): boolean {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const normalizedGlob = glob.startsWith("/") ? glob : `/${glob}`;
  return (
    minimatch(normalizedPath, normalizedGlob, { dot: true })
    || minimatch(normalizedPath.slice(1), normalizedGlob.slice(1), { dot: true })
    || matchesSlackChannelAliasGlob(normalizedPath, normalizedGlob)
  );
}

function matchesSlackChannelAliasGlob(path: string, glob: string): boolean {
  const parsedPath = parseSlackChannelPath(path);
  const parsedGlob = parseSlackChannelPath(glob);
  if (!parsedPath || !parsedGlob || parsedPath.channelId !== parsedGlob.channelId) {
    return false;
  }

  if (parsedPath.segment === parsedGlob.segment) {
    return false;
  }

  const candidate = `/slack/channels/${parsedGlob.segment}${parsedPath.suffix}`;
  return (
    minimatch(candidate, glob, { dot: true })
    || minimatch(candidate.slice(1), glob.slice(1), { dot: true })
  );
}

function slackAliasReadCandidatesFromPathGlobs(
  path: string,
  pathGlobs: string[] | undefined,
): string[] {
  const parsedPath = parseSlackChannelPath(path);
  if (!parsedPath || parsedPath.segment.includes("__") || !pathGlobs?.length) {
    return [];
  }

  const candidates = new Set<string>();
  for (const glob of pathGlobs) {
    const parsedGlob = parseSlackChannelPath(glob);
    if (
      !parsedGlob
      || parsedGlob.channelId !== parsedPath.channelId
      || !parsedGlob.segment.includes("__")
    ) {
      continue;
    }

    const candidate = `/slack/channels/${parsedGlob.segment}${parsedPath.suffix}`;
    if (matchesWatchGlob(candidate, glob)) {
      candidates.add(candidate);
    }
  }

  return [...candidates];
}

function parseSlackChannelPath(path: string): {
  segment: string;
  channelId: string;
  suffix: string;
} | null {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const match = normalized.match(/^\/slack\/channels\/([^/*?[{\]/]+)(\/.*)?$/u);
  if (!match?.[1]) {
    return null;
  }

  const segment = match[1];
  const channelId = segment.split("__", 1)[0];
  if (!/^[A-Z0-9]+$/u.test(channelId)) {
    return null;
  }

  return {
    segment,
    channelId,
    suffix: match[2] ?? "",
  };
}

function normalizeVfsWatchEvent(input: Partial<VfsWatchEvent> | null): VfsWatchEvent | null {
  const workspaceId = typeof input?.workspaceId === "string" ? input.workspaceId.trim() : "";
  const path = typeof input?.path === "string" ? input.path.trim() : "";
  const writeId = typeof input?.writeId === "string" ? input.writeId.trim() : "";
  const occurredAt = typeof input?.occurredAt === "string" ? input.occurredAt.trim() : "";
  if (!workspaceId || !path || !writeId || !occurredAt) {
    return null;
  }
  return {
    workspaceId,
    path: path.startsWith("/") ? path : `/${path}`,
    writeId,
    occurredAt,
    ...(typeof input?.provider === "string" && input.provider.trim()
      ? { provider: input.provider.trim() }
      : {}),
    ...(typeof input?.eventType === "string" && input.eventType.trim()
      ? { eventType: input.eventType.trim() }
      : {}),
    ...(typeof input?.connectionId === "string" && input.connectionId.trim()
      ? { connectionId: input.connectionId.trim() }
      : {}),
    ...(input && "payload" in input ? { payload: input.payload } : {}),
  };
}

function scheduleFingerprint(
  schedule: RegisteredCronSchedule | ReturnType<typeof normalizeScheduleSpec>,
): string {
  return [
    schedule.scheduleType,
    schedule.schedule,
    schedule.timezone,
    schedule.cronExpression ?? "",
    schedule.scheduledAt ?? "",
  ].join("|");
}

function shouldRefreshAgentToken(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return parsed - Date.now() <= AGENT_TOKEN_REFRESH_WINDOW_MS;
}

function isTokenExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return true;
  }
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    return true;
  }
  return parsed <= Date.now();
}

function getAgentTokenRefreshDueMs(expiresAt: string | undefined): number {
  if (!expiresAt) {
    return Number.NaN;
  }

  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    return Number.NaN;
  }

  return parsed - AGENT_TOKEN_REFRESH_WINDOW_MS;
}

function shouldRunTokenIntrospection(lastCheckedAt: string | undefined): boolean {
  if (!lastCheckedAt) {
    return true;
  }

  const parsed = Date.parse(lastCheckedAt);
  if (!Number.isFinite(parsed)) {
    return true;
  }

  return Date.now() - parsed >= TOKEN_MAINTENANCE_INTERVAL_MS;
}

function canIntrospectAgentToken(token: string | undefined): boolean {
  if (!token?.trim()) {
    return false;
  }

  const claims = decodeJwtPayload(token);
  const scopes = claims?.scopes;
  return Array.isArray(scopes) && scopes.includes(RELAYAUTH_TOKEN_READ_SCOPE);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function dedupeRegisteredSchedules(
  schedules: RegisteredCronSchedule[],
): RegisteredCronSchedule[] {
  const seen = new Set<string>();
  const deduped: RegisteredCronSchedule[] = [];
  for (const schedule of schedules) {
    if (seen.has(schedule.gatewayScheduleId)) {
      continue;
    }
    seen.add(schedule.gatewayScheduleId);
    deduped.push(schedule);
  }
  return deduped;
}

async function cancelRegisteredCronSchedulesBestEffort(
  env: RelaycronEnv,
  schedules: RegisteredCronSchedule[],
): Promise<void> {
  await Promise.allSettled(
    schedules.map((schedule) => cancelCronSchedule(env, schedule.relaycronScheduleId)),
  );
}

function normalizeStructuredLogEntry(
  entry: StructuredLogEntry | null | undefined,
  binding: { workspace: string; agentId: string },
): StructuredLogEntry {
  const timestamp = typeof entry?.ts === "string" && entry.ts.trim()
    ? entry.ts
    : new Date().toISOString();
  const level = normalizeLogLevel(entry?.level);
  const msg = typeof entry?.msg === "string" && entry.msg.trim()
    ? entry.msg
    : "log";

  return {
    ts: timestamp,
    level,
    workspace: binding.workspace,
    agentId: binding.agentId,
    ...(typeof entry?.eventId === "string" && entry.eventId.trim()
      ? { eventId: entry.eventId }
      : {}),
    msg,
    ...sanitizeStructuredLogMeta(entry),
  };
}

function sanitizeStructuredLogMeta(
  entry: StructuredLogEntry | null | undefined,
): Record<string, unknown> {
  if (!entry || typeof entry !== "object") {
    return {};
  }

  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (
      key === "ts"
      || key === "level"
      || key === "workspace"
      || key === "agentId"
      || key === "eventId"
      || key === "msg"
    ) {
      continue;
    }
    meta[key] = value;
  }
  return meta;
}

function normalizeLogLevel(level: StructuredLogEntry["level"] | undefined): StructuredLogEntry["level"] {
  switch (level) {
    case "debug":
    case "warn":
    case "error":
      return level;
    case "info":
    default:
      return "info";
  }
}

function buildWorkspaceLogPath(workspace: string, timestamp: string): string {
  const date = toIsoDate(timestamp);
  return `/_logs/${encodeURIComponent(workspace)}/${date}.jsonl`;
}

function toIsoDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function matchInspectorAgentPath(
  pathname: string,
): { agentId: string; events: boolean } | null {
  const match = pathname.match(/^\/agents\/([^/]+)(?:\/(events))?$/);
  if (!match) {
    return null;
  }

  const agentId = decodeURIComponent(match[1] ?? "").trim();
  if (!agentId) {
    return null;
  }
  return {
    agentId,
    events: match[2] === "events",
  };
}

function isRelayfileNotFound(error: unknown): boolean {
  return isRelayFileApiError(error) && error.status === 404;
}
