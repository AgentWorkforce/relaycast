import { redactForRicky } from "@/lib/ricky/redaction";
import {
  redactRunOutputForDiagnostics,
  redactRunOutputSecretPatterns,
} from "@/lib/proactive-runtime/run-output-redaction";

const STRUCTURED_RUNNER_LOG_MAX_LINES = 500;
const STRUCTURED_RUNNER_LOG_MAX_VALUE_CHARS = 16_384;

export type DeploymentRunnerStructuredLogEntry = {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  workspace: string;
  agentId: string;
  eventId?: string;
  msg: string;
  deploymentId: string;
  eventSource: string;
  sandboxId?: string;
  sessionId?: string;
  commandId?: string;
  stream: "runner";
  [key: string]: unknown;
};

export type DeploymentRunLogEntry = {
  id: string;
  timestamp: string;
  level: DeploymentRunnerStructuredLogEntry["level"];
  source: string;
  message: string;
  durationMs: number | null;
  stream: DeploymentRunnerStructuredLogEntry["stream"];
  payload: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function truncateText(value: string, maxLength: number): { text: string; truncated: boolean } {
  if (value.length <= maxLength) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxLength), truncated: true };
}

function normalizeDeploymentRunnerLogLevel(value: unknown): DeploymentRunnerStructuredLogEntry["level"] {
  switch (value) {
    case "debug":
    case "warn":
    case "error":
      return value;
    case "info":
    default:
      return "info";
  }
}

function sanitizeStructuredRunnerLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateText(redactRunOutputSecretPatterns(value), STRUCTURED_RUNNER_LOG_MAX_VALUE_CHARS).text;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeStructuredRunnerLogValue(item));
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sanitizeStructuredRunnerLogValue(item);
    }
    return output;
  }
  return value;
}

function structuredRunnerLogMeta(record: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      key === "t" ||
      key === "ts" ||
      key === "level" ||
      key === "message" ||
      key === "msg" ||
      key === "workspace" ||
      key === "agentId" ||
      key === "eventId" ||
      key === "deploymentId" ||
      key === "eventSource" ||
      key === "sandboxId" ||
      key === "sessionId" ||
      key === "commandId" ||
      key === "stream"
    ) {
      continue;
    }
    meta[key] = sanitizeStructuredRunnerLogValue(value);
  }
  return redactForRicky(meta) as Record<string, unknown>;
}

export function deploymentRunnerStructuredLogEntries(input: {
  output: string;
  relayWorkspaceId: string;
  agentId: string;
  deploymentId: string;
  eventSource: string;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
}): DeploymentRunnerStructuredLogEntry[] {
  const entries: DeploymentRunnerStructuredLogEntry[] = [];
  for (const rawLine of input.output.split(/\r?\n/u)) {
    if (entries.length >= STRUCTURED_RUNNER_LOG_MAX_LINES) {
      break;
    }
    const line = rawLine.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const message = stringValue(parsed.message) ?? stringValue(parsed.msg);
    if (!message) {
      continue;
    }
    const timestamp = stringValue(parsed.t) ?? stringValue(parsed.ts) ?? new Date().toISOString();
    entries.push({
      ts: timestamp,
      level: normalizeDeploymentRunnerLogLevel(parsed.level),
      workspace: input.relayWorkspaceId,
      agentId: input.agentId,
      ...(typeof parsed.eventId === "string" && parsed.eventId.trim()
        ? { eventId: parsed.eventId }
        : {}),
      msg: truncateText(redactRunOutputForDiagnostics(message), STRUCTURED_RUNNER_LOG_MAX_VALUE_CHARS).text,
      deploymentId: input.deploymentId,
      eventSource: input.eventSource,
      ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.commandId ? { commandId: input.commandId } : {}),
      stream: "runner",
      ...structuredRunnerLogMeta(parsed),
    });
  }
  return entries;
}

export function deploymentRunLogEntriesForApi(input: {
  output: string;
  relayWorkspaceId: string;
  agentId: string;
  deploymentId: string;
  eventSource: string;
  runId: string;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
}): DeploymentRunLogEntry[] {
  return deploymentRunnerStructuredLogEntries(input).map((entry, index) => {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (
        key === "ts" ||
        key === "level" ||
        key === "msg" ||
        key === "stream"
      ) {
        continue;
      }
      payload[key] = value;
    }
    const source = stringValue(payload.source) ?? "runner";
    const durationMs = numberValue(payload.durationMs) ??
      numberValue(payload.duration_ms) ??
      numberValue(payload.elapsedMs) ??
      numberValue(payload.elapsed_ms) ??
      null;

    return {
      id: `${input.runId}:${index}`,
      timestamp: entry.ts,
      level: entry.level,
      source,
      message: entry.msg,
      durationMs,
      stream: entry.stream,
      payload,
    };
  });
}
