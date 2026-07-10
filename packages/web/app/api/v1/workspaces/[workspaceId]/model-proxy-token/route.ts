import { NextRequest, NextResponse } from "next/server";
import { Resource } from "sst";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  CLOUD_INTEGRATIONS_WRITE_SCOPE,
  hasCloudControlScope,
} from "@/lib/integrations/integration-route-handler";
import { optionalEnv } from "@/lib/env";
import {
  hasWorkspaceIntegrationAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";
import {
  mintCredentialProxyToken,
  type ProxyProvider,
} from "@cloud/core/auth/proxy-token.js";

/**
 * Tier-2 GenUI model-auth fallback for the watchdog-recorder.
 *
 * When a customer's Mac has no local `claude` login, the recorder mints a
 * short-lived `relay-llm-proxy` token here and points the spawned `claude`
 * agent at the cloud credential-proxy (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY=
 * <this token>). The proxy injects the relay house Anthropic key SERVER-SIDE —
 * the house key never leaves the cloud; only this scoped, expiring JWT lands on
 * the customer machine.
 *
 * Auth mirrors connect-session: the customer's cli:auth login token (stored in
 * the recorder Keychain) + workspace access. This endpoint mints the token
 * directly via mintCredentialProxyToken; it does NOT touch the orchestrator's
 * SUPPORTED_PROXY_PROVIDERS gate (that would flip cloud-spawned claude sandboxes
 * onto the proxy fleet-wide — out of scope here). The credential-proxy Worker
 * must have the matching upstream key bound (ANTHROPIC_API_KEY ← HouseAnthropicKey).
 */

type RouteContext = { params: Promise<{ workspaceId: string }> };

// Providers the recorder may mint for. Narrow on purpose (anthropic only today).
// Each entry requires the matching upstream key bound on the proxy Worker.
const MINTABLE_PROVIDERS: ReadonlySet<string> = new Set<string>(["anthropic"]);

// 2h covers a full GenUI authoring run (>300s, observed >7min) with no mid-run
// refresh; the app mints a fresh token per generation.
const DEFAULT_TTL_SECONDS = 2 * 60 * 60;
const MAX_TTL_SECONDS = 2 * 60 * 60;
const MIN_TTL_SECONDS = 60;

type ModelProxyTokenBody = {
  provider?: unknown;
  ttlSeconds?: unknown;
};

function resolveProxyJwtSecret(): string | undefined {
  let linked: string | undefined;
  try {
    linked = (Resource as unknown as Record<string, { value?: string } | undefined>)
      .CredentialProxyJwtSecret?.value;
  } catch {
    linked = undefined;
  }
  return linked && linked.length > 0
    ? linked
    : optionalEnv("CREDENTIAL_PROXY_JWT_SECRET");
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId } = await context.params;

  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Same control-plane gate as connect-session: session OR cli:auth/cloud-write
  // scope, and crucially REJECTS relayfile-source tokens (hasCloudControlScope
  // returns false for auth.source === "relayfile"). This endpoint hands back a
  // house-key-backed model-proxy JWT, so a relayfile path token carrying a broad
  // cli:auth scope must NOT be able to mint one.
  if (!hasCloudControlScope(auth, CLOUD_INTEGRATIONS_WRITE_SCOPE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: ModelProxyTokenBody = {};
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength !== "0") {
      body = (await request.json()) as ModelProxyTokenBody;
    }
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const provider =
    typeof body.provider === "string" && body.provider.trim()
      ? body.provider.trim().toLowerCase()
      : "anthropic";
  if (!MINTABLE_PROVIDERS.has(provider)) {
    return NextResponse.json(
      {
        error: "unsupported_provider",
        message: `provider must be one of: ${[...MINTABLE_PROVIDERS].join(", ")}`,
      },
      { status: 400 },
    );
  }

  let ttlSeconds = DEFAULT_TTL_SECONDS;
  if (body.ttlSeconds !== undefined) {
    if (typeof body.ttlSeconds !== "number" || !Number.isFinite(body.ttlSeconds)) {
      return NextResponse.json(
        { error: "invalid_request", message: "ttlSeconds must be a number" },
        { status: 400 },
      );
    }
    ttlSeconds = Math.min(
      MAX_TTL_SECONDS,
      Math.max(MIN_TTL_SECONDS, Math.floor(body.ttlSeconds)),
    );
  }

  const baseURL = optionalEnv("CREDENTIAL_PROXY_URL");
  const secret = resolveProxyJwtSecret();
  if (!baseURL || !secret) {
    return NextResponse.json(
      {
        error: "proxy_not_configured",
        message: "The model proxy is not configured for this stage.",
      },
      { status: 503 },
    );
  }

  const token = await mintCredentialProxyToken({
    subject: identity.relayWorkspaceId,
    provider: provider as ProxyProvider,
    credentialId: auth.userId,
    secret,
    ttlSeconds,
  });

  const expiresAt = new Date(
    (Math.floor(Date.now() / 1000) + ttlSeconds) * 1000,
  ).toISOString();

  return NextResponse.json({
    token,
    baseURL,
    expiresAt,
    provider,
    workspaceId,
    relayWorkspaceId: identity.relayWorkspaceId,
  });
}
