import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { recordHarnessSpendEvent } from "@/lib/billing/spend-writer";
import { normalizeModelProvider } from "@/lib/billing/house-keys";
import { getDb } from "@/lib/db";
import {
  verifyDeploymentWebhookSecret,
} from "@/lib/proactive-runtime/persona-deploy";

type UsageRouteContext = {
  params: Promise<{ workspaceId: string; agentId: string }>;
};

type RawRows<T> = { rows?: T[] };

/**
 * Dual-shape result reader — see `rowsOf` in
 * `packages/web/lib/proactive-runtime/persona-deploy.ts` for the
 * Worker (postgres-js, array-shaped) vs Lambda (node-postgres,
 * `{rows}`-shaped) rationale.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as RawRows<T>;
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function readWebhookToken(request: NextRequest): string | null {
  return request.headers.get("x-cloud-agent-deployment-token")?.trim() || null;
}

function safeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  context: UsageRouteContext,
): Promise<NextResponse<Record<string, unknown>>> {
  const token = readWebhookToken(request);
  if (!token) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  const { workspaceId, agentId } = await context.params;
  const agentResult = await getDb().execute(sql`
    SELECT id, deployed_by_user_id, credential_selections, schedule_webhook_secret_hash
    FROM agents
    WHERE id = ${agentId}
      AND workspace_id = ${workspaceId}
      AND status != 'destroyed'
    LIMIT 1
  `);
  const agent = rowsOf<{
    id: string;
    deployed_by_user_id: string;
    credential_selections: unknown;
    schedule_webhook_secret_hash: string | null;
  }>(agentResult)[0];
  if (!agent) {
    return NextResponse.json({ error: "Deployment target not found", code: "not_found" }, { status: 404 });
  }
  if (
    !agent.schedule_webhook_secret_hash ||
    !verifyDeploymentWebhookSecret(token, agent.schedule_webhook_secret_hash)
  ) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = isRecord(parsed) ? parsed : {};
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "invalid_request" }, { status: 400 });
  }

  const rawModelProvider = stringValue(body.modelProvider ?? body.model_provider);
  const modelProvider = rawModelProvider ? normalizeModelProvider(rawModelProvider) : null;
  const model = stringValue(body.model);
  if (!modelProvider || !model) {
    return NextResponse.json(
      { error: "modelProvider and model are required", code: "invalid_request" },
      { status: 400 },
    );
  }

  const selections = isRecord(agent.credential_selections) ? agent.credential_selections : {};
  const selectedCredentialId =
    stringValue(selections[modelProvider]) ??
    stringValue(rawModelProvider ? selections[rawModelProvider] : undefined);
  const reportedCredentialId = stringValue(body.providerCredentialId ?? body.provider_credential_id);
  if (!selectedCredentialId || (reportedCredentialId && reportedCredentialId !== selectedCredentialId)) {
    return NextResponse.json(
      { error: "Usage report credential does not match deployed agent", code: "credential_mismatch" },
      { status: 409 },
    );
  }

  const credentialResult = await getDb().execute(sql`
    SELECT id, model_provider, auth_type, user_id
    FROM provider_credentials
    WHERE id = ${selectedCredentialId}
      AND workspace_id = ${workspaceId}
    LIMIT 1
  `);
  const credential = rowsOf<{
    id: string;
    model_provider: string;
    auth_type: string;
    user_id: string | null;
  }>(credentialResult)[0];
  if (!credential || credential.model_provider !== modelProvider) {
    return NextResponse.json(
      { error: "Provider credential not found", code: "credential_not_found" },
      { status: 404 },
    );
  }

  const result = await recordHarnessSpendEvent({
    providerCredentialId: credential.id,
    modelProvider: credential.model_provider,
    authType: credential.auth_type,
    userId: credential.user_id ?? agent.deployed_by_user_id,
    agentId,
    runId: stringValue(body.runId ?? body.run_id),
    model,
    inputTokens: safeTokenCount(body.inputTokens ?? body.input_tokens),
    outputTokens: safeTokenCount(body.outputTokens ?? body.output_tokens),
    cacheReadTokens: safeTokenCount(body.cacheReadTokens ?? body.cache_read_tokens),
    cacheWriteTokens: safeTokenCount(body.cacheWriteTokens ?? body.cache_write_tokens),
  });

  return NextResponse.json({
    recorded: true,
    costUsdMicros: result.costUsdMicros.toString(),
    markupUsdMicros: result.markupUsdMicros.toString(),
  });
}
