import { sql } from "drizzle-orm";
import {
  resolveWritebackRequest as resolveLinearWritebackRequest,
} from "@relayfile/adapter-linear/writeback";
import type { LinearWritebackRequest } from "@relayfile/adapter-linear/types";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  getNangoClient,
  getProviderConfigKey,
} from "@/lib/integrations/nango-service";
import {
  extractLinearExternalId,
  extractLinearGraphQLErrors,
  extractLinearMutationOutcome,
} from "@/lib/integrations/linear-writeback-response";
import {
  findWorkspaceIntegrationByConnection,
  getWorkspaceIntegrationByProviderAlias,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import {
  redactRunOutputForDiagnostics,
  runOutputTailForDiagnostics,
  truncateText,
} from "@/lib/proactive-runtime/run-output-redaction";

export type LinearAgentActivityContent = {
  type: "thought" | "elicitation" | "action" | "response" | "error";
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
};

type NangoProxyResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
};

type LinearAgentSessionWritebackTarget = {
  sessionId: string;
  connectionId: string | null;
  deliveryId: string;
  eventType: string;
};

type TerminalWritebackStatus = "completed" | "error" | "timeout" | "sandbox_terminal";

const LINEAR_TERMINAL_REPLY_MAX_OUTPUT_LINES = 40;
const LINEAR_TERMINAL_REPLY_MAX_OUTPUT_BYTES = 4000;
const LINEAR_TERMINAL_REPLY_MAX_BODY_BYTES = 8000;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as { rows?: T[] };
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function eventTypeFromPayload(payload: Record<string, unknown>): string | null {
  const direct = readString(payload.eventType);
  if (direct) return direct;
  const type = readString(payload.type);
  if (!type) return null;
  return type.startsWith("linear.") ? type.slice("linear.".length) : type;
}

export function linearAgentSessionWritebackTargetFromPayload(
  payload: unknown,
): LinearAgentSessionWritebackTarget | null {
  if (!isRecord(payload)) return null;
  const provider = readString(payload.provider);
  const rawType = readString(payload.type);
  const eventType = eventTypeFromPayload(payload);
  const isLinear =
    provider === "linear" ||
    rawType?.startsWith("linear.AgentSessionEvent.") === true;
  if (!isLinear || !eventType?.startsWith("AgentSessionEvent.")) {
    return null;
  }

  const resource = isRecord(payload.resource) ? payload.resource : payload;
  const agentSession = isRecord(resource.agentSession)
    ? resource.agentSession
    : isRecord(resource.agent_session)
      ? resource.agent_session
      : null;
  const sessionId = readString(
    agentSession?.id,
    resource.agentSessionId,
    resource.agent_session_id,
  );
  const deliveryId = readString(payload.deliveryId, payload.id);
  if (!sessionId || !deliveryId) {
    return null;
  }
  return {
    sessionId,
    connectionId: readString(payload.connectionId),
    deliveryId,
    eventType,
  };
}

export async function claimIntegrationWatchTerminalWriteback(input: {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET terminal_writeback_status = 'posting',
        terminal_writeback_error = NULL,
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND agent_id = ${input.agentId}
      AND delivery_id = ${input.deliveryId}
      AND terminal_writeback_status IS NULL
      AND status NOT IN ('delivered', 'failed')
    RETURNING id
  `);
  return rowsOf(result).length > 0;
}

async function markIntegrationWatchTerminalWritebackPosted(input: {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET terminal_writeback_status = 'posted',
        terminal_writeback_posted_at = NOW(),
        terminal_writeback_error = NULL,
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND agent_id = ${input.agentId}
      AND delivery_id = ${input.deliveryId}
      AND terminal_writeback_status = 'posting'
  `);
}

async function markIntegrationWatchTerminalWritebackFailed(input: {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  error: string;
}): Promise<void> {
  await getDb().execute(sql`
    UPDATE integration_watch_deliveries
    SET terminal_writeback_status = 'failed',
        terminal_writeback_error = ${truncateText(input.error, 4000)},
        updated_at = NOW()
    WHERE workspace_id = ${input.workspaceId}
      AND agent_id = ${input.agentId}
      AND delivery_id = ${input.deliveryId}
      AND terminal_writeback_status = 'posting'
  `);
}

function resolveBackendIntegrationId(integration: WorkspaceIntegrationRecord): string {
  return integration.providerConfigKey ?? getProviderConfigKey("linear");
}

async function resolveLinearIntegration(input: {
  workspaceId: string;
  connectionId?: string | null;
}): Promise<WorkspaceIntegrationRecord | null> {
  if (input.connectionId) {
    const byConnection = await findWorkspaceIntegrationByConnection("linear", input.connectionId);
    if (byConnection?.workspaceId === input.workspaceId) {
      return byConnection;
    }
  }
  return getWorkspaceIntegrationByProviderAlias(input.workspaceId, "linear");
}

async function proxyThroughNango<T = unknown>(input: {
  connectionId: string;
  backendIntegrationId: string;
  request: LinearWritebackRequest;
}): Promise<NangoProxyResult<T>> {
  const client = getNangoClient();
  try {
    const response = await client.proxy<T>({
      method: input.request.method,
      endpoint: input.request.endpoint,
      connectionId: input.connectionId,
      providerConfigKey: input.backendIntegrationId,
      data: input.request.body,
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data: (response.data ?? null) as T | null,
    };
  } catch (error) {
    const info = readAxiosErrorResponse(error);
    if (!info) throw error;
    return {
      ok: false,
      status: info.status,
      data: (info.data ?? null) as T | null,
    };
  }
}

function readAxiosErrorResponse(error: unknown):
  | { status: number; data: unknown }
  | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return null;
  const status = (response as { status?: unknown }).status;
  if (typeof status !== "number") return null;
  return {
    status,
    data: (response as { data?: unknown }).data,
  };
}

export async function postLinearAgentActivity(input: {
  workspaceId: string;
  connectionId?: string | null;
  sessionId: string;
  activity: LinearAgentActivityContent;
  activityFileName: string;
}): Promise<{
  ok: boolean;
  error?: string;
  status?: number;
  externalId?: string;
}> {
  const integration = await resolveLinearIntegration({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
  });
  if (!integration) {
    return { ok: false, error: "Linear integration is not connected." };
  }

  const path =
    `/linear/agent-sessions/${encodeURIComponent(input.sessionId)}` +
    `/activities/${encodeURIComponent(input.activityFileName)}`;
  const request = resolveLinearWritebackRequest(path, JSON.stringify(input.activity));
  if (request.action !== "create_agent_activity") {
    return {
      ok: false,
      error: `Linear terminal writeback resolved unexpected action: ${request.action}`,
    };
  }

  try {
    const response = await proxyThroughNango<Record<string, unknown>>({
      connectionId: integration.connectionId,
      backendIntegrationId: resolveBackendIntegrationId(integration),
      request,
    });
    const linearErrors = extractLinearGraphQLErrors(response.data);
    const mutationOutcome = extractLinearMutationOutcome(response.data, request.action);
    if (response.ok && !linearErrors && mutationOutcome.success !== false) {
      return {
        ok: true,
        status: response.status,
        externalId: extractLinearExternalId(response.data, request.action),
      };
    }
    return {
      ok: false,
      status: response.status,
      error:
        linearErrors ??
        mutationOutcome.message ??
        `Linear writeback failed with status ${response.status}`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function terminalActivityType(status: TerminalWritebackStatus): LinearAgentActivityContent["type"] {
  return status === "completed" ? "response" : "error";
}

function buildTerminalActivityBody(input: {
  deploymentId: string;
  terminalStatus: TerminalWritebackStatus;
  exitCode: number | null;
  error: unknown;
  output: string;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
}): string {
  const outputTail = runOutputTailForDiagnostics(input.output, {
    maxLines: LINEAR_TERMINAL_REPLY_MAX_OUTPUT_LINES,
    maxBytes: LINEAR_TERMINAL_REPLY_MAX_OUTPUT_BYTES,
  });
  const error = input.error instanceof Error
    ? input.error.message
    : input.error
      ? String(input.error)
      : "";
  const lines = [
    input.terminalStatus === "completed"
      ? "Agent run completed."
      : "Agent run failed.",
    `Deployment: ${input.deploymentId}`,
    `Terminal reason: ${input.terminalStatus}`,
    input.exitCode === null ? null : `Exit code: ${input.exitCode}`,
    input.sandboxId ? `Sandbox: ${input.sandboxId}` : null,
    input.sessionId ? `Session: ${input.sessionId}` : null,
    input.commandId ? `Command: ${input.commandId}` : null,
    error ? `Error: ${redactRunOutputForDiagnostics(error)}` : null,
    outputTail ? `Output tail:\n${outputTail}` : null,
  ].filter((line): line is string => Boolean(line));
  return truncateText(lines.join("\n\n"), LINEAR_TERMINAL_REPLY_MAX_BODY_BYTES);
}

export async function postLinearAgentSessionTerminalWriteback(input: {
  workspaceId: string;
  agentId: string;
  deploymentId: string;
  payload: unknown;
  terminalStatus: TerminalWritebackStatus;
  result?: {
    output?: string | null;
    exitCode?: number | null;
  } | null;
  error?: unknown;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
}): Promise<void> {
  const target = linearAgentSessionWritebackTargetFromPayload(input.payload);
  if (!target) return;

  let claimed = false;
  let failureRecorded = false;
  try {
    claimed = await claimIntegrationWatchTerminalWriteback({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: target.deliveryId,
    });
    if (!claimed) return;

    const activity: LinearAgentActivityContent = {
      type: terminalActivityType(input.terminalStatus),
      body: buildTerminalActivityBody({
        deploymentId: input.deploymentId,
        terminalStatus: input.terminalStatus,
        exitCode: typeof input.result?.exitCode === "number" ? input.result.exitCode : null,
        error: input.error,
        output: typeof input.result?.output === "string" ? input.result.output : "",
        sandboxId: input.sandboxId,
        sessionId: input.sessionId,
        commandId: input.commandId,
      }),
    };
    const result = await postLinearAgentActivity({
      workspaceId: input.workspaceId,
      connectionId: target.connectionId,
      sessionId: target.sessionId,
      activity,
      activityFileName: `terminal-${safeFileSegment(target.deliveryId)}.json`,
    });
    if (result.ok) {
      await markIntegrationWatchTerminalWritebackPosted({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deliveryId: target.deliveryId,
      });
      return;
    }

    const error = result.error ?? "Linear terminal writeback failed";
    await markIntegrationWatchTerminalWritebackFailed({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: target.deliveryId,
      error,
    });
    failureRecorded = true;
    await logger.warn("Linear AgentSession terminal writeback failed", {
      area: "linear-agent-activity-writeback",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      deliveryId: target.deliveryId,
      sessionId: target.sessionId,
      eventType: target.eventType,
      error,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claimed && !failureRecorded) {
      try {
        await markIntegrationWatchTerminalWritebackFailed({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          deliveryId: target.deliveryId,
          error: message,
        });
        failureRecorded = true;
      } catch (markError) {
        await logger.warn("Linear AgentSession terminal writeback failure mark failed", {
          area: "linear-agent-activity-writeback",
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          deploymentId: input.deploymentId,
          deliveryId: target.deliveryId,
          sessionId: target.sessionId,
          eventType: target.eventType,
          error: markError instanceof Error ? markError.message : String(markError),
          originalError: message,
        });
      }
    }
    await logger.warn("Linear AgentSession terminal writeback crashed", {
      area: "linear-agent-activity-writeback",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      deliveryId: target.deliveryId,
      sessionId: target.sessionId,
      eventType: target.eventType,
      error: message,
      failureRecorded,
    });
  }
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "delivery";
}
