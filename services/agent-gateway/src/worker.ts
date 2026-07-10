import { createHmac, timingSafeEqual } from "node:crypto";
import {
  authenticateWorkspaceRequest,
  authenticateInternalRequest,
  authenticateWebSocketRequest,
} from "./auth.js";
import { buildCronTickEnvelope, type AgentEvent } from "./envelope-builder.js";
import { WorkspaceGatewayDO } from "./durable-object.js";
import {
  injectTraceContextIntoHeaders,
  instrumentGatewayDurableObject,
  instrumentGatewayWorker,
  withGatewaySpan,
} from "./otel.js";
import { RelayFileClient } from "@relayfile/sdk";

type Env = {
  WORKSPACE_GATEWAY_DO: DurableObjectNamespace;
  CLOUD_WEB_WORKER?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  PROACTIVE_RUNTIME_WORKER?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  RELAYAUTH_URL: string;
  RELAYFILE_URL?: string;
  RELAYCAST_URL?: string;
  RELAYCRON_URL?: string;
  RELAYCRON_API_KEY?: string;
  RELAY_AGENT_AUDIENCE?: string;
  AGENT_GATEWAY_BASE_URL: string;
  AGENT_GATEWAY_INTERNAL_SECRET: string;
  RELAYFILE_INTERNAL_HMAC_SECRET?: string;
  OTEL_SERVICE_NAME?: string;
  RELAY_OTEL_ENABLED?: string;
  RELAY_OTEL_EXPORTER?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_EXPORTER_OTLP_TRACES_HEADERS?: string;
};

type RawCronIngressPayload = {
  workspace?: unknown;
  agentId?: unknown;
  gatewayScheduleId?: unknown;
  schedule?: unknown;
  scheduledFor?: unknown;
  occurredAt?: unknown;
  executionId?: unknown;
};

type RawCostIngressPayload = {
  agentId?: unknown;
  eventType?: unknown;
  costUsd?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  occurredAt?: unknown;
};

type RawVfsWatchPayload = {
  workspaceId?: unknown;
  workspace?: unknown;
  path?: unknown;
  writeId?: unknown;
  occurredAt?: unknown;
  provider?: unknown;
  eventType?: unknown;
  connectionId?: unknown;
  payload?: unknown;
};

const InstrumentedWorkspaceGatewayDO = instrumentGatewayDurableObject(
  WorkspaceGatewayDO,
);

export { InstrumentedWorkspaceGatewayDO as WorkspaceGatewayDO };

export default instrumentGatewayWorker({
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ status: "ok" });
      }

      if (request.method === "GET" && url.pathname === "/ws") {
        return handleWebSocketUpgrade(request, env);
      }

      if (request.method === "GET" && url.pathname === "/v1/agent-events") {
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
          return handleLegacyEventWebSocketUpgrade(request, env);
        }
        return handleLegacyEventLongPoll(request, env);
      }

      if (request.method === "POST" && url.pathname === "/internal/cron/tick") {
        return handleCronTickIngress(request, env);
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/internal/vfs/watch" || url.pathname === "/internal/vfs-watch")
      ) {
        return handleVfsWatchIngress(request, env);
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/internal/vfs-dedupe/check" ||
          url.pathname === "/internal/vfs-dedupe/record" ||
          url.pathname === "/internal/vfs-dedupe/claim" ||
          url.pathname === "/internal/vfs-dedupe/release")
      ) {
        return handleVfsDedupeBroker(request, env);
      }

      if (
        request.method === "GET" &&
        url.pathname.startsWith("/v1/workspaces/") &&
        url.pathname.endsWith("/metrics")
      ) {
        return handleWorkspaceMetricsRequest(request, env);
      }

      if (
        request.method === "GET" &&
        /^\/v1\/workspaces\/[^/]+\/agents(?:\/|$)/.test(url.pathname)
      ) {
        return handleWorkspaceAgentsRequest(request, env);
      }

      if (
        request.method === "GET" &&
        /^\/v1\/workspaces\/[^/]+\/dlq(?:\/|$)/.test(url.pathname) &&
        !/^\/v1\/workspaces\/[^/]+\/dlq\/[^/]+\/replay$/.test(url.pathname)
      ) {
        return handleWorkspaceDlqReadRequest(request, env);
      }

      if (
        request.method === "POST" &&
        /^\/v1\/workspaces\/[^/]+\/dlq\/[^/]+\/replay$/.test(url.pathname)
      ) {
        return handleWorkspaceDlqReplayRequest(request, env);
      }

      if (
        request.method === "DELETE" &&
        /^\/v1\/workspaces\/[^/]+\/dlq(?:\/|$)/.test(url.pathname)
      ) {
        return handleWorkspaceDlqPurgeRequest(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname.startsWith("/internal/workspaces/") &&
        url.pathname.endsWith("/costs")
      ) {
        return handleWorkspaceCostIngress(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname.startsWith("/v1/workspaces/") &&
        url.pathname.endsWith("/events")
      ) {
        return handleLegacyCronEventIngress(request, env);
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/v1/watch" || url.pathname === "/v1/inbox")
      ) {
        const message =
          url.pathname === "/v1/watch"
            ? "watch registration is handled over the gateway websocket in M2"
            : "inbox registration is handled over the gateway websocket in M3";
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "not_implemented",
              message,
            },
          },
          { status: 501 },
        );
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
    } catch (error) {
      const status = isHttpError(error) ? error.status : 500;
      const code = isHttpError(error) ? error.code : "internal_error";
      const message =
        error instanceof Error ? error.message : "internal server error";

      return jsonResponse(
        {
          ok: false,
          error: {
            code,
            message,
          },
        },
        { status },
      );
    }
  },
});

async function handleWebSocketUpgrade(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: "Expected WebSocket upgrade",
        },
      },
      { status: 426 },
    );
  }

  const session = await authenticateWebSocketRequest(request, env);
  const stub = getWorkspaceStub(env, session.workspace);

  const headers = new Headers(request.headers);
  headers.set("x-agent-gateway-workspace", session.workspace);
  headers.set("x-agent-gateway-agent-id", session.agentId);
  headers.set("x-agent-gateway-agent-name", session.agentName);
  headers.set(
    "x-agent-gateway-agent-token",
    session.issuedAgentToken.accessToken,
  );
  headers.set(
    "x-agent-gateway-refresh-token",
    session.issuedAgentToken.refreshToken,
  );
  headers.set(
    "x-agent-gateway-access-token-expires-at",
    session.issuedAgentToken.accessTokenExpiresAt,
  );
  headers.set(
    "x-agent-gateway-refresh-token-expires-at",
    session.issuedAgentToken.refreshTokenExpiresAt,
  );
  headers.delete("authorization");

  return stub.fetch(
    new Request("https://agent-gateway.internal/ws", {
      method: "GET",
      headers,
    }),
  );
}

async function handleLegacyEventWebSocketUpgrade(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: "Expected WebSocket upgrade",
        },
      },
      { status: 426 },
    );
  }

  const url = new URL(request.url);
  const workspace = url.searchParams.get("workspace")?.trim();
  if (!workspace) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: "workspace query parameter is required",
        },
      },
      { status: 400 },
    );
  }

  const agentId = url.searchParams.get("agentId")?.trim();
  const headers = new Headers(request.headers);
  headers.set("x-agent-gateway-workspace", workspace);
  headers.set("x-agent-gateway-legacy-protocol", "1");
  if (agentId) {
    headers.set("x-agent-gateway-agent-id", agentId);
    headers.set("x-agent-gateway-agent-name", agentId);
  }

  return getWorkspaceStub(env, workspace).fetch(
    new Request("https://agent-gateway.internal/ws", {
      method: "GET",
      headers,
    }),
  );
}

async function handleLegacyEventLongPoll(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await authenticateWebSocketRequest(request, env);
  const headers = new Headers();
  headers.set("x-agent-gateway-workspace", session.workspace);
  headers.set("x-agent-gateway-agent-id", session.agentId);
  headers.set("x-agent-gateway-agent-name", session.agentName);

  return getWorkspaceStub(env, session.workspace).fetch(
    new Request("https://agent-gateway.internal/poll", {
      method: "GET",
      headers,
    }),
  );
}

async function handleCronTickIngress(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.cron.ingress",
    { attributes: { "relay.route": "/internal/cron/tick" } },
    async () => {
      authenticateInternalRequest(request, env);

      const body = (await request.json().catch(() => null)) as RawCronIngressPayload | null;
      const boundPayload = cronIngressQueryBinding(new URL(request.url));
      const deliveryId = readString(
        request.headers.get("x-agentcron-delivery")
          ?? request.headers.get("x-agent-cron-delivery")
          ?? undefined,
      );
      const payload = normalizeCronIngressPayload({ ...(body ?? {}), ...boundPayload });

      const event = await buildCronTickEnvelope({
        workspace: payload.workspace,
        scheduleId: payload.gatewayScheduleId,
        schedule: payload.schedule,
        scheduledFor: payload.scheduledFor,
        occurredAt: payload.occurredAt,
        executionId: payload.executionId ?? deliveryId,
      });

      return enqueueWorkspaceEvent(env, payload.workspace, payload.agentId, event);
    },
  );
}

function cronIngressQueryBinding(url: URL): Partial<RawCronIngressPayload> {
  return {
    ...(url.searchParams.has("workspace")
      ? { workspace: url.searchParams.get("workspace") }
      : {}),
    ...(url.searchParams.has("agent_id")
      ? { agentId: url.searchParams.get("agent_id") }
      : {}),
    ...(url.searchParams.has("gateway_schedule_id")
      ? { gatewayScheduleId: url.searchParams.get("gateway_schedule_id") }
      : {}),
    ...(url.searchParams.has("schedule")
      ? { schedule: url.searchParams.get("schedule") }
      : {}),
  };
}

async function handleVfsWatchIngress(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.vfs_watch.ingress",
    { attributes: { "relay.route": "/internal/vfs/watch" } },
    async () => {
      const rawBody = await request.text();
      if (!verifyRelayfileInternalRequest(request.headers, rawBody, env)) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "unauthorized",
              message: "Relayfile watch signature verification failed",
            },
          },
          { status: 401 },
        );
      }

      const body = JSON.parse(rawBody) as RawVfsWatchPayload;
      const payload = normalizeVfsWatchPayload(body);
      const stub = getWorkspaceStub(env, payload.workspaceId);
      return stub.fetch(
        new Request("https://agent-gateway.internal/internal/vfs-watch", {
          method: "POST",
          headers: injectTraceContextIntoHeaders(new Headers({
            "content-type": "application/json",
            "x-agent-gateway-workspace": payload.workspaceId,
          })),
          body: JSON.stringify(payload),
        }),
      );
    },
  );
}

async function handleVfsDedupeBroker(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.vfs_dedupe.broker",
    { attributes: { "relay.route": new URL(request.url).pathname } },
    async () => {
      authenticateInternalRequest(request, env);
      const rawBody = await request.text();
      const body = JSON.parse(rawBody) as { workspaceId?: unknown };
      const workspaceId = readString(body.workspaceId);
      if (!workspaceId) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "bad_request",
              message: "workspaceId is required",
            },
          },
          { status: 400 },
        );
      }

      const sourceUrl = new URL(request.url);
      const stub = getWorkspaceStub(env, workspaceId);
      return stub.fetch(
        new Request(`https://agent-gateway.internal${sourceUrl.pathname}`, {
          method: "POST",
          headers: injectTraceContextIntoHeaders(new Headers({
            "content-type": "application/json",
            "x-agent-gateway-workspace": workspaceId,
          })),
          body: rawBody,
        }),
      );
    },
  );
}

async function handleLegacyCronEventIngress(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.legacy_event.ingress",
    { attributes: { "relay.route": "/v1/workspaces/:workspace/agents/:agentId/events" } },
    async () => {
      const route = matchLegacyEventRoute(new URL(request.url).pathname);
      if (!route) {
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

      const isInternal = hasInternalSecret(request, env);
      if (!isInternal) {
        const session = await authenticateWorkspaceRequest(request, env);
        if (session.workspace !== route.workspace) {
          throw Object.assign(
            new Error(
              `workspace token is bound to ${session.workspace}, not ${route.workspace}`,
            ),
            {
              status: 403,
              code: "workspace_mismatch",
            },
          );
        }
      }

      const body = (await request.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      const schedule = readStringValue(body?.schedule)
        ?? readStringValue(body?.schedule_name)
        ?? readStringValue(body?.name)
        ?? "manual";
      const scheduledFor =
        readStringValue(body?.scheduledFor)
        ?? readStringValue(body?.fired_at)
        ?? readStringValue(body?.occurredAt)
        ?? new Date().toISOString();
      const scheduleId =
        readStringValue(body?.gatewayScheduleId)
        ?? readStringValue(body?.scheduleId)
        ?? readStringValue(body?.executionId)
        ?? deriveLegacyScheduleId(route.workspace, route.agentId, schedule);
      const executionId =
        readStringValue(body?.executionId)
        ?? readStringValue(body?.messageId)
        ?? undefined;

      const event = await buildCronTickEnvelope({
        workspace: route.workspace,
        scheduleId,
        schedule,
        scheduledFor,
        occurredAt: readStringValue(body?.occurredAt) ?? scheduledFor,
        executionId,
      });

      return enqueueWorkspaceEvent(env, route.workspace, route.agentId, event);
    },
  );
}

async function handleWorkspaceMetricsRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.metrics.read",
    { attributes: { "relay.route": "/v1/workspaces/:workspace/metrics" } },
    async () => {
      const route = matchWorkspaceMetricsRoute(new URL(request.url).pathname);
      if (!route) {
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

      const isInternal = hasInternalSecret(request, env);
      if (!isInternal) {
        const session = await authenticateWorkspaceRequest(request, env);
        if (session.workspace !== route.workspace) {
          throw Object.assign(
            new Error(
              `workspace token is bound to ${session.workspace}, not ${route.workspace}`,
            ),
            {
              status: 403,
              code: "workspace_mismatch",
            },
          );
        }
      }

      const stub = getWorkspaceStub(env, route.workspace);
      const sourceUrl = new URL(request.url);
      const targetUrl = new URL("https://agent-gateway.internal/metrics");
      targetUrl.search = sourceUrl.search;

      const response = await stub.fetch(
        new Request(targetUrl, {
          method: "GET",
          headers: injectTraceContextIntoHeaders(new Headers({
            "x-agent-gateway-workspace": route.workspace,
          })),
        }),
      );

      const payload = await response.json().catch(() => null);
      return jsonResponse(payload, { status: response.status });
    },
  );
}

async function handleWorkspaceAgentsRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.inspector.read",
    { attributes: { "relay.route": "/v1/workspaces/:workspace/agents" } },
    async () => {
      const route = matchWorkspaceAgentsRoute(new URL(request.url).pathname);
      if (!route) {
        return jsonResponse(notFoundPayload(), { status: 404 });
      }

      const isInternal = hasInternalSecret(request, env);
      if (!isInternal) {
        const session = await authenticateWorkspaceRequest(request, env);
        if (session.workspace !== route.workspace) {
          throw Object.assign(
            new Error(
              `workspace token is bound to ${session.workspace}, not ${route.workspace}`,
            ),
            {
              status: 403,
              code: "workspace_mismatch",
            },
          );
        }
      }

      const stub = getWorkspaceStub(env, route.workspace);
      const sourceUrl = new URL(request.url);
      const targetPath = route.agentId
        ? `/agents/${encodeURIComponent(route.agentId)}${route.events ? "/events" : ""}`
        : "/agents";
      const targetUrl = new URL(`https://agent-gateway.internal${targetPath}`);
      targetUrl.search = sourceUrl.search;

      const headers = injectTraceContextIntoHeaders(new Headers({
        "x-agent-gateway-workspace": route.workspace,
        ...(route.agentId ? { "x-agent-gateway-agent-id": route.agentId } : {}),
      }));
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        headers.set("Upgrade", "websocket");
      }

      return stub.fetch(
        new Request(targetUrl, {
          method: "GET",
          headers,
        }),
      );
    },
  );
}

async function handleWorkspaceCostIngress(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.metrics.cost_ingress",
    { attributes: { "relay.route": "/internal/workspaces/:workspace/costs" } },
    async () => {
      authenticateInternalRequest(request, env);

      const route = matchWorkspaceCostRoute(new URL(request.url).pathname);
      if (!route) {
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

      const body = (await request.json().catch(() => null)) as RawCostIngressPayload | null;
      const payload = {
        agentId: readString(body?.agentId),
        eventType: readString(body?.eventType),
        costUsd:
          typeof body?.costUsd === "number" ? body.costUsd : Number(body?.costUsd),
        inputTokens:
          typeof body?.inputTokens === "number"
            ? body.inputTokens
            : Number(body?.inputTokens),
        outputTokens:
          typeof body?.outputTokens === "number"
            ? body.outputTokens
            : Number(body?.outputTokens),
        occurredAt: readString(body?.occurredAt),
      };

      const stub = getWorkspaceStub(env, route.workspace);
      const response = await stub.fetch(
        new Request("https://agent-gateway.internal/internal/cost", {
          method: "POST",
          headers: injectTraceContextIntoHeaders(new Headers({
            "content-type": "application/json",
            "x-agent-gateway-workspace": route.workspace,
          })),
          body: JSON.stringify(payload),
        }),
      );

      const result = await response.json().catch(() => null);
      return jsonResponse(result, { status: response.status });
    },
  );
}

async function handleWorkspaceDlqReadRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.dlq.read",
    { attributes: { "relay.route": "/v1/workspaces/:workspace/dlq" } },
    async () => {
      const route = matchWorkspaceDlqRoute(new URL(request.url).pathname);
      if (!route) {
        return jsonResponse(notFoundPayload(), { status: 404 });
      }

      const session = await requireWorkspaceAccess(request, env, route.workspace);
      const client = createWorkspaceRelayFileClient(env, session.workspaceToken);

      if (route.eventId) {
        const file = await client.readFile(route.workspace, buildDlqFilePath(route.workspace, route.eventId));
        const record = parseJsonFile<Record<string, unknown>>(file.content);
        return jsonResponse({ ok: true, data: record });
      }

      const listing = await client.queryFiles(route.workspace, {
        path: buildDlqDirectoryPath(route.workspace),
        limit: 200,
      });
      const items = listing.items.map((item) => ({
        eventId: dlqEventIdFromPath(item.path),
        path: item.path,
        revision: item.revision,
        contentType: item.contentType,
        size: item.size,
        lastEditedAt: item.lastEditedAt,
      }));

      return jsonResponse({
        ok: true,
        data: {
          workspace: route.workspace,
          items,
          nextCursor: listing.nextCursor,
        },
      });
    },
  );
}

async function handleWorkspaceDlqReplayRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.dlq.replay",
    { attributes: { "relay.route": "/v1/workspaces/:workspace/dlq/:eventId/replay" } },
    async () => {
      const route = matchWorkspaceDlqReplayRoute(new URL(request.url).pathname);
      if (!route) {
        return jsonResponse(notFoundPayload(), { status: 404 });
      }

      const session = await requireWorkspaceAccess(request, env, route.workspace);
      const client = createWorkspaceRelayFileClient(env, session.workspaceToken);
      const file = await client.readFile(
        route.workspace,
        buildDlqFilePath(route.workspace, route.eventId),
      );
      const record = parseJsonFile<Record<string, unknown>>(file.content);
      const event = readDlqEvent(record);
      const agentId = readDlqAgentId(record);
      if (!event || !agentId) {
        throw Object.assign(
          new Error("DLQ record is missing event or agentId"),
          { status: 400, code: "invalid_dlq_record" },
        );
      }

      return await enqueueWorkspaceEvent(env, route.workspace, agentId, event);
    },
  );
}

async function handleWorkspaceDlqPurgeRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  return await withGatewaySpan(
    "agent.gateway.dlq.purge",
    { attributes: { "relay.route": "/v1/workspaces/:workspace/dlq" } },
    async () => {
      const route = matchWorkspaceDlqRoute(new URL(request.url).pathname);
      if (!route) {
        return jsonResponse(notFoundPayload(), { status: 404 });
      }

      const session = await requireWorkspaceAccess(request, env, route.workspace);
      const client = createWorkspaceRelayFileClient(env, session.workspaceToken);

      if (route.eventId) {
        const file = await client.readFile(
          route.workspace,
          buildDlqFilePath(route.workspace, route.eventId),
        );
        await client.deleteFile({
          workspaceId: route.workspace,
          path: file.path,
          baseRevision: file.revision,
        });
        return jsonResponse({ ok: true, data: { deleted: 1 } });
      }

      let deleted = 0;
      let cursor: string | null | undefined;
      do {
        const listing = await client.queryFiles(route.workspace, {
          path: buildDlqDirectoryPath(route.workspace),
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const item of listing.items) {
          await client.deleteFile({
            workspaceId: route.workspace,
            path: item.path,
            baseRevision: item.revision,
          });
          deleted += 1;
        }
        cursor = listing.nextCursor;
      } while (cursor);

      return jsonResponse({
        ok: true,
        data: {
          workspace: route.workspace,
          deleted,
        },
      });
    },
  );
}

async function enqueueWorkspaceEvent(
  env: Env,
  workspace: string,
  agentId: string,
  event: AgentEvent,
): Promise<Response> {
  const stub = getWorkspaceStub(env, workspace);

  const enqueueResponse = await stub.fetch(
    new Request("https://agent-gateway.internal/internal/enqueue", {
      method: "POST",
      headers: injectTraceContextIntoHeaders(new Headers({
        "content-type": "application/json",
      })),
      body: JSON.stringify({
        agentId,
        event,
      }),
    }),
  );

  const result = await enqueueResponse.json().catch(() => null);
  return jsonResponse(result, {
    status: enqueueResponse.status,
  });
}

function normalizeCronIngressPayload(
  payload: RawCronIngressPayload | null,
): {
  workspace: string;
  agentId: string;
  gatewayScheduleId: string;
  schedule: string;
  scheduledFor: string;
  occurredAt?: string;
  executionId?: string;
} {
  const workspace = readString(payload?.workspace);
  const agentId = readString(payload?.agentId);
  const gatewayScheduleId = readString(payload?.gatewayScheduleId);
  const schedule = readString(payload?.schedule);
  const occurredAt = readString(payload?.occurredAt);
  const executionId = readString(payload?.executionId);
  const scheduledFor =
    readString(payload?.scheduledFor)
    ?? occurredAt
    ?? new Date().toISOString();

  if (!workspace || !agentId || !gatewayScheduleId || !schedule) {
    throw Object.assign(
      new Error("workspace, agentId, gatewayScheduleId, and schedule are required"),
      {
        status: 400,
        code: "bad_request",
      },
    );
  }

  return {
    workspace,
    agentId,
    gatewayScheduleId,
    schedule,
    scheduledFor,
    ...(occurredAt ? { occurredAt } : {}),
    ...(executionId ? { executionId } : {}),
  };
}

function normalizeVfsWatchPayload(payload: RawVfsWatchPayload | null): {
  workspaceId: string;
  path: string;
  writeId: string;
  occurredAt: string;
  provider?: string;
  eventType?: string;
  connectionId?: string;
  payload?: unknown;
} {
  const workspaceId = readString(payload?.workspaceId) ?? readString(payload?.workspace);
  const path = readString(payload?.path);
  const writeId = readString(payload?.writeId);
  const occurredAt = readString(payload?.occurredAt);
  if (!workspaceId || !path || !writeId || !occurredAt) {
    throw Object.assign(
      new Error("workspaceId, path, writeId, and occurredAt are required"),
      {
        status: 400,
        code: "bad_request",
      },
    );
  }

  return {
    workspaceId,
    path: path.startsWith("/") ? path : `/${path}`,
    writeId,
    occurredAt,
    ...(readString(payload?.provider) ? { provider: readString(payload?.provider) } : {}),
    ...(readString(payload?.eventType) ? { eventType: readString(payload?.eventType) } : {}),
    ...(readString(payload?.connectionId) ? { connectionId: readString(payload?.connectionId) } : {}),
    ...(payload && "payload" in payload ? { payload: payload.payload } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function verifyRelayfileInternalRequest(
  headers: Headers,
  rawBody: string,
  env: Env,
): boolean {
  const secret = env.RELAYFILE_INTERNAL_HMAC_SECRET?.trim();
  const timestamp = headers.get("x-relay-timestamp")?.trim() ?? "";
  const signature = headers.get("x-relay-signature")?.trim().toLowerCase() ?? "";
  if (!secret || !timestamp || !signature) {
    return false;
  }

  const parsedTimestampMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedTimestampMs)) {
    return false;
  }
  if (Math.abs(Date.now() - parsedTimestampMs) > 5 * 60 * 1000) {
    return false;
  }

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}\n${rawBody}`).digest("hex"),
    "utf8",
  );
  const provided = Buffer.from(signature, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isHttpError(
  value: unknown,
): value is Error & { status: number; code: string } {
  return (
    value instanceof Error &&
    typeof (value as { status?: unknown }).status === "number" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function getWorkspaceStub(
  env: Env,
  workspace: string,
): DurableObjectStub {
  return env.WORKSPACE_GATEWAY_DO.get(
    env.WORKSPACE_GATEWAY_DO.idFromName(workspace),
  );
}

function matchLegacyEventRoute(
  pathname: string,
): { workspace: string; agentId: string } | null {
  const match = pathname.match(
    /^\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)\/events$/,
  );
  if (!match) {
    return null;
  }

  const workspace = decodeURIComponent(match[1] ?? "").trim();
  const agentId = decodeURIComponent(match[2] ?? "").trim();
  if (!workspace || !agentId) {
    return null;
  }

  return { workspace, agentId };
}

function matchWorkspaceMetricsRoute(
  pathname: string,
): { workspace: string } | null {
  const match = pathname.match(/^\/v1\/workspaces\/([^/]+)\/metrics$/);
  if (!match) {
    return null;
  }

  const workspace = decodeURIComponent(match[1] ?? "").trim();
  return workspace ? { workspace } : null;
}

function matchWorkspaceAgentsRoute(
  pathname: string,
): { workspace: string; agentId?: string; events?: boolean } | null {
  const match = pathname.match(
    /^\/v1\/workspaces\/([^/]+)\/agents(?:\/([^/]+)(?:\/(events))?)?$/,
  );
  if (!match) {
    return null;
  }

  const workspace = decodeURIComponent(match[1] ?? "").trim();
  const agentId = decodeURIComponent(match[2] ?? "").trim() || undefined;
  if (!workspace) {
    return null;
  }
  return {
    workspace,
    ...(agentId ? { agentId } : {}),
    ...(match[3] === "events" ? { events: true } : {}),
  };
}

function matchWorkspaceDlqRoute(
  pathname: string,
): { workspace: string; eventId?: string } | null {
  const match = pathname.match(/^\/v1\/workspaces\/([^/]+)\/dlq(?:\/([^/]+))?$/);
  if (!match) {
    return null;
  }

  const workspace = decodeURIComponent(match[1] ?? "").trim();
  const eventId = decodeURIComponent(match[2] ?? "").trim() || undefined;
  return workspace ? { workspace, ...(eventId ? { eventId } : {}) } : null;
}

function matchWorkspaceDlqReplayRoute(
  pathname: string,
): { workspace: string; eventId: string } | null {
  const match = pathname.match(/^\/v1\/workspaces\/([^/]+)\/dlq\/([^/]+)\/replay$/);
  if (!match) {
    return null;
  }

  const workspace = decodeURIComponent(match[1] ?? "").trim();
  const eventId = decodeURIComponent(match[2] ?? "").trim();
  return workspace && eventId ? { workspace, eventId } : null;
}

function matchWorkspaceCostRoute(
  pathname: string,
): { workspace: string } | null {
  const match = pathname.match(/^\/internal\/workspaces\/([^/]+)\/costs$/);
  if (!match) {
    return null;
  }

  const workspace = decodeURIComponent(match[1] ?? "").trim();
  return workspace ? { workspace } : null;
}

function hasInternalSecret(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const headerValue =
    request.headers.get("x-agent-gateway-secret")?.trim()
    ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const queryValue = url.pathname === "/internal/cron/tick"
    ? url.searchParams.get("internal_token")?.trim()
    : undefined;
  const token = headerValue || queryValue;
  return Boolean(token && token === env.AGENT_GATEWAY_INTERNAL_SECRET);
}

function deriveLegacyScheduleId(
  workspace: string,
  agentId: string,
  schedule: string,
): string {
  const input = `${workspace}:${agentId}:${schedule}`;
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `legacy-${slug.slice(0, 96) || "schedule"}`;
}

async function requireWorkspaceAccess(
  request: Request,
  env: Env,
  workspace: string,
) {
  if (hasInternalSecret(request, env)) {
    const workspaceToken = request.headers.get("x-relayfile-token")?.trim() ?? "";
    if (!workspaceToken) {
      throw Object.assign(
        new Error("workspace token is required for DLQ relayfile access"),
        {
          status: 401,
          code: "missing_authorization",
        },
      );
    }

    return {
      workspaceToken,
      workspace,
    };
  }

  const session = await authenticateWorkspaceRequest(request, env);
  if (session.workspace !== workspace) {
    throw Object.assign(
      new Error(`workspace token is bound to ${session.workspace}, not ${workspace}`),
      {
        status: 403,
        code: "workspace_mismatch",
      },
    );
  }
  return session;
}

function createWorkspaceRelayFileClient(
  env: Env,
  workspaceToken: string,
): RelayFileClient {
  return new RelayFileClient({
    baseUrl: env.RELAYFILE_URL,
    token: workspaceToken,
    readCache: {},
  });
}

function buildDlqDirectoryPath(workspace: string): string {
  return `/_dlq/${encodeURIComponent(workspace)}`;
}

function buildDlqFilePath(workspace: string, eventId: string): string {
  return `${buildDlqDirectoryPath(workspace)}/${encodeURIComponent(eventId)}.json`;
}

function dlqEventIdFromPath(pathname: string): string {
  return decodeURIComponent(
    pathname.split("/").at(-1)?.replace(/\.json$/i, "") ?? pathname,
  );
}

function parseJsonFile<T>(content: unknown): T {
  if (typeof content !== "string") {
    throw Object.assign(new Error("Relayfile returned non-text DLQ content"), {
      status: 500,
      code: "invalid_dlq_content",
    });
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : "Invalid DLQ JSON"),
      { status: 500, code: "invalid_dlq_content" },
    );
  }
}

function readDlqEvent(record: Record<string, unknown>): AgentEvent | null {
  const event = record.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  return event as AgentEvent;
}

function readDlqAgentId(record: Record<string, unknown>): string | null {
  return readStringValue(record.agentId) ?? null;
}

function notFoundPayload() {
  return {
    ok: false,
    error: {
      code: "not_found",
      message: "route not found",
    },
  };
}
