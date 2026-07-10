import "server-only";

import { NextResponse } from "next/server";
import {
  dispatchIntegrationWatchEvent,
} from "@/lib/proactive-runtime/integration-watch-dispatcher";
import {
  getNangoClient,
  getProviderConfigKey,
} from "@/lib/integrations/nango-service";
import { logger } from "@/lib/logger";
import { claimWebhookDelivery, releaseWebhookDelivery } from "@/lib/ricky/webhook-dedup";
import {
  findWorkspaceIntegrationByConnection,
  listWorkspaceIntegrationsForProvider,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import {
  normalizeDaytonaWebhook,
  type NormalizedDaytonaWebhook as AdapterNormalizedDaytonaWebhook,
} from "@relayfile/adapter-daytona/webhook";

const DAYTONA_INCIDENT_STATES = new Set(["error", "build_failed"]);

type DaytonaHookdeckResult =
  | { handled: false }
  | { handled: true; response: NextResponse };

type DaytonaForwardEnvelope = {
  connectionId: string | null;
  payload: unknown;
};

export type DaytonaNormalizedWebhook = {
  readonly eventType: AdapterNormalizedDaytonaWebhook["eventType"];
  readonly dispatchEventType: string;
  readonly objectType: AdapterNormalizedDaytonaWebhook["objectType"];
  readonly objectId: string;
  readonly organizationId: string;
  readonly timestamp: string;
  readonly state?: string;
  readonly payload: Record<string, unknown>;
  readonly path: string;
  readonly deliveryId: string;
};

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

function computeDispatchEventType(
  eventType: DaytonaNormalizedWebhook["eventType"],
  state?: string,
): string {
  if (eventType.endsWith(".state.updated") && state && DAYTONA_INCIDENT_STATES.has(state)) {
    return "incident";
  }
  return eventType;
}

function normalizeDaytonaWebhookPayload(payload: unknown): DaytonaNormalizedWebhook | null {
  const normalized = normalizeDaytonaWebhook(payload);
  if (!normalized) {
    return null;
  }

  return {
    eventType: normalized.eventType,
    dispatchEventType: computeDispatchEventType(
      normalized.eventType,
      normalized.state,
    ),
    objectType: normalized.objectType,
    objectId: normalized.objectId,
    organizationId: normalized.organizationId,
    timestamp: normalized.timestamp,
    ...(normalized.state ? { state: normalized.state } : {}),
    payload: normalized.payload,
    path: normalized.path,
    deliveryId: `${normalized.objectId}:${normalized.eventType}:${normalized.timestamp}`,
  };
}

export function looksLikeDaytonaWebhook(value: unknown): boolean {
  return normalizeDaytonaWebhookPayload(
    typeof value === "string"
      ? safeParseJson(value)
      : value,
  ) !== null;
}

export async function handleDaytonaHookdeckWebhook(
  rawBody: string,
  _headers: Headers,
): Promise<DaytonaHookdeckResult> {
  const payload = safeParseJson(rawBody);
  const normalized = normalizeDaytonaWebhookPayload(payload);
  if (!normalized) {
    return { handled: false };
  }

  const integration = await findDaytonaIntegrationByOrganizationId(normalized.organizationId);
  if (!integration) {
    return {
      handled: true,
      response: NextResponse.json(
        {
          accepted: false,
          error: `No Daytona integration found for organization ${normalized.organizationId}`,
        },
        { status: 404 },
      ),
    };
  }

  const outcome = await dispatchDaytonaWatchEvent({
    integration,
    normalized,
    ingress: "hookdeck",
  });

  return {
    handled: true,
    response: NextResponse.json({
      accepted: true,
      type: normalized.eventType,
      ingress: "hookdeck",
      ...(outcome === "duplicate" ? { duplicate: true } : {}),
    }),
  };
}

export async function routeDaytonaWebhook(envelope: DaytonaForwardEnvelope): Promise<void> {
  const normalized = normalizeDaytonaWebhookPayload(envelope.payload);
  if (!normalized) {
    await logger.warn("Daytona forward webhook ignored: payload did not match Daytona schema", {
      area: "daytona-webhook",
    });
    return;
  }

  const connectionId = envelope.connectionId?.trim();
  if (!connectionId) {
    await logger.warn("Daytona forward webhook received without a connection id", {
      area: "daytona-webhook",
      eventType: normalized.eventType,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection("daytona", connectionId);
  if (!integration) {
    await logger.warn("Daytona forward webhook received for unknown connection", {
      area: "daytona-webhook",
      connectionId,
      eventType: normalized.eventType,
    });
    return;
  }

  await dispatchDaytonaWatchEvent({
    integration,
    normalized,
    ingress: "nango",
  });
}

async function dispatchDaytonaWatchEvent(input: {
  integration: WorkspaceIntegrationRecord;
  normalized: DaytonaNormalizedWebhook;
  ingress: "hookdeck" | "nango";
}): Promise<"duplicate" | "dispatched"> {
  const { integration, normalized, ingress } = input;
  const deliveryId = normalized.deliveryId;

  if (deliveryId) {
    const claimed = await claimWebhookDelivery({
      surface: "daytona",
      deliveryId,
    });
    if (!claimed) {
      await logger.info("Daytona webhook dedupe hit", {
        area: "daytona-webhook",
        workspaceId: integration.workspaceId,
        connectionId: integration.connectionId,
        eventType: normalized.eventType,
        deliveryId,
      });
      return "duplicate";
    }
  }

  try {
    await dispatchIntegrationWatchEvent({
      workspaceId: integration.workspaceId,
      provider: "daytona",
      eventType: normalized.dispatchEventType,
      connectionId: integration.connectionId,
      deliveryId,
      paths: [normalized.path],
      payload: normalized.payload,
    });

    await logger.info("Daytona webhook accepted", {
      area: "daytona-webhook",
      ingress,
      workspaceId: integration.workspaceId,
      connectionId: integration.connectionId,
      organizationId: normalized.organizationId,
      eventType: normalized.eventType,
      dispatchEventType: normalized.dispatchEventType,
      deliveryId,
    });
    return "dispatched";
  } catch (error) {
    if (deliveryId) {
      await releaseWebhookDelivery({
        surface: "daytona",
        deliveryId,
      }).catch((releaseError) => {
        console.error(
          "[daytona-webhook] failed to release webhook dedup after dispatch failure:",
          releaseError instanceof Error ? releaseError.message : String(releaseError),
        );
      });
    }
    throw error;
  }
}

async function findDaytonaIntegrationByOrganizationId(
  organizationId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const nango = getNangoClient();
  const integrations = await listWorkspaceIntegrationsForProvider("daytona");

  for (const integration of integrations) {
    const providerConfigKey =
      integration.providerConfigKey ?? getProviderConfigKey("daytona");
    try {
      const connection = await nango.getConnection(
        providerConfigKey,
        integration.connectionId,
      );
      const metadata = readConnectionMetadata(connection);
      if (
        readString(metadata.organizationId) === organizationId ||
        readString(metadata.organization_id) === organizationId ||
        readString(metadata.organizationID) === organizationId
      ) {
        return { ...integration, metadata };
      }
    } catch (error) {
      await logger.warn("Daytona webhook could not inspect connection metadata", {
        area: "daytona-webhook",
        workspaceId: integration.workspaceId,
        connectionId: integration.connectionId,
        providerConfigKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

function readConnectionMetadata(connection: unknown): Record<string, unknown> {
  if (!isRecord(connection) || !isRecord(connection.metadata)) {
    return {};
  }
  return connection.metadata;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
