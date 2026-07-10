import { NextRequest, NextResponse } from "next/server";
import { requireHostedDeployContext } from "@/lib/proactive-runtime/deploy-auth";
import { deployHostedAgent } from "@/lib/proactive-runtime/deploy-manager";

function normalizeBody(value: unknown): {
  name: string;
  model: string;
  instructions: string;
  provider: { mode: "managed" | "byok"; secretRef?: string };
  schedule?: unknown;
  watch?: unknown;
  inbox?: unknown;
  runtime: { mode?: unknown; onEventSource?: unknown };
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const instructions = typeof record.instructions === "string" ? record.instructions.trim() : "";
  const provider = (
    record.provider
    && typeof record.provider === "object"
    && !Array.isArray(record.provider)
    && (
      (record.provider as { mode?: unknown }).mode === "managed"
      || (record.provider as { mode?: unknown }).mode === "byok"
    )
  )
    ? {
        mode: (record.provider as { mode: "managed" | "byok" }).mode,
        ...(
          typeof (record.provider as { secretRef?: unknown }).secretRef === "string"
          && (record.provider as { secretRef: string }).secretRef.trim()
            ? { secretRef: (record.provider as { secretRef: string }).secretRef.trim() }
            : {}
        ),
      }
    : { mode: "managed" as const };
  const runtime =
    record.runtime && typeof record.runtime === "object" && !Array.isArray(record.runtime)
      ? (record.runtime as { mode?: unknown; onEventSource?: unknown })
      : {};

  if (!name || !model || !instructions) {
    return null;
  }

  return {
    name,
    model,
    instructions,
    provider,
    ...(record.schedule !== undefined ? { schedule: record.schedule } : {}),
    ...(record.watch !== undefined ? { watch: record.watch } : {}),
    ...(record.inbox !== undefined ? { inbox: record.inbox } : {}),
    runtime,
  };
}

export type HostedDeploymentsRouteDeps = {
  requireHostedDeployContext: typeof requireHostedDeployContext;
  deployHostedAgent: typeof deployHostedAgent;
};

const defaultDeps: HostedDeploymentsRouteDeps = {
  requireHostedDeployContext,
  deployHostedAgent,
};

export function createHostedDeploymentsRouteHandlers(
  deps: HostedDeploymentsRouteDeps = defaultDeps,
) {
  async function POST(request: NextRequest) {
    const context = await deps.requireHostedDeployContext(request);
    if (context instanceof Response) {
      return context;
    }

    const body = normalizeBody(await request.json().catch(() => null));
    if (!body) {
      return NextResponse.json({ error: "name, model, and instructions are required" }, { status: 400 });
    }

    try {
      const deployed = await deps.deployHostedAgent(context, body);
      return NextResponse.json({
        id: deployed.deploymentId,
        deployId: deployed.deploymentId,
        agentId: deployed.agentId,
        deploymentId: deployed.deploymentId,
        workspaceId: deployed.workspaceId,
        status: deployed.status,
      }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not available yet|require/i.test(message) ? 501 : 503;
      return NextResponse.json({ error: message }, { status });
    }
  }

  return { POST };
}

export const { POST } = createHostedDeploymentsRouteHandlers();
