import { NextRequest, NextResponse } from "next/server";
import {
  getAgentDeploymentTickTarget,
  verifyDeploymentWebhookSecret,
} from "@/lib/proactive-runtime/persona-deploy";
import {
  DeploymentTriggerDeliveryError,
} from "@/lib/proactive-runtime/deployment-trigger-delivery";
import {
  enqueueDeploymentTickDelivery,
} from "@/lib/proactive-runtime/deployment-tick-deliveries";
import { readCloudflareWaitUntil } from "@/lib/proactive-runtime/cloudflare-waituntil";
import { DEPLOYMENT_TRIGGER_DELIVERY_OPTIONS } from "@/lib/proactive-runtime/deployment-trigger-route-options";

type TickRouteContext = {
  params: Promise<{ workspaceId: string; agentId: string }>;
};

type TickResponse = {
  agentId: string;
  workspaceId: string;
  deploymentId: string;
  status: "starting";
};

const DEPLOYMENT_TOKEN_HEADERS = [
  "x-cloud-agent-deployment-token",
  "x-agentrelay-deployment-token",
] as const;
const DEPLOYMENT_TOKEN_QUERY_PARAM = "deployment_token";
const OCCURRENCE_EPOCH_HEADER = "x-agentcron-occurrence-epoch";
const OCCURRENCE_ID_HEADER = "x-agentcron-occurrence-id";
function readWebhookToken(request: NextRequest): string | null {
  for (const header of DEPLOYMENT_TOKEN_HEADERS) {
    const token = request.headers.get(header)?.trim();
    if (token) {
      return token;
    }
  }
  const queryToken = request.nextUrl.searchParams
    .get(DEPLOYMENT_TOKEN_QUERY_PARAM)
    ?.trim();
  if (queryToken) {
    return queryToken;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseOccurrenceEpoch(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeTickPayload(input: {
  payload: unknown;
  request: NextRequest;
}): unknown {
  const body = isRecord(input.payload) ? input.payload : {};
  const bodyOccurrenceEpoch = parseOccurrenceEpoch(body.occurrenceEpoch);
  const bodyOccurrenceId = nonEmptyString(body.occurrenceId);
  const headerOccurrenceEpoch = parseOccurrenceEpoch(
    input.request.headers.get(OCCURRENCE_EPOCH_HEADER),
  );
  const headerOccurrenceId = nonEmptyString(
    input.request.headers.get(OCCURRENCE_ID_HEADER),
  );
  const occurrenceEpoch = bodyOccurrenceEpoch ?? headerOccurrenceEpoch;
  const occurrenceId = bodyOccurrenceId ?? headerOccurrenceId;

  if (occurrenceEpoch === null && occurrenceId === null) {
    return input.payload;
  }

  return {
    ...(isRecord(input.payload) ? input.payload : {}),
    ...(occurrenceEpoch === null ? {} : { occurrenceEpoch }),
    ...(occurrenceId === null ? {} : { occurrenceId }),
  };
}

export async function POST(
  request: NextRequest,
  context: TickRouteContext,
): Promise<NextResponse<TickResponse | { error: string; code?: string }>> {
  const token = readWebhookToken(request);
  if (!token) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  const { workspaceId, agentId } = await context.params;
  const target = await getAgentDeploymentTickTarget({ workspaceId, agentId });
  if (!target) {
    return NextResponse.json({ error: "Deployment target not found", code: "not_found" }, { status: 404 });
  }
  if (target.status !== "active") {
    return NextResponse.json({ error: "Deployment target is not active", code: "inactive" }, { status: 409 });
  }
  if (
    !target.webhookSecretHash ||
    !verifyDeploymentWebhookSecret(token, target.webhookSecretHash)
  ) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    if (
      !request.headers.get(OCCURRENCE_EPOCH_HEADER) &&
      !request.headers.get(OCCURRENCE_ID_HEADER)
    ) {
      return NextResponse.json({ error: "Invalid request body", code: "invalid_request" }, { status: 400 });
    }
    payload = {};
  }
  payload = normalizeTickPayload({ payload, request });

  try {
    const waitUntil = readCloudflareWaitUntil();
    if (!waitUntil) {
      return NextResponse.json(
        { error: "Failed to deliver deployment tick", code: "tick_delivery_failed" },
        { status: 502 },
      );
    }

    const result = await enqueueDeploymentTickDelivery({
      workspaceId,
      target,
      payload,
      waitUntil,
      options: DEPLOYMENT_TRIGGER_DELIVERY_OPTIONS,
    });
    return NextResponse.json<TickResponse>(result, { status: 202 });
  } catch (error) {
    if (error instanceof DeploymentTriggerDeliveryError) {
      console.error(
        "[persona-bundle-deploy] tick preflight failed:",
        error.code,
        error.message,
      );
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error(
      "[persona-bundle-deploy] tick delivery failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Failed to deliver deployment tick", code: "tick_delivery_failed" },
      { status: 502 },
    );
  }
}
