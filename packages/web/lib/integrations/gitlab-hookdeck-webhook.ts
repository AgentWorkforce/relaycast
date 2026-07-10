import "server-only";

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  getNangoClient,
  triggerNangoSyncs,
} from "@/lib/integrations/nango-service";
import {
  claimWebhookDelivery,
  releaseWebhookDelivery,
} from "@/lib/ricky/webhook-dedup";
import {
  findGitLabIntegrationByProjectWebhookToken,
  gitLabIntegrationMetadataMatchesProjectToken,
  listWorkspaceIntegrationsForProvider,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";

type GitLabWebhookPayload = {
  event_type?: unknown;
  object_kind?: unknown;
  project?: {
    id?: unknown;
    path_with_namespace?: unknown;
  };
  object_attributes?: {
    id?: unknown;
    iid?: unknown;
    action?: unknown;
    state?: unknown;
  };
};

type GitLabHookdeckResult =
  | { handled: false }
  | { handled: true; response: NextResponse };

const GITLAB_EVENT_HEADERS = [
  "x-gitlab-event",
  "x-gitlab-event-uuid",
  "x-gitlab-token",
] as const;

export function looksLikeGitLabWebhook(headers: Headers): boolean {
  return GITLAB_EVENT_HEADERS.some((header) => Boolean(headers.get(header)));
}

export async function handleGitLabHookdeckWebhook(
  rawBody: string,
  headers: Headers,
): Promise<GitLabHookdeckResult> {
  if (!looksLikeGitLabWebhook(headers)) {
    return { handled: false };
  }

  const token = headers.get("x-gitlab-token")?.trim();
  if (!token) {
    return {
      handled: true,
      response: NextResponse.json(
        { accepted: false, error: "Missing GitLab webhook token" },
        { status: 401 },
      ),
    };
  }

  let payload: GitLabWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GitLabWebhookPayload;
  } catch {
    return {
      handled: true,
      response: NextResponse.json(
        { accepted: false, error: "Invalid GitLab webhook JSON" },
        { status: 400 },
      ),
    };
  }

  const projectId = readProjectId(payload);
  if (!projectId) {
    return {
      handled: true,
      response: NextResponse.json(
        { accepted: false, error: "GitLab webhook payload did not include project.id" },
        { status: 400 },
      ),
    };
  }

  const integration = await findGitLabIntegrationByProjectWebhookToken(
    projectId,
    token,
    timingSafeStringEqual,
  ) ?? await findGitLabIntegrationFromNangoMetadata(projectId, token);
  if (!integration) {
    await logger.warn("GitLab Hookdeck webhook rejected: no matching selected project/token", {
      area: "gitlab-webhook",
      projectId,
      eventType: readGitLabEventType(payload, headers),
    });
    return {
      handled: true,
      response: NextResponse.json(
        { accepted: false, error: "Invalid GitLab webhook token" },
        { status: 401 },
      ),
    };
  }

  const eventType = readGitLabEventType(payload, headers);
  const syncs = syncsForGitLabEvent(eventType, payload);
  if (syncs.length === 0) {
    return {
      handled: true,
      response: NextResponse.json({
        accepted: true,
        type: eventType,
        ingress: "hookdeck",
        ignored: true,
      }),
    };
  }

  const deliveryId = headers.get("x-gitlab-event-uuid")?.trim() || buildSyntheticDeliveryId(payload);
  if (deliveryId) {
    const claimed = await claimWebhookDelivery({ surface: "gitlab", deliveryId });
    if (!claimed) {
      return {
        handled: true,
        response: NextResponse.json({
          accepted: true,
          type: eventType,
          ingress: "hookdeck",
          duplicate: true,
        }),
      };
    }
  }

  try {
    await triggerGitLabSyncs(integration, syncs);

    await logger.info("GitLab Hookdeck webhook accepted", {
      area: "gitlab-webhook",
      workspaceId: integration.workspaceId,
      connectionId: integration.connectionId,
      projectId,
      eventType,
      deliveryId: deliveryId || undefined,
    });
  } catch (error) {
    if (deliveryId) {
      await releaseWebhookDelivery({ surface: "gitlab", deliveryId }).catch((releaseError) => {
        console.error(
          "[gitlab-webhook] failed to release webhook dedup after trigger failure:",
          releaseError instanceof Error ? releaseError.message : String(releaseError),
        );
      });
    }
    throw error;
  }

  return {
    handled: true,
    response: NextResponse.json({
      accepted: true,
      type: eventType,
      ingress: "hookdeck",
    }),
  };
}

async function findGitLabIntegrationFromNangoMetadata(
  projectId: string,
  token: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const integrations = await listWorkspaceIntegrationsForProvider("gitlab");
  const nango = getNangoClient();

  for (const integration of integrations) {
    try {
      const connection = await nango.getConnection(
        integration.providerConfigKey ?? "gitlab-relay",
        integration.connectionId,
      );
      const metadata = readConnectionMetadata(connection);
      if (
        gitLabIntegrationMetadataMatchesProjectToken(
          metadata,
          projectId,
          token,
          timingSafeStringEqual,
        )
      ) {
        return { ...integration, metadata };
      }
    } catch (error) {
      await logger.warn("GitLab Hookdeck webhook could not inspect Nango connection metadata", {
        area: "gitlab-webhook",
        workspaceId: integration.workspaceId,
        connectionId: integration.connectionId,
        providerConfigKey: integration.providerConfigKey ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

async function triggerGitLabSyncs(
  integration: WorkspaceIntegrationRecord,
  syncs: string[],
): Promise<void> {
  const result = await triggerNangoSyncs({
    providerConfigKey: integration.providerConfigKey ?? "gitlab-relay",
    connectionId: integration.connectionId,
    syncs,
    syncMode: "incremental",
  });

  if (!result.ok) {
    throw new Error(`Failed to trigger GitLab syncs ${syncs.join(", ")}: ${result.status}`);
  }
}

function readProjectId(payload: GitLabWebhookPayload): string | null {
  const id = payload.project?.id;
  if (typeof id === "string" || typeof id === "number") {
    const trimmed = String(id).trim();
    return trimmed || null;
  }
  return null;
}

function readGitLabEventType(payload: GitLabWebhookPayload, headers: Headers): string {
  return (
    headers.get("x-gitlab-event")?.trim() ||
    readString(payload.event_type) ||
    readString(payload.object_kind) ||
    "unknown"
  );
}

function isMergeRequestEvent(eventType: string, payload: GitLabWebhookPayload): boolean {
  const normalized = eventType.toLowerCase().replace(/\s+/g, "_");
  return (
    normalized.includes("merge_request") ||
    readString(payload.event_type)?.toLowerCase() === "merge_request" ||
    readString(payload.object_kind)?.toLowerCase() === "merge_request"
  );
}

function isIssueEvent(eventType: string, payload: GitLabWebhookPayload): boolean {
  const normalized = eventType.toLowerCase().replace(/\s+/g, "_");
  return (
    normalized.includes("issue") ||
    readString(payload.event_type)?.toLowerCase() === "issue" ||
    readString(payload.object_kind)?.toLowerCase() === "issue"
  );
}

function isPushEvent(eventType: string, payload: GitLabWebhookPayload): boolean {
  const normalized = eventType.toLowerCase().replace(/\s+/g, "_");
  return (
    normalized === "push_hook" ||
    normalized === "push" ||
    readString(payload.event_type)?.toLowerCase() === "push" ||
    readString(payload.object_kind)?.toLowerCase() === "push"
  );
}

function syncsForGitLabEvent(eventType: string, payload: GitLabWebhookPayload): string[] {
  const normalizedKind = readString(payload.object_kind)?.toLowerCase();
  const normalizedType = eventType.toLowerCase().replace(/[\s_-]+/g, ".");
  if (isMergeRequestEvent(eventType, payload)) {
    return ["fetch-merge-requests"];
  }
  if (isIssueEvent(eventType, payload)) {
    return ["fetch-issues"];
  }
  if (isPushEvent(eventType, payload)) {
    return ["fetch-commits"];
  }
  if (normalizedKind === "pipeline" || normalizedType.startsWith("pipeline.")) {
    return ["fetch-pipelines"];
  }
  if (normalizedKind === "build" || normalizedKind === "job" || normalizedType.startsWith("build.") || normalizedType.startsWith("job.")) {
    return ["fetch-pipelines"];
  }
  if (normalizedKind === "deployment" || normalizedType.startsWith("deployment.")) {
    return ["fetch-deployments"];
  }
  if (normalizedKind === "tag_push" || normalizedType === "tag.push" || normalizedType === "tag.push.hook") {
    return ["fetch-tags"];
  }
  return [];
}

function buildSyntheticDeliveryId(payload: GitLabWebhookPayload): string | null {
  const projectId = readProjectId(payload);
  const id = payload.object_attributes?.id;
  const action = readString(payload.object_attributes?.action) ?? "unknown";
  if (!projectId || (typeof id !== "string" && typeof id !== "number")) {
    return null;
  }
  return `${projectId}:${String(id)}:${action}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readConnectionMetadata(connection: unknown): Record<string, unknown> {
  if (!connection || typeof connection !== "object" || !("metadata" in connection)) {
    return {};
  }
  const metadata = (connection as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
