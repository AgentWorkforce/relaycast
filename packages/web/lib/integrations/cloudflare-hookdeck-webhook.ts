import "server-only";

import { NextResponse } from "next/server";
import { normalizeCloudflareWebhook } from "@relayfile/adapter-cloudflare/webhook";
import { getNangoClient } from "@/lib/integrations/nango-service";
import {
  routeNangoWebhook,
  type NangoWebhookEnvelope,
} from "@/lib/integrations/nango-webhook-router";
import {
  findWorkspaceIntegrationByProviderMetadataValue,
  listAllWorkspaceIntegrationsForProvider,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import { logger } from "@/lib/logger";

type CloudflareHookdeckResult =
  | { handled: false }
  | { handled: true; response: NextResponse };

const CLOUDFLARE_TEST_WEBHOOK_MARKERS = [
  "test message sent from https://cloudflare.com",
  "your webhook is configured properly",
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

function isCloudflareTestWebhookPayload(payload: unknown): payload is Record<string, unknown> {
  if (!isRecord(payload)) {
    return false;
  }

  const text = readString(payload.text)?.toLowerCase();
  if (!text) {
    return false;
  }

  return CLOUDFLARE_TEST_WEBHOOK_MARKERS.every((marker) => text.includes(marker));
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
  if (isRecord(payload) && isRecord(payload.metadata)) {
    return payload.metadata;
  }

  return {};
}

function readAccountId(payload: Record<string, unknown>): string | null {
  const nestedData = isRecord(payload.data) ? payload.data : null;

  return (
    readString(payload.account_id) ??
    readString(payload.account_tag) ??
    readString(nestedData?.account_id) ??
    readString(nestedData?.account_tag) ??
    null
  );
}

function metadataMatchesAccountId(
  metadata: Record<string, unknown>,
  accountId: string,
): boolean {
  return (
    readString(metadata.accountId) === accountId ||
    readString(metadata.account_id) === accountId
  );
}

async function findCloudflareIntegrationByAccountId(
  accountId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const integration = await findWorkspaceIntegrationByProviderMetadataValue(
    "cloudflare",
    ["accountId", "account_id"],
    accountId,
  );
  if (integration) {
    return integration;
  }

  const nango = getNangoClient();
  const integrations = await listAllWorkspaceIntegrationsForProvider("cloudflare");
  for (const integration of integrations) {
    try {
      const connection = await nango.getConnection(
        integration.providerConfigKey ?? "cloudflare-relay",
        integration.connectionId,
      );
      const metadata = readConnectionMetadata(connection);
      if (metadataMatchesAccountId(metadata, accountId)) {
        return { ...integration, metadata };
      }
    } catch (error) {
      await logger.warn("Cloudflare Hookdeck webhook could not inspect Nango connection metadata", {
        area: "cloudflare-webhook",
        workspaceId: integration.workspaceId,
        connectionId: integration.connectionId,
        providerConfigKey: integration.providerConfigKey ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

export function looksLikeCloudflareWebhook(value: unknown): boolean {
  const payload =
    typeof value === "string"
      ? safeParseJson(value)
      : value;
  return isCloudflareTestWebhookPayload(payload) ||
    (isRecord(payload) && normalizeCloudflareWebhook(payload) !== null);
}

export async function handleCloudflareHookdeckWebhook(
  rawBody: string,
  headers: Headers,
): Promise<CloudflareHookdeckResult> {
  const payload = safeParseJson(rawBody);
  if (!isRecord(payload)) {
    return { handled: false };
  }

  if (isCloudflareTestWebhookPayload(payload)) {
    await logger.info("Cloudflare Hookdeck test webhook accepted", {
      area: "cloudflare-webhook",
      ingress: "hookdeck",
    });
    return {
      handled: true,
      response: NextResponse.json(
        {
          accepted: true,
          provider: "cloudflare",
          ingress: "hookdeck",
          routed: false,
          type: "cloudflare.webhook_test",
        },
        { status: 200 },
      ),
    };
  }

  const normalized = normalizeCloudflareWebhook(payload);
  if (!normalized) {
    return { handled: false };
  }

  const accountId = readAccountId(payload);
  if (!accountId) {
    return {
      handled: true,
      response: NextResponse.json(
        {
          accepted: false,
          error: "Cloudflare webhook missing account_id/account_tag",
        },
        { status: 400 },
      ),
    };
  }

  const integration = await findCloudflareIntegrationByAccountId(accountId);
  if (!integration) {
    await logger.warn("Cloudflare Hookdeck webhook rejected: no matching workspace integration", {
      area: "cloudflare-webhook",
      accountId,
      eventType: normalized.eventType,
      path: normalized.path,
    });
    return {
      handled: true,
      response: NextResponse.json(
        {
          accepted: false,
          error: `No Cloudflare integration found for account ${accountId}`,
        },
        { status: 404 },
      ),
    };
  }

  const deliveryId = normalized.correlationId ?? `${normalized.objectId}:${normalized.timestamp}`;
  const envelope: NangoWebhookEnvelope = {
    from: "cloudflare",
    type: "forward",
    providerConfigKey: integration.providerConfigKey ?? "cloudflare-relay",
    connectionId: integration.connectionId,
    payload: {
      request: {
        body: payload,
        headers: Object.fromEntries(headers.entries()),
      },
      deliveryId,
    },
  };

  await routeNangoWebhook(envelope);
  await logger.info("Cloudflare Hookdeck webhook accepted", {
    area: "cloudflare-webhook",
    ingress: "hookdeck",
    workspaceId: integration.workspaceId,
    connectionId: integration.connectionId,
    providerConfigKey: integration.providerConfigKey ?? undefined,
    accountId,
    eventType: normalized.eventType,
    path: normalized.path,
    deliveryId,
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
