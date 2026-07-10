import {
  introspectWorkspaceToken,
  issueAgentToken,
  type IssuedAgentToken,
  type RelayAuthEnv,
  type RelayAuthTokenClaims,
} from "./relayauth-client.js";

export type GatewayAuthEnv = RelayAuthEnv & {
  AGENT_GATEWAY_INTERNAL_SECRET: string;
};

export type AuthenticatedWorkspaceSession = {
  workspaceToken: string;
  workspaceClaims: RelayAuthTokenClaims;
  workspace: string;
};

export type AuthenticatedWebSocketSession = {
  workspaceToken: string;
  workspaceClaims: RelayAuthTokenClaims;
  workspace: string;
  agentId: string;
  agentName: string;
  issuedAgentToken: IssuedAgentToken;
};

export async function authenticateWebSocketRequest(
  request: Request,
  env: GatewayAuthEnv,
): Promise<AuthenticatedWebSocketSession> {
  const { workspaceToken, workspaceClaims, workspace } =
    await authenticateWorkspaceRequest(request, env);
  const agentId = resolveAgentId(request, workspaceClaims);
  const agentName = resolveAgentName(request, agentId);
  const issuedAgentToken = await issueAgentToken(env, {
    workspaceToken,
    workspaceClaims,
    agentId,
    agentName,
    audience: [
      env.RELAY_AGENT_AUDIENCE?.trim() || "agent-gateway",
      "relayfile",
      "relaycast",
    ],
  });

  return {
    workspaceToken,
    workspaceClaims,
    workspace,
    agentId,
    agentName,
    issuedAgentToken,
  };
}

export async function authenticateWorkspaceRequest(
  request: Request,
  env: GatewayAuthEnv,
): Promise<AuthenticatedWorkspaceSession> {
  const workspaceToken = extractBearerToken(request);
  if (!workspaceToken) {
    throw httpError(401, "missing_authorization", "Workspace token is required");
  }

  return authenticateWorkspaceToken(env, workspaceToken);
}

export async function authenticateWorkspaceToken(
  env: RelayAuthEnv,
  workspaceToken: string,
): Promise<AuthenticatedWorkspaceSession> {
  const normalizedToken = workspaceToken.trim();
  if (!normalizedToken) {
    throw httpError(401, "missing_authorization", "Workspace token is required");
  }

  const workspaceClaims = await introspectWorkspaceToken(env, normalizedToken);
  if (!workspaceClaims || workspaceClaims.token_type === "refresh") {
    throw httpError(401, "invalid_token", "Workspace token is invalid");
  }

  const workspace = workspaceClaims.wks.trim();
  if (!workspace) {
    throw httpError(401, "invalid_token", "Workspace token is missing workspace binding");
  }

  return {
    workspaceToken: normalizedToken,
    workspaceClaims,
    workspace,
  };
}

export function authenticateInternalRequest(
  request: Request,
  env: GatewayAuthEnv,
): void {
  const url = new URL(request.url);
  const headerValue =
    request.headers.get("x-agent-gateway-secret")?.trim()
    ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const queryValue = url.pathname === "/internal/cron/tick"
    ? url.searchParams.get("internal_token")?.trim()
    : undefined;
  const token = headerValue || queryValue;

  if (!token || token !== env.AGENT_GATEWAY_INTERNAL_SECRET) {
    throw httpError(401, "unauthorized", "Internal request authentication failed");
  }
}

export function httpError(
  status: number,
  code: string,
  message: string,
): Error & { status: number; code: string } {
  const error = new Error(message) as Error & { status: number; code: string };
  error.status = status;
  error.code = code;
  return error;
}

function resolveAgentId(
  request: Request,
  claims: RelayAuthTokenClaims,
): string {
  const url = new URL(request.url);
  const preferred =
    request.headers.get("x-agent-id")
    ?? url.searchParams.get("agentId")
    ?? request.headers.get("x-agent-name")
    ?? url.searchParams.get("name")
    ?? `agent-${claims.sub}`;

  return slugify(preferred, 96);
}

function resolveAgentName(request: Request, fallback: string): string {
  const url = new URL(request.url);
  const name =
    request.headers.get("x-agent-name")
    ?? url.searchParams.get("name")
    ?? request.headers.get("x-agent-id")
    ?? url.searchParams.get("agentId")
    ?? fallback;

  return name.trim() || fallback;
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token || null;
  }

  const subprotocol = request.headers.get("sec-websocket-protocol");
  if (subprotocol) {
    const parts = subprotocol.split(",").map((part) => part.trim());
    const bearerIndex = parts.findIndex((part) => part.toLowerCase() === "bearer");
    if (bearerIndex >= 0 && parts[bearerIndex + 1]) {
      return parts[bearerIndex + 1] ?? null;
    }
  }

  const token = new URL(request.url).searchParams.get("access_token")?.trim();
  return token || null;
}

export function slugify(value: string, limit: number): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (normalized || "agent").slice(0, limit);
}
