import { NextRequest, NextResponse } from "next/server";
import { Daytona } from "@daytonaio/sdk";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { getBrokerKeySecret } from "@/lib/auth/secrets";
import { configureDaytonaFetchFirstAdapter } from "@/lib/daytona-fetch-adapter";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";
import { deriveBrokerApiKey } from "@cloud/core/auth/broker-key.js";
import { getSnapshotName } from "@cloud/core/config/snapshot.js";
import { getDb } from "@/lib/db";
import { sandboxes } from "@/lib/db/schema";

const BROKER_PORT = 9800;

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

/**
 * POST /api/v1/sandboxes
 *
 * Creates a Daytona sandbox with a running agent-relay broker.
 * Used by the desktop app to spawn cloud agents without a workflow.
 *
 * Response:
 *   { sandboxId, brokerPort, status }
 */
export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const daytona = new Daytona(resolveDaytonaSdkConfig());

  // Create sandbox from snapshot (has @agent-relay/sdk + CLIs pre-installed)
  let sandbox;
  try {
    sandbox = await daytona.create({ snapshot: await getSnapshotName(), autoStopInterval: 60 }, { timeout: 120 });
  } catch {
    try {
      sandbox = await daytona.create({ language: "javascript", autoStopInterval: 60 }, { timeout: 120 });
    } catch {
      return NextResponse.json({ error: "Failed to create sandbox" }, { status: 503 });
    }
  }

  try {
    const home = (await sandbox.getUserHomeDir()) ?? "/home/daytona";
    const brokerSecret = getBrokerKeySecret();
    const brokerApiKey = deriveBrokerApiKey(brokerSecret, sandbox.id);

    // Ensure @agent-relay/sdk is installed (snapshot may already have it)
    const depsCheck = await sandbox.process.executeCommand(
      'node -e "require(\'@agent-relay/sdk\')" 2>/dev/null',
      home,
    );
    if (depsCheck.exitCode !== 0) {
      await sandbox.process.executeCommand(
        `cd ${home} && npm init -y 2>/dev/null && npm install @agent-relay/sdk 2>&1 | tail -3`,
        home,
        undefined,
        120,
      );
    }

    // Start the broker in the background
    const brokerCmd = [
      `export RELAY_BROKER_API_KEY='${brokerApiKey}'`,
      `export TERM=xterm-256color`,
      `BROKER=$(node -e "const p=require('path');const r=require.resolve('@agent-relay/sdk');const suffix=process.platform+'-'+process.arch;console.log(p.join(p.dirname(r),'..','bin','agent-relay-broker-'+suffix))")`,
      `nohup $BROKER init --api-port ${BROKER_PORT} --api-bind 0.0.0.0 --name pear > ${home}/broker.log 2>&1 &`,
    ].join(" && ");

    await sandbox.process.executeCommand(brokerCmd, home);

    // Wait for broker to be ready (poll /health)
    let brokerReady = false;
    for (let i = 0; i < 15; i++) {
      const check = await sandbox.process.executeCommand(
        `curl -sf http://127.0.0.1:${BROKER_PORT}/health 2>/dev/null`,
        home,
      );
      if (check.exitCode === 0) {
        brokerReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!brokerReady) {
      throw new Error("Broker failed to start");
    }

    // Record sandbox in DB
    const now = new Date();
    await getDb().insert(sandboxes).values({
      id: sandbox.id,
      userId: auth.userId,
      organizationId: auth.organizationId,
      workspaceId: auth.workspaceId,
      source: "pear",
      status: "running",
      brokerPort: BROKER_PORT,
      createdAt: now,
      updatedAt: now,
    });

    return NextResponse.json({ sandboxId: sandbox.id, brokerPort: BROKER_PORT, status: "running" });
  } catch (error) {
    try {
      await daytona.delete(sandbox);
    } catch {
      // best-effort cleanup
    }

    const message = error instanceof Error ? error.message : "Failed to initialize sandbox";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
