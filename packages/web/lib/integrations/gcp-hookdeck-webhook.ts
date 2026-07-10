import "server-only";

import { NextResponse } from "next/server";
import { normalizeGcpWebhook } from "@relayfile/adapter-gcp";
import {
  getNangoClient,
} from "@/lib/integrations/nango-service";
import {
  routeNangoWebhook,
  type NangoWebhookEnvelope,
} from "@/lib/integrations/nango-webhook-router";
import {
  listWorkspaceIntegrationsForProvider,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import { logger } from "@/lib/logger";

type GcpHookdeckResult =
  | { handled: false }
  | { handled: true; response: NextResponse };

const GCP_SUBSCRIPTION_METADATA_KEYS = [
  "gcpMonitoringPubsubSubscriptionName",
  "gcpBillingPubsubSubscriptionName",
  "gcpCloudRunPubsubSubscriptionName",
  "gcpErrorReportingPubsubSubscriptionName",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeParseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

function lastPathSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split("/").filter(Boolean).at(-1);
}

function readConnectionMetadata(connection: unknown): Record<string, unknown> {
  if (!isRecord(connection)) {
    return {};
  }

  const metadata = connection.metadata;
  if (isRecord(metadata)) {
    return metadata;
  }

  const payload = connection.payload;
  if (isRecord(payload)) {
    const nestedMetadata = payload.metadata;
    if (isRecord(nestedMetadata)) {
      return nestedMetadata;
    }
  }

  return {};
}

function readSubscriptionName(payload: Record<string, unknown>): string | null {
  return readString(payload.subscription) ?? null;
}

function readDeliveryId(payload: Record<string, unknown>): string | null {
  const message = isRecord(payload.message) ? payload.message : null;
  return readString(message?.messageId) ?? readString(message?.message_id) ?? null;
}

function metadataMatchesSubscriptionName(
  metadata: Record<string, unknown>,
  subscriptionName: string,
): boolean {
  const expectedLastSegment = lastPathSegment(subscriptionName);
  for (const key of GCP_SUBSCRIPTION_METADATA_KEYS) {
    const candidate = readString(metadata[key]);
    if (!candidate) {
      continue;
    }
    if (candidate === subscriptionName) {
      return true;
    }
    if (expectedLastSegment && lastPathSegment(candidate) === expectedLastSegment) {
      return true;
    }
  }
  return false;
}

async function findGcpIntegrationBySubscriptionName(
  subscriptionName: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const integrations = await listWorkspaceIntegrationsForProvider("gcp");
  for (const integration of integrations) {
    if (metadataMatchesSubscriptionName(integration.metadata, subscriptionName)) {
      return integration;
    }
  }

  const nango = getNangoClient();
  for (const integration of integrations) {
    try {
      const connection = await nango.getConnection(
        integration.providerConfigKey ?? "gcp-relay",
        integration.connectionId,
      );
      const metadata = readConnectionMetadata(connection);
      if (metadataMatchesSubscriptionName(metadata, subscriptionName)) {
        return { ...integration, metadata };
      }
    } catch (error) {
      await logger.warn("GCP Hookdeck webhook could not inspect Nango connection metadata", {
        area: "gcp-webhook",
        workspaceId: integration.workspaceId,
        connectionId: integration.connectionId,
        providerConfigKey: integration.providerConfigKey ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

export function looksLikeGcpWebhook(value: unknown): boolean {
  const payload =
    typeof value === "string"
      ? safeParseJson(value)
      : value;
  if (!isRecord(payload)) {
    return false;
  }

  return readSubscriptionName(payload) !== null && normalizeGcpWebhook(payload) !== null;
}

export async function handleGcpHookdeckWebhook(
  rawBody: string,
  headers: Headers,
): Promise<GcpHookdeckResult> {
  const payload = safeParseJson(rawBody);
  if (!isRecord(payload)) {
    return {
      handled: true,
      response: NextResponse.json(
        { accepted: false, error: "Invalid GCP webhook JSON" },
        { status: 400 },
      ),
    };
  }

  const subscriptionName = readSubscriptionName(payload);
  const normalized = normalizeGcpWebhook(payload);
  if (!subscriptionName || !normalized) {
    return { handled: false };
  }

  const integration = await findGcpIntegrationBySubscriptionName(subscriptionName);
  if (!integration) {
    await logger.warn("GCP Hookdeck webhook rejected: no matching workspace integration", {
      area: "gcp-webhook",
      subscriptionName,
      eventType: normalized.eventType,
      path: normalized.path,
    });
    return {
      handled: true,
      response: NextResponse.json(
        {
          accepted: false,
          error: `No GCP integration found for subscription ${subscriptionName}`,
        },
        { status: 404 },
      ),
    };
  }

  const envelope: NangoWebhookEnvelope = {
    from: "gcp",
    type: "forward",
    providerConfigKey: integration.providerConfigKey ?? "gcp-relay",
    connectionId: integration.connectionId,
    payload: {
      request: {
        body: payload,
        headers: Object.fromEntries(headers.entries()),
      },
      ...(readDeliveryId(payload) ? { deliveryId: readDeliveryId(payload) } : {}),
    },
  };

  await routeNangoWebhook(envelope);
  await logger.info("GCP Hookdeck webhook accepted", {
    area: "gcp-webhook",
    ingress: "hookdeck",
    workspaceId: integration.workspaceId,
    connectionId: integration.connectionId,
    providerConfigKey: integration.providerConfigKey ?? undefined,
    subscriptionName,
    eventType: normalized.eventType,
    path: normalized.path,
  });

  return {
    handled: true,
    response: NextResponse.json(
      {
        accepted: true,
        type: normalized.eventType,
        ingress: "hookdeck",
      },
      { status: 200 },
    ),
  };
}
