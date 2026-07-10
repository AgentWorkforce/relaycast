import { NextRequest, NextResponse } from "next/server";
import { Daytona } from "@daytonaio/sdk";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { getBrokerKeySecret } from "@/lib/auth/secrets";
import { configureDaytonaFetchFirstAdapter } from "@/lib/daytona-fetch-adapter";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";
import { deriveBrokerApiKey } from "@cloud/core/auth/broker-key.js";
import { getDb } from "@/lib/db";
import { sandboxes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const URL_TTL_SECONDS = 86_400; // 24 hours (Daytona max)

function resolveDaytonaSdkConfig(): ConstructorParameters<typeof Daytona>[0] {
  configureDaytonaFetchFirstAdapter();
  const params = resolveServerDaytonaAuthParams();
  if (params.daytonaApiKey) {
    return { apiKey: params.daytonaApiKey };
  }
  return {
    jwtToken: params.daytonaJwtToken,
    organizationId: params.daytonaOrganizationId,
  };
}

type Context = {
  params: { sandboxId: string } | Promise<{ sandboxId: string }>;
};

/**
 * GET /api/v1/sandboxes/{sandboxId}/terminal
 *
 * Returns connection info for the broker's HTTP/WS API running inside a
 * Daytona sandbox.  The client connects directly to the returned URL.
 *
 * Response:
 *   { wsUrl, httpUrl, apiKey, expiresAt }
 */
export async function GET(request: NextRequest, { params }: Context) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { sandboxId } = await params;
  if (!sandboxId) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }

  // Verify the caller owns this sandbox
  const db = getDb();
  const [sandbox] = await db
    .select({ userId: sandboxes.userId, brokerPort: sandboxes.brokerPort })
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .limit(1);

  if (!sandbox || sandbox.userId !== auth.userId) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }

  if (!sandbox.brokerPort) {
    return NextResponse.json({ error: "Sandbox terminal is not available for this run" }, { status: 409 });
  }

  const brokerPort = sandbox.brokerPort;

  // Derive the broker API key (matches what the launcher passed to the sandbox)
  const serverSecret = getBrokerKeySecret();
  const apiKey = deriveBrokerApiKey(serverSecret, sandboxId);

  // Get a time-limited signed preview URL for the broker port
  const daytona = new Daytona(resolveDaytonaSdkConfig());

  let daySandbox;
  try {
    daySandbox = await daytona.get(sandboxId);
  } catch {
    return NextResponse.json({ error: "Sandbox not available" }, { status: 503 });
  }

  let preview;
  try {
    preview = await daySandbox.getSignedPreviewUrl(brokerPort, URL_TTL_SECONDS);
  } catch {
    return NextResponse.json(
      { error: "Could not create preview URL — broker may not be listening" },
      { status: 503 }
    );
  }

  const httpUrl = preview.url.replace(/\/$/, "");
  const wsUrl = httpUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws")) + "/ws";
  const expiresAt = new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString();

  return NextResponse.json({ wsUrl, httpUrl, apiKey, expiresAt });
}
