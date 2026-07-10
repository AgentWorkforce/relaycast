import { timingSafeEqual } from "node:crypto";
import { tryResourceValue } from "../../web/lib/env";
import {
  drainDeploymentTickDeliveries,
} from "../../web/lib/proactive-runtime/deployment-tick-deliveries";
import {
  deliverDeploymentTrigger,
  DeploymentTriggerDeliveryError,
} from "../../web/lib/proactive-runtime/deployment-trigger-delivery";
import { readInboxDeploymentCandidates } from "../../web/lib/proactive-runtime/inbox-dispatcher";
import {
  drainIntegrationWatchDeliveries,
  sweepCoalescedIssueDispatchRedispatches,
} from "../../web/lib/proactive-runtime/integration-watch-deliveries";
import { readIntegrationWatchCandidateAgents } from "../../web/lib/proactive-runtime/integration-watch-dispatcher";
import { dispatchIntegrationWatchEvent } from "../../web/lib/proactive-runtime/integration-watch-dispatcher";
import {
  drainPrSandboxWarmPool,
  reapStoppedSandboxes,
} from "../../web/lib/proactive-runtime/deployment-sandbox-recycle";
import {
  getAuthorizedDeploymentRun,
  getAuthorizedDeploymentRunEnvelope,
  listAuthorizedDeploymentRuns,
} from "../../web/lib/proactive-runtime/deployment-run-observability-core";

type SweepRequest = {
  limit?: unknown;
};

type IntegrationWatchDeliveryDrainRequest = {
  workspaceId?: unknown;
  agentId?: unknown;
  deliveryId?: unknown;
  limit?: unknown;
};

type ReaperRequest = {
  minAgeHours?: unknown;
  clearLeases?: unknown;
};

type CandidateRequest = {
  workspaceId?: unknown;
  selector?: unknown;
};

type DeliverRequest = {
  workspaceId?: unknown;
  agentId?: unknown;
  payload?: unknown;
  deliveryId?: unknown;
};

type IntegrationWatchDispatchRequest = {
  workspaceId?: unknown;
  provider?: unknown;
  eventType?: unknown;
  connectionId?: unknown;
  deliveryId?: unknown;
  paths?: unknown;
  payload?: unknown;
  occurredAt?: unknown;
};

type DeploymentRunReadRequest = {
  kind?: unknown;
  workspaceId?: unknown;
  agentId?: unknown;
  runId?: unknown;
};

const DEFAULT_SWEEP_LIMIT = 3;
const MAX_SWEEP_LIMIT = 6;
const SWEEP_MAX_DELIVERY_AGE_SECONDS = 60 * 60;
const SWEEP_DELIVERY_OPTIONS = {
  sandboxCreateTimeoutSeconds: 120,
  runScriptTimeoutMs: 15_000,
  asyncRunScript: true,
};

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function readBearer(request: Request): string | undefined {
  return request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
}

function hasRelaycronSecret(request: Request): boolean {
  const expected =
    tryResourceValue("RelaycronApiKey") ??
    process.env.RELAYCRON_API_KEY?.trim();
  const provided = readBearer(request);
  return Boolean(expected && provided && constantTimeEqual(provided, expected));
}

function hasAgentGatewaySecret(request: Request): boolean {
  const expected =
    tryResourceValue("AgentGatewayInternalSecret") ??
    process.env.AGENT_GATEWAY_INTERNAL_SECRET?.trim();
  const provided =
    request.headers.get("x-agent-gateway-secret")?.trim() ??
    readBearer(request);
  return Boolean(expected && provided && constantTimeEqual(provided, expected));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readLimit(body: SweepRequest | null): number {
  const limit = body?.limit;
  if (!Number.isInteger(limit) || typeof limit !== "number") {
    return DEFAULT_SWEEP_LIMIT;
  }
  return Math.min(Math.max(limit, 1), MAX_SWEEP_LIMIT);
}

function readMinAgeHours(body: ReaperRequest | null): number | undefined {
  return typeof body?.minAgeHours === "number" && Number.isFinite(body.minAgeHours)
    ? Math.max(0, body.minAgeHours)
    : undefined;
}

function readClearLeases(body: ReaperRequest | null): boolean {
  return typeof body?.clearLeases === "boolean" ? body.clearLeases : true;
}

async function readJson<T>(request: Request): Promise<T | null> {
  return (await request.json().catch(() => null)) as T | null;
}

export async function handleProactiveRuntimeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^\/cloud(?=\/api\/)/u, "");

  if (request.method === "GET" && pathname === "/health") {
    return json({ ok: true, service: "proactive-runtime-worker" });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/proactive-runtime/integration-watch-deliveries/sweep"
  ) {
    if (!hasRelaycronSecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson<SweepRequest>(request);
    const coalescedRedispatched = await sweepCoalescedIssueDispatchRedispatches({});
    const result = await drainIntegrationWatchDeliveries({
      limit: readLimit(body),
      maxDeliveryAgeSeconds: SWEEP_MAX_DELIVERY_AGE_SECONDS,
      deliveryOptions: SWEEP_DELIVERY_OPTIONS,
      allowTeamLaunchN1: true,
    });
    return json({ ok: true, data: { ...result, coalescedRedispatched } });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/proactive-runtime/integration-watch-deliveries/drain"
  ) {
    if (!hasAgentGatewaySecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    let body: IntegrationWatchDeliveryDrainRequest | null;
    try {
      body = await readJson<IntegrationWatchDeliveryDrainRequest>(request);
    } catch {
      return json({ ok: false, error: "invalid json body" }, { status: 400 });
    }
    const workspaceId = readString(body?.workspaceId);
    const agentId = readString(body?.agentId);
    const deliveryId = readString(body?.deliveryId);
    if (!workspaceId || !agentId) {
      return json({ ok: false, error: "workspaceId and agentId are required" }, { status: 400 });
    }
    const result = await drainIntegrationWatchDeliveries({
      workspaceId,
      agentId,
      ...(deliveryId ? { deliveryId } : {}),
      limit: deliveryId ? 1 : readLimit(body ?? null),
      // Use the default lease (DEFAULT_LEASE_SECONDS = 180s), which exceeds the
      // delivery budget (sandbox create up to 120s + script time). A shorter
      // 60s lease could expire mid-provision and let the relaycron sweep claim
      // the same row before this attempt finishes, double-provisioning it.
      deliveryOptions: SWEEP_DELIVERY_OPTIONS,
      allowTeamLaunchN1: true,
    });
    return json({ ok: true, data: result });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/proactive-runtime/deployment-tick-deliveries/sweep"
  ) {
    if (!hasRelaycronSecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson<SweepRequest>(request);
    const result = await drainDeploymentTickDeliveries({
      limit: readLimit(body),
      maxDeliveryAgeSeconds: SWEEP_MAX_DELIVERY_AGE_SECONDS,
      deliveryOptions: SWEEP_DELIVERY_OPTIONS,
    });
    return json({ ok: true, data: result });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/proactive-runtime/sandbox-reaper"
  ) {
    if (!hasRelaycronSecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson<ReaperRequest>(request);
    const result = await reapStoppedSandboxes({
      minAgeHours: readMinAgeHours(body),
      clearLeases: readClearLeases(body),
    });
    return json({ ok: true, data: result });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/proactive-runtime/pr-sandbox/drain"
  ) {
    if (!hasRelaycronSecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson<ReaperRequest>(request);
    const result = await drainPrSandboxWarmPool({
      clearLeases: readClearLeases(body),
    });
    return json({ ok: true, data: result });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/proactive-runtime/vfs-watch/candidates"
  ) {
    if (!hasAgentGatewaySecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson<CandidateRequest>(request);
    const workspaceId = readString(body?.workspaceId);
    if (!workspaceId) {
      return json({ ok: false, error: "workspaceId is required" }, { status: 400 });
    }
    const agents = await readIntegrationWatchCandidateAgents(workspaceId);
    return json({
      ok: true,
      data: {
        agents: agents.map((agent) => ({
          agentId: agent.id,
          watchGlobs: agent.watch_globs ?? [],
          watchRules: agent.watch_rules ?? [],
          spec: agent.spec ?? null,
        })),
      },
    });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/proactive-runtime/inbox/candidates"
  ) {
    if (!hasAgentGatewaySecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson<CandidateRequest>(request);
    const workspaceId = readString(body?.workspaceId);
    const selector = readString(body?.selector);
    if (!workspaceId || !selector) {
      return json(
        { ok: false, error: "workspaceId and selector are required" },
        { status: 400 },
      );
    }
    const agents = await readInboxDeploymentCandidates({ workspaceId, selector });
    return json({
      ok: true,
      data: {
        agents: agents.map((agent) => ({
          agentId: agent.id,
          deployedName: agent.deployed_name,
          inboxSelectors: agent.inbox_selectors ?? [],
        })),
      },
    });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/proactive-runtime/integration-watch/dispatch"
  ) {
    if (!hasAgentGatewaySecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson<IntegrationWatchDispatchRequest>(request);
    const workspaceId = readString(body?.workspaceId);
    const provider = readString(body?.provider);
    const eventType = readString(body?.eventType);
    if (!workspaceId || !provider || !eventType) {
      return json(
        { ok: false, error: "workspaceId, provider, and eventType are required" },
        { status: 400 },
      );
    }
    const paths = Array.isArray(body?.paths)
      ? body.paths.filter((path): path is string => typeof path === "string")
      : undefined;
    const result = await dispatchIntegrationWatchEvent({
      workspaceId,
      provider,
      eventType,
      connectionId: readString(body?.connectionId),
      deliveryId: readString(body?.deliveryId),
      paths,
      payload: body?.payload,
      occurredAt: readString(body?.occurredAt) ?? undefined,
    });
    return json({ ok: true, data: result });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/internal/proactive-runtime/deployment-run-observability/read"
  ) {
    if (!hasAgentGatewaySecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson<DeploymentRunReadRequest>(request);
    const kind = readString(body?.kind);
    const workspaceId = readString(body?.workspaceId);
    const agentId = readString(body?.agentId);
    if (!kind || !workspaceId || !agentId) {
      return json(
        { ok: false, error: "kind, workspaceId, and agentId are required" },
        { status: 400 },
      );
    }
    if (kind === "list") {
      return listAuthorizedDeploymentRuns(request, {
        workspaceId,
        agentId,
      });
    }
    const runId = readString(body?.runId);
    if (!runId) {
      return json({ ok: false, error: "runId is required" }, { status: 400 });
    }
    if (kind === "detail") {
      return getAuthorizedDeploymentRun(request, {
        workspaceId,
        agentId,
        runId,
      });
    }
    if (kind === "envelope") {
      return getAuthorizedDeploymentRunEnvelope({
        workspaceId,
        agentId,
        runId,
      });
    }
    return json({ ok: false, error: "unsupported run read kind" }, { status: 400 });
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/internal/proactive-runtime/vfs-watch/deliver" ||
      pathname === "/api/internal/proactive-runtime/inbox/deliver")
  ) {
    if (!hasAgentGatewaySecret(request)) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await readJson<DeliverRequest>(request);
    const workspaceId = readString(body?.workspaceId);
    const agentId = readString(body?.agentId);
    if (!workspaceId || !agentId) {
      return json(
        { ok: false, error: "workspaceId and agentId are required" },
        { status: 400 },
      );
    }
    try {
      const result = await deliverDeploymentTrigger({
        workspaceId,
        agentId,
        payload: body?.payload ?? {},
        deliveryId: readString(body?.deliveryId) ?? undefined,
      });
      return json({ ok: true, data: result }, { status: 202 });
    } catch (error) {
      if (error instanceof DeploymentTriggerDeliveryError) {
        return json(
          { ok: false, error: error.message, code: error.code },
          { status: error.status },
        );
      }
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : "delivery failed",
        },
        { status: 502 },
      );
    }
  }

  return json({ ok: false, error: "not found" }, { status: 404 });
}
