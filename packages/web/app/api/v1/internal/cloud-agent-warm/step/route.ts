import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { optionalEnv, tryResourceValue } from "@/lib/env";
import { readWorkerEnv } from "@/lib/aws/runtime";
import { readBearerTokenFromRequest } from "@/lib/integrations/slack-proxy-auth";

import {
  failExhaustedCloudAgentBoxWarmJob,
  processCloudAgentBoxWarmStep,
} from "../../../workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/warm-step-processor";
import type { CloudAgentBoxWarmStep } from "../../../workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/warm-job-store";

/**
 * Internal cloud-agent-box warm-step endpoint (issue #1384, slice 3b/option-b).
 *
 * The thin CF-Queue consumer Worker forwards each queue message here via a
 * service binding. cloud-web (which already bundles + runs the daytona warm
 * code) executes ONE warm step (or the DLQ/exhausted path) and re-enqueues the
 * next step via its CLOUD_AGENT_WARM_QUEUE producer binding. This keeps all
 * native-dep (ssh2/daytona) code on cloud-web's proven OpenNext bundle — the
 * consumer Worker carries none.
 *
 * Auth: internal bearer token == BrokerHmacSecret (shared, already linked to
 * cloud-web + the consumer Worker). NOTE for cloud-team sanity-check: this is a
 * shared-secret bearer (constant-time compared); swap to HMAC-signing if you
 * prefer replay protection.
 *
 * DORMANT: never called until CLOUD_AGENT_WARM_VIA_QUEUE flips on (the route
 * does not enqueue yet) — so no traffic reaches this endpoint in prod.
 */

function readInternalToken(): string | null {
  const fromResource = tryResourceValue("BrokerHmacSecret");
  if (fromResource) return fromResource;
  const workerEnv = readWorkerEnv();
  const fromWorker = workerEnv?.BROKER_HMAC_SECRET;
  if (typeof fromWorker === "string" && fromWorker.length > 0) return fromWorker;
  return optionalEnv("BROKER_HMAC_SECRET") ?? null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

type StepRequestBody = {
  jobId?: unknown;
  expectedStep?: unknown;
  dlq?: unknown;
};

export async function POST(request: NextRequest): Promise<Response> {
  const provided = readBearerTokenFromRequest(request);
  if (!provided) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const expected = readInternalToken();
  if (!expected || !constantTimeEqual(provided, expected)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: StepRequestBody;
  try {
    body = (await request.json()) as StepRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.jobId !== "string" || typeof body.expectedStep !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const payload = {
    jobId: body.jobId,
    expectedStep: body.expectedStep as CloudAgentBoxWarmStep,
  };

  try {
    if (body.dlq === true) {
      await failExhaustedCloudAgentBoxWarmJob(payload);
      return NextResponse.json({ outcome: "exhausted" });
    }
    const result = await processCloudAgentBoxWarmStep({ payload });
    if (result.outcome === "retry") {
      // Retryable Daytona upstream timeout (524) — the step released its lease
      // without advancing. Return 503 so the consumer does NOT ack and the CF
      // Queue redelivers this same step (→ DLQ after maxRetries).
      return NextResponse.json(result, { status: 503 });
    }
    return NextResponse.json(result);
  } catch (error) {
    // Transient — let the consumer's CF Queue retry (→ DLQ after maxRetries).
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
