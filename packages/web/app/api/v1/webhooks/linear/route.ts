import { NextRequest, NextResponse } from "next/server";
import {
  computeLinearPath,
  linearIssueByStatePath,
  normalizeLinearWebhook,
  validateLinearWebhookSignature,
  type NormalizedWebhook as LinearNormalizedWebhook,
} from "@relayfile/adapter-linear";
import { and, desc, eq, like, or } from "drizzle-orm";
import {
  createWebhookSyncJob,
  writeBatchToRelayfile,
} from "@cloud/core/sync/record-writer.js";
import { getDb } from "@/lib/db";
import { workspaceIntegrations } from "@/lib/db/schema";
import { tryResourceValue } from "@/lib/env";
import { createGitHubRelayfileClient } from "@/lib/integrations/github-relayfile";
import {
  findWorkspaceIntegrationByConnection,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import { captureError, logger } from "@/lib/logger";
import { dispatchIntegrationWatchEvent } from "@/lib/proactive-runtime/service-client";

export const runtime = "nodejs";

const LINEAR_WEBHOOK_ROUTE = "/api/v1/webhooks/linear";

function linearDirectWatchPaths(
  normalized: LinearNormalizedWebhook,
  data: Record<string, unknown>,
  canonicalPath: string,
): string[] {
  const paths = new Set<string>([canonicalPath]);
  if (normalized.objectType.trim().toLowerCase() !== "issue") return [...paths];

  const identifier = readString(data.identifier);
  const state = isObject(data.state) ? data.state : null;
  const newStateName = readString(state?.name) ?? readString(data.state_name);
  if (identifier && newStateName) {
    try {
      paths.add(linearIssueByStatePath(newStateName, identifier));
    } catch {
      // slug error — skip alias path
    }
  }

  const webhookMeta = isObject(data._webhook) ? data._webhook : null;
  const previousData = isObject(webhookMeta?.previousData) ? webhookMeta?.previousData : null;
  const prevState = isObject(previousData?.state) ? (previousData?.state as Record<string, unknown>) : null;
  const oldStateName =
    readString(previousData?.state_name) ??
    readString(prevState?.name) ??
    null;
  const oldIdentifier = readString(previousData?.identifier) ?? identifier;
  if (oldIdentifier && oldStateName && oldStateName !== newStateName) {
    try {
      paths.add(linearIssueByStatePath(oldStateName, oldIdentifier));
    } catch {
      // slug error — skip old alias path
    }
  }

  return [...paths];
}
const LINEAR_ISSUES_SYNC_NAME = "fetch-active-issues";
const LINEAR_COMMENTS_SYNC_NAME = "fetch-comments";

type RawRows<T> = { rows?: T[] };

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as RawRows<T>;
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function readLinearOrganizationId(payload: Record<string, unknown>): string | null {
  const data = readRecord(payload.data);
  const organization = readRecord(payload.organization) ?? readRecord(data?.organization);
  const metadata = readRecord(payload.metadata);
  const webhook = readRecord(payload._webhook);
  const connection = readRecord(payload._connection);
  return (
    readString(payload.organizationId) ??
    readString(payload.organization_id) ??
    readString(organization?.id) ??
    readString(data?.organizationId) ??
    readString(data?.organization_id) ??
    readString(metadata?.organizationId) ??
    readString(metadata?.organization_id) ??
    readString(webhook?.organizationId) ??
    readString(webhook?.organization_id) ??
    readString(connection?.organizationId) ??
    readString(connection?.organization_id)
  );
}

function metadataLinearOrganizationId(metadata: Record<string, unknown>): string | null {
  const linear = readRecord(metadata.linear);
  const organization = readRecord(metadata.organization);
  return (
    readString(metadata.organizationId) ??
    readString(metadata.organization_id) ??
    readString(metadata.linearOrganizationId) ??
    readString(metadata.linear_organization_id) ??
    readString(linear?.organizationId) ??
    readString(linear?.organization_id) ??
    readString(organization?.id)
  );
}

function metadataMatchesLinearOrganization(
  integration: WorkspaceIntegrationRecord,
  organizationId: string | null,
): boolean {
  if (!organizationId) return true;
  const configured = metadataLinearOrganizationId(integration.metadata);
  return !configured || configured === organizationId;
}

function simplifyHeaders(headers: Headers): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (key.startsWith("linear-") || key.startsWith("x-linear-") || key.startsWith("x-relay-")) {
      copy[key] = value;
    }
  }
  return copy;
}

// Resource-first per sst-secrets.md. `LinearWebhookSecret` is declared with an
// `"unset"` placeholder default (infra/secrets.ts) so deploys never fail before
// a real value is seeded; treat that sentinel (and empty) as "not configured"
// so the caller fails closed instead of validating against the placeholder.
const LINEAR_WEBHOOK_SECRET_PLACEHOLDER = "unset";

function readWebhookSecret(): string | null {
  const fromResource = tryResourceValue("LinearWebhookSecret");
  if (
    typeof fromResource === "string" &&
    fromResource.trim() &&
    fromResource.trim() !== LINEAR_WEBHOOK_SECRET_PLACEHOLDER
  ) {
    return fromResource.trim();
  }
  const fromEnv = process.env.LINEAR_WEBHOOK_SECRET;
  return typeof fromEnv === "string" &&
    fromEnv.trim() &&
    fromEnv.trim() !== LINEAR_WEBHOOK_SECRET_PLACEHOLDER
    ? fromEnv.trim()
    : null;
}

function getLinearWebhookRecordWriterTarget(
  normalized: LinearNormalizedWebhook,
): { syncName: string; model: string } | null {
  switch (normalized.objectType.trim().toLowerCase()) {
    case "issue":
      return { syncName: LINEAR_ISSUES_SYNC_NAME, model: "LinearIssue" };
    case "comment":
      return { syncName: LINEAR_COMMENTS_SYNC_NAME, model: "LinearComment" };
    default:
      return null;
  }
}

// True only when the upstream Linear object was actually deleted (`action:
// "remove"`, normalized to a `*.remove` eventType). Terminal *state* changes
// (`completed`/`canceled`, carried in `state`) arrive as `update` actions and
// must NOT be treated as deletions — they stay readable upserts per the
// relayfile-integration-digests contract.
function isLinearWebhookDelete(normalized: LinearNormalizedWebhook): boolean {
  const eventType = normalized.eventType?.toLowerCase() ?? "";
  if (
    eventType.endsWith(".remove") ||
    eventType.endsWith(".delete") ||
    eventType.endsWith(".deleted")
  ) {
    return true;
  }
  const action = readString(normalized.payload.action)?.toLowerCase();
  return action === "remove" || action === "delete" || action === "deleted";
}

function buildLinearWebhookFileData(
  normalized: LinearNormalizedWebhook,
): Record<string, unknown> {
  const data = readRecord(normalized.payload.data);
  if (!data) {
    return normalized.payload;
  }

  const connection = readRecord(normalized.payload._connection);
  const webhook = readRecord(normalized.payload._webhook);
  return {
    ...data,
    ...(connection ? { _connection: connection } : {}),
    ...(webhook ? { _webhook: webhook } : {}),
  };
}

async function writeBatchToRelayfileOrThrow(
  client: Parameters<typeof writeBatchToRelayfile>[0],
  records: Parameters<typeof writeBatchToRelayfile>[1],
  job: Parameters<typeof writeBatchToRelayfile>[2],
): Promise<Awaited<ReturnType<typeof writeBatchToRelayfile>>> {
  const result = await writeBatchToRelayfile(client, records, job);
  if (result.errors > 0) {
    await logger.error("Linear webhook Relayfile write completed with errors", {
      area: "linear-webhook",
      provider: job.provider,
      syncName: job.syncName,
      model: job.model,
      workspaceId: job.workspaceId,
      written: result.written,
      deleted: result.deleted,
      errors: result.errors,
    });
    throw new Error(
      `Linear webhook Relayfile write failed for ${job.model}: ${result.errors} error(s)`,
    );
  }
  return result;
}

async function findLinearIntegrationByOrganizationId(
  organizationId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const escapedOrganizationId = organizationId
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  const result = await getDb()
    .select()
    .from(workspaceIntegrations)
    .where(and(
      or(
        eq(workspaceIntegrations.provider, "linear"),
        like(workspaceIntegrations.provider, "linear-%"),
      ),
      like(workspaceIntegrations.metadataJson, `%"${escapedOrganizationId}"%`),
    ))
    .orderBy(desc(workspaceIntegrations.updatedAt))
    .limit(20);

  const candidates = Array.isArray(result) ? result : rowsOf<typeof workspaceIntegrations.$inferSelect>(result);
  return candidates
    .map((record) => ({
      id: record.id,
      workspaceId: record.workspaceId,
      provider: record.provider,
      name: record.name ?? null,
      connectionId: record.connectionId ?? "",
      providerConfigKey: record.providerConfigKey ?? null,
      installationId: record.installationId ?? null,
      metadata: JSON.parse(record.metadataJson || "{}") as Record<string, unknown>,
      writebackDispatchVia: record.writebackDispatchVia === "cf" ? "cf" as const : "bridge" as const,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
    .find((integration) =>
      (integration.provider === "linear" ||
        integration.provider.startsWith("linear-")) &&
      metadataLinearOrganizationId(integration.metadata) === organizationId
    ) ?? null;
}

async function resolveLinearWorkspace(input: {
  payload: Record<string, unknown>;
  headers: Headers;
  normalized: LinearNormalizedWebhook;
  request: NextRequest;
}): Promise<WorkspaceIntegrationRecord | null> {
  const connectionId =
    input.request.nextUrl.searchParams.get("connection_id")?.trim() ||
    input.headers.get("x-linear-connection-id")?.trim() ||
    input.headers.get("x-relay-connection-id")?.trim() ||
    input.headers.get("x-nango-connection-id")?.trim() ||
    input.normalized.connectionId?.trim() ||
    null;
  const organizationId = readLinearOrganizationId(input.payload);

  if (connectionId) {
    const integration = await findWorkspaceIntegrationByConnection("linear", connectionId);
    if (!integration || !metadataMatchesLinearOrganization(integration, organizationId)) {
      return null;
    }
    return integration;
  }

  return organizationId ? findLinearIntegrationByOrganizationId(organizationId) : null;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const webhookSecret = readWebhookSecret();

  // Fail closed: the route writes to Relayfile and fires
  // dispatchIntegrationWatchEvent (which can spawn proactive agents), and
  // neither connection_id nor organizationId is secret. Accepting unsigned
  // payloads when no secret is configured would let any caller trigger that
  // pipeline, so refuse rather than process an unverified webhook.
  if (!webhookSecret) {
    await logger.warn("Linear webhook rejected: signature secret is not configured", {
      area: "linear-webhook",
      route: LINEAR_WEBHOOK_ROUTE,
      method: "POST",
    });
    return NextResponse.json(
      { error: "Linear webhook signature verification is not configured" },
      { status: 401 },
    );
  }

  const signature = validateLinearWebhookSignature(rawBody, request.headers, webhookSecret);
  if (!signature.ok) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!isObject(payload)) {
    return NextResponse.json({ error: "Webhook payload must be an object" }, { status: 400 });
  }

  let normalized: LinearNormalizedWebhook;
  try {
    normalized = normalizeLinearWebhook(payload, request.headers);
  } catch (error) {
    await logger.warn("Linear webhook payload normalization failed", {
      area: "linear-webhook",
      route: LINEAR_WEBHOOK_ROUTE,
      method: "POST",
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Invalid Linear webhook payload" }, { status: 400 });
  }

  const integration = await resolveLinearWorkspace({
    payload,
    headers: request.headers,
    normalized,
    request,
  });

  if (!integration) {
    await logger.warn("Linear webhook received with no matching workspace integration", {
      area: "linear-webhook",
      route: LINEAR_WEBHOOK_ROUTE,
      method: "POST",
      connectionId: normalized.connectionId ?? undefined,
      organizationId: readLinearOrganizationId(payload) ?? undefined,
      eventType: normalized.eventType,
    });
    return NextResponse.json({ error: "Linear workspace integration is not configured" }, { status: 404 });
  }

  try {
    const client = createGitHubRelayfileClient(integration.workspaceId);
    const path = computeLinearPath(normalized.objectType, normalized.objectId);
    const data = buildLinearWebhookFileData(normalized);
    const deliveryId =
      request.headers.get("linear-delivery") ??
      readString(readRecord(normalized.payload._connection)?.deliveryId) ??
      undefined;
    const timestamp = new Date().toISOString();
    const recordWriterTarget = getLinearWebhookRecordWriterTarget(normalized);
    const isDelete = isLinearWebhookDelete(normalized);
    // A genuine Linear delete (`action: "remove"`) must emit a deletion, not be
    // re-materialized as an upsert. Mirror the native GitHub route: stamp the
    // synthetic `_nango_metadata` envelope so `isDeletedNangoRecord` drives the
    // deletion branch of the record writer (writeBatch path) and request a
    // `file.deleted` event on the generic ingest path.
    const recordForWrite = isDelete
      ? {
          ...data,
          _nango_metadata: {
            last_action: "deleted",
            deleted_at: timestamp,
          },
        }
      : data;

    const queued = recordWriterTarget
      ? await writeBatchToRelayfileOrThrow(
          client,
          [recordForWrite],
          createWebhookSyncJob({
            workspaceId: integration.workspaceId,
            connectionId: integration.connectionId,
            providerConfigKey: integration.providerConfigKey || "linear-relay",
            provider: "linear",
            syncName: recordWriterTarget.syncName,
            model: recordWriterTarget.model,
          }),
        )
      : await client.ingestWebhook({
          workspaceId: integration.workspaceId,
          provider: "linear",
          event_type: isDelete ? "file.deleted" : "file.updated",
          path,
          data: {
            ...recordForWrite,
            content: `${JSON.stringify(recordForWrite, null, 2)}\n`,
            contentType: "application/json; charset=utf-8",
          },
          delivery_id: deliveryId,
          headers: simplifyHeaders(request.headers),
          timestamp,
        });

    await dispatchIntegrationWatchEvent({
      workspaceId: integration.workspaceId,
      provider: "linear",
      eventType: normalized.eventType,
      connectionId: integration.connectionId,
      deliveryId,
      paths: linearDirectWatchPaths(normalized, data, path),
      payload: data,
      occurredAt: timestamp,
    });

    return NextResponse.json({
      status: "written",
      id: deliveryId ?? path,
      path,
      workspaceId: integration.workspaceId,
      relayfileWrite: "written" in queued ? queued.written : undefined,
    });
  } catch (error) {
    await captureError(error, {
      area: "linear-webhook",
      route: LINEAR_WEBHOOK_ROUTE,
      method: "POST",
      workspaceId: integration.workspaceId,
    });
    return NextResponse.json({ error: "Failed to ingest webhook" }, { status: 500 });
  }
}
