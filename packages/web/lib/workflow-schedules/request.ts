import crypto from "node:crypto";
import {
  decryptCredentialAsync,
  encryptCredential,
  encryptCredentialAsync,
  type EncryptedEnvelope,
} from "@cloud/core/auth/credential-encryption.js";

const SCHEDULE_REQUEST_KEYS = new Set([
  "name",
  "description",
  "schedule_type",
  "cron_expression",
  "scheduled_at",
  "timezone",
  "scheduleMetadata",
  "run",
  "workflowRequest",
]);

export type WorkflowRunScheduleRequest = {
  workflow: string;
  fileType: "yaml" | "ts" | "py";
  [key: string]: unknown;
};

export type ParsedWorkflowScheduleRequest = {
  name: string;
  description?: string;
  scheduleType: "once" | "cron";
  cronExpression?: string;
  scheduledAt?: string;
  scheduledAtDate?: Date;
  timezone: string;
  scheduleMetadata?: unknown;
  workflowRequest: WorkflowRunScheduleRequest;
};

export function hashScheduleWebhookSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function verifyScheduleWebhookSecret(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashScheduleWebhookSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function generateScheduleWebhookSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Expected string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseScheduleType(value: unknown): "once" | "cron" {
  if (value !== "once" && value !== "cron") {
    throw new Error("schedule_type must be once or cron");
  }
  return value;
}

function parseScheduledAt(value: unknown): { raw?: string; date?: Date } {
  const raw = parseOptionalString(value);
  if (!raw) {
    return {};
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error("scheduled_at must be an ISO timestamp");
  }
  return { raw: date.toISOString(), date };
}

export function extractWorkflowRequest(body: Record<string, unknown>): WorkflowRunScheduleRequest {
  const nested = body.workflowRequest ?? body.run;
  const raw = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested
    : Object.fromEntries(
        Object.entries(body).filter(([key]) => !SCHEDULE_REQUEST_KEYS.has(key)),
      );

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workflow request is required");
  }

  const workflowRequest = { ...(raw as Record<string, unknown>) };
  if (typeof workflowRequest.workflow !== "string" || workflowRequest.workflow.trim().length === 0) {
    throw new Error("workflow is required");
  }
  if (
    workflowRequest.fileType !== "yaml" &&
    workflowRequest.fileType !== "ts" &&
    workflowRequest.fileType !== "py"
  ) {
    throw new Error("fileType must be yaml, ts, or py");
  }
  if (workflowRequest.runId !== undefined) {
    throw new Error("scheduled workflows cannot provide runId");
  }
  for (const field of ["s3CodeKey", "paths", "workflowPath", "resume", "startFrom", "previousRunId"]) {
    if (workflowRequest[field] !== undefined) {
      throw new Error(`scheduled workflows cannot provide ${field}`);
    }
  }

  return workflowRequest as WorkflowRunScheduleRequest;
}

export function parseCreateWorkflowScheduleRequest(
  payload: unknown,
): ParsedWorkflowScheduleRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid request body");
  }

  const body = payload as Record<string, unknown>;
  const name = parseOptionalString(body.name);
  if (!name) {
    throw new Error("name is required");
  }

  const scheduleType = parseScheduleType(body.schedule_type);
  const cronExpression = parseOptionalString(body.cron_expression);
  const { raw: scheduledAt, date: scheduledAtDate } = parseScheduledAt(body.scheduled_at);
  const timezone = parseOptionalString(body.timezone) ?? "UTC";

  if (scheduleType === "cron" && !cronExpression) {
    throw new Error("cron_expression is required for cron schedules");
  }
  if (scheduleType === "once" && !scheduledAt) {
    throw new Error("scheduled_at is required for one-time schedules");
  }

  return {
    name,
    description: parseOptionalString(body.description),
    scheduleType,
    cronExpression,
    scheduledAt,
    scheduledAtDate,
    timezone,
    scheduleMetadata: body.scheduleMetadata,
    workflowRequest: extractWorkflowRequest(body),
  };
}

export function encryptJson(value: unknown, encryptionKey: string): EncryptedEnvelope {
  return encryptCredential(JSON.stringify(value), encryptionKey);
}

export async function encryptJsonAsync(value: unknown, encryptionKey: string): Promise<EncryptedEnvelope> {
  return encryptCredentialAsync(JSON.stringify(value), encryptionKey);
}

export async function decryptJson<T>(envelope: EncryptedEnvelope, encryptionKey: string): Promise<T> {
  return JSON.parse(await decryptCredentialAsync(envelope, encryptionKey)) as T;
}
