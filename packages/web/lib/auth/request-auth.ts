import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { Resource } from "sst";
import { TokenVerifier } from "@relayauth/sdk";
import type { ApiTokenSubjectType } from "./api-token-types";
import { readBearerToken } from "./bearer";
import { getAuthSessionSecret } from "./secrets";
import { readSessionFromRequest } from "./session";
import type { AuthContext } from "./types";
import type { WorkflowRecord } from "@/lib/workflows";
import { optionalEnv } from "../env";

export type RequestAuth = {
  userId: string;
  workspaceId: string;
  organizationId: string;
  source: "session" | "token" | "service" | "relayfile";
  context?: AuthContext;
  bearerToken?: string;
  daytonaOrganizationId?: string;
  scopes?: string[];
  subjectType?: ApiTokenSubjectType;
  runId?: string | null;
  relayfileSponsorId?: string | null;
};

type ResolveRequestAuthOptions = {
  allowMissingWorkspace?: boolean;
};

type ApiTokenSessionRecord = {
  userId: string;
  workspaceId: string;
  organizationId: string;
  scopes: string[];
  subjectType: ApiTokenSubjectType;
  runId: string | null;
};

type AuthContextResolver = typeof import("./auth-api")["getAuthContext"];

const SAGE_SERVICE_USER_ID = "sage-service";
const CATALOGING_SERVICE_USER_ID = "cataloging-service";
const RELAYFILE_JWT_AUDIENCE = ["relayfile"];
const DEFAULT_RELAYAUTH_JWKS_BASE_URL = "https://api.relayauth.dev";
const DEFAULT_RELAYAUTH_ISSUER = "https://relayauth.dev";

type ServiceTokenResourceName = "SageCloudApiToken" | "CatalogingCloudApiToken";

let relayfileTokenVerifier:
  | {
      jwksUrl: string;
      issuer: string;
      verifier: TokenVerifier;
    }
  | null = null;

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (normalized.length % 4)) % 4;
  const withPadding = normalized + "=".repeat(pad);
  return Buffer.from(withPadding, "base64").toString("utf8");
}

export type BearerClaims = {
  userId: string;
  workspaceId: string;
  organizationId: string | null;
  token: string;
};

export function parseBearerClaims(authHeader: string | null): BearerClaims | null {
  if (!authHeader) {
    return null;
  }

  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = trimmed.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
    const userId =
      typeof parsed.userId === "string"
        ? parsed.userId
        : typeof parsed.sub === "string"
        ? parsed.sub
        : typeof parsed.uid === "string"
        ? parsed.uid
        : null;

    const workspaceId =
      typeof parsed.workspaceId === "string"
        ? parsed.workspaceId
        : typeof parsed.workspace_id === "string"
        ? parsed.workspace_id
        : typeof parsed.wid === "string"
        ? parsed.wid
        : null;

    const organizationId =
      typeof parsed.organizationId === "string"
        ? parsed.organizationId
        : typeof parsed.organization_id === "string"
        ? parsed.organization_id
        : null;

    if (!userId || !workspaceId) {
      return null;
    }

    return {
      userId,
      workspaceId,
      organizationId,
      token,
    };
  } catch {
    return null;
  }
}

export function requireDaytonaAuth(auth: RequestAuth): {
  jwtToken: string;
  organizationId: string;
} {
  if (!auth.bearerToken) {
    throw new Error("Bearer auth token is required for Daytona access");
  }

  if (!auth.daytonaOrganizationId) {
    throw new Error("Organization ID is required in auth token for Daytona access");
  }

  return {
    jwtToken: auth.bearerToken,
    organizationId: auth.daytonaOrganizationId,
  };
}

export function requireSessionAuth(
  auth: RequestAuth | null,
): auth is RequestAuth & { source: "session"; context: AuthContext } {
  return auth?.source === "session";
}

export const DIGEST_FUNCTIONS_MANAGE_SCOPE = "workflow:digest-functions:manage" as const;
export type DigestFunctionsManageScope = typeof DIGEST_FUNCTIONS_MANAGE_SCOPE;
export const FOLLOW_USER_WORKSPACE_SCOPE = "auth:workspace:follow-user" as const;

export function requireDigestFunctionsManageScope(auth: RequestAuth | null): boolean {
  if (!auth) {
    return false;
  }
  if (auth.source === "session") {
    return true;
  }
  return requireAuthScope(auth, DIGEST_FUNCTIONS_MANAGE_SCOPE);
}

export function requireAuthScope(auth: RequestAuth | null, scope: string): boolean {
  if (!auth) {
    return false;
  }

  if (auth.source === "session") {
    return true;
  }

  // cli:auth tokens get access to legacy workflow read scopes for the user's own CLI session.
  // Workspace-scoped workflow invocation requires the explicit workflow:invoke:* scopes.
  const CLI_ALLOWED_SCOPES = [
    "cli:auth",
    "workflow:runs:read",
    "workflow:logs:read",
  ];
  if (auth.scopes?.includes("cli:auth") && CLI_ALLOWED_SCOPES.includes(scope)) {
    return true;
  }

  return auth.scopes?.includes(scope) ?? false;
}

export function requireAuthRunAccess(auth: RequestAuth | null, runId: string): boolean {
  if (!auth) {
    return false;
  }

  if (auth.source === "session") {
    return true;
  }

  return auth.runId == null || auth.runId === runId;
}

export function canAccessWorkflowRun(auth: RequestAuth | null, run: Pick<WorkflowRecord, "runId" | "userId" | "workspaceId">): boolean {
  if (!auth) {
    return false;
  }

  if (!requireAuthRunAccess(auth, run.runId)) {
    return false;
  }

  if (auth.source === "session") {
    const orgWorkspaceIds = new Set(
      (auth.context?.workspaces ?? [])
        .filter((workspace) => workspace.organization_id === auth.context?.currentOrganization.id)
        .map((workspace) => workspace.id),
    );
    return orgWorkspaceIds.has(run.workspaceId);
  }

  if (auth.source === "relayfile" && auth.relayfileSponsorId) {
    return run.workspaceId === auth.workspaceId;
  }

  return run.userId === auth.userId;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function readServiceToken(resourceName: ServiceTokenResourceName): string | undefined {
  try {
    const resource = (Resource as unknown as Record<
      ServiceTokenResourceName,
      { value?: string } | undefined
    >)[resourceName];
    return resource?.value;
  } catch {
    return undefined;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveRelayAuthJwksBaseUrl(): string {
  return stripTrailingSlash(
    optionalEnv("WEB_RELAYAUTH_URL")
      ?? optionalEnv("RELAYAUTH_URL")
      ?? optionalEnv("RelayauthUrl")
      ?? DEFAULT_RELAYAUTH_JWKS_BASE_URL,
  );
}

function resolveRelayAuthIssuer(): string {
  return stripTrailingSlash(
    optionalEnv("WEB_RELAYAUTH_ISSUER")
      ?? optionalEnv("RELAYAUTH_ISSUER")
      ?? DEFAULT_RELAYAUTH_ISSUER,
  );
}

function getRelayfileTokenVerifier(): TokenVerifier {
  const relayAuthJwksBaseUrl = resolveRelayAuthJwksBaseUrl();
  const jwksUrl = new URL("/.well-known/jwks.json", `${relayAuthJwksBaseUrl}/`).toString();
  const issuer = resolveRelayAuthIssuer();

  if (
    !relayfileTokenVerifier ||
    relayfileTokenVerifier.jwksUrl !== jwksUrl ||
    relayfileTokenVerifier.issuer !== issuer
  ) {
    relayfileTokenVerifier = {
      jwksUrl,
      issuer,
      verifier: new TokenVerifier({
        jwksUrl,
        issuer,
        audience: RELAYFILE_JWT_AUDIENCE,
      }),
    };
  }

  return relayfileTokenVerifier.verifier;
}

// TEMPORARY DIAGNOSTIC — cloud#2307. Classifies the relayfile-JWT 401
// (`verifyOrNull → null`) on /api/v1/slack/post-message et al: decodes the
// bearer WITHOUT verifying and logs sanitized claim metadata alongside the
// verifier's expected issuer / JWKS / audience, so the mismatch (expiry vs
// iss/aud/kid/claim-shape vs wrong-token-type) is one log line. NEVER logs the
// signature or the full token. Remove once the failing bearer is classified.
function decodeJwtSegmentUnverified(seg: string): Record<string, unknown> | null {
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const bin = atob(padded);
    let json = "";
    for (let i = 0; i < bin.length; i++) {
      json += "%" + bin.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return JSON.parse(decodeURIComponent(json)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function logRelayfileAuthFailureDiagnostics(bearerToken: string): void {
  try {
    const raw = bearerToken.trim();
    const prefix = raw.startsWith("relay_ag_")
      ? "relay_ag_"
      : raw.startsWith("relay_pa_")
        ? "relay_pa_"
        : raw.startsWith("relay_ws_")
          ? "relay_ws_"
          : raw.startsWith("eyJ")
            ? "jwt(eyJ)"
            : "other";
    // Unwrap relay_ag_/relay_pa_ to reach the inner JWT (matches the verifier).
    const jwt =
      raw.startsWith("relay_ag_") || raw.startsWith("relay_pa_")
        ? raw.slice("relay_ag_".length)
        : raw;
    const parts = jwt.split(".");
    const now = Math.floor(Date.now() / 1000);
    const diag: Record<string, unknown> = {
      prefix,
      segments: parts.length,
      // verifier-expected, logged alongside so the mismatch is one-line obvious
      expectedIssuer: resolveRelayAuthIssuer(),
      expectedJwksUrl: new URL(
        "/.well-known/jwks.json",
        `${resolveRelayAuthJwksBaseUrl()}/`,
      ).toString(),
      expectedAudience: RELAYFILE_JWT_AUDIENCE,
      now,
    };
    if (parts.length === 3) {
      const header = decodeJwtSegmentUnverified(parts[0]);
      const payload = decodeJwtSegmentUnverified(parts[1]);
      if (header) {
        diag.kid = header.kid;
        diag.alg = header.alg;
        diag.typ = header.typ;
      } else {
        diag.headerDecode = "failed";
      }
      if (payload) {
        diag.iss = payload.iss;
        diag.aud = payload.aud;
        diag.token_type = payload.token_type;
        diag.exp = payload.exp;
        diag.iat = payload.iat;
        diag.expired =
          typeof payload.exp === "number" ? payload.exp <= now : "n/a";
        diag.secondsPastExp =
          typeof payload.exp === "number" ? now - (payload.exp as number) : "n/a";
        diag.hasSub = "sub" in payload && Boolean(payload.sub);
        diag.hasOrg = "org" in payload && Boolean(payload.org);
        diag.hasWks = "wks" in payload && Boolean(payload.wks);
        diag.hasSponsorId = "sponsorId" in payload && Boolean(payload.sponsorId);
        diag.hasSponsorChain =
          Array.isArray(payload.sponsorChain) &&
          (payload.sponsorChain as unknown[]).length > 0;
        diag.hasJti = "jti" in payload && Boolean(payload.jti);
        // workspace id is a non-secret correlation field
        diag.wks = typeof payload.wks === "string" ? payload.wks : undefined;
      } else {
        diag.payloadDecode = "failed";
      }
    }
    console.warn("[cloud-2307-diag] relayfile-JWT 401 classify:", JSON.stringify(diag));
  } catch (err) {
    console.warn(
      "[cloud-2307-diag] decode error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function tryRelayfileJwtAuth(bearerToken: string): Promise<RequestAuth | null> {
  const claims = await getRelayfileTokenVerifier().verifyOrNull(bearerToken);
  if (!claims) {
    logRelayfileAuthFailureDiagnostics(bearerToken);
    return null;
  }
  const relayfileClaims = claims as typeof claims & {
    sponsorId?: unknown;
    metadata?: { agentName?: unknown } | null;
  };
  const relayfileSponsorId =
    typeof relayfileClaims.sponsorId === "string"
      ? relayfileClaims.sponsorId
      : typeof relayfileClaims.metadata?.agentName === "string"
      ? relayfileClaims.metadata.agentName
      : null;

  return {
    userId: claims.sub,
    workspaceId: claims.wks,
    organizationId: claims.org,
    source: "relayfile",
    bearerToken,
    scopes: claims.scopes,
    relayfileSponsorId,
  };
}

async function tryApiTokenSessionAuth(bearerToken: string): Promise<RequestAuth | null> {
  const { resolveApiTokenSession } = await import("./api-token-store");
  const tokenSession = await resolveApiTokenSession(bearerToken) as ApiTokenSessionRecord | null;
  if (!tokenSession) {
    return null;
  }

  return {
    userId: tokenSession.userId,
    workspaceId: tokenSession.workspaceId,
    organizationId: tokenSession.organizationId,
    source: "token",
    bearerToken,
    scopes: tokenSession.scopes,
    subjectType: tokenSession.subjectType,
    runId: tokenSession.runId,
  };
}

function tryServiceAuth(
  bearerToken: string,
  resourceName: ServiceTokenResourceName,
  serviceUserId: string,
): RequestAuth | null {
  const serviceToken = readServiceToken(resourceName);
  if (!serviceToken || !constantTimeEqual(bearerToken, serviceToken)) {
    return null;
  }

  return {
    userId: serviceUserId,
    workspaceId: "",
    organizationId: "",
    source: "service",
  };
}

function trySageServiceAuth(bearerToken: string): RequestAuth | null {
  return tryServiceAuth(bearerToken, "SageCloudApiToken", SAGE_SERVICE_USER_ID);
}

function tryCatalogingServiceAuth(bearerToken: string): RequestAuth | null {
  return tryServiceAuth(
    bearerToken,
    "CatalogingCloudApiToken",
    CATALOGING_SERVICE_USER_ID,
  );
}

export function resolveCatalogingServiceAuth(request: NextRequest): RequestAuth | null {
  const bearerToken = readBearerToken(request.headers.get("authorization"));
  if (!bearerToken) {
    return null;
  }
  return tryCatalogingServiceAuth(bearerToken);
}

function isNoActiveWorkspaceError(error: unknown): boolean {
  return error instanceof Error && error.message === "No active workspace";
}

function canFollowUserWorkspace(auth: Pick<RequestAuth, "subjectType" | "scopes">): boolean {
  return (
    auth.subjectType === "cli" &&
    auth.scopes?.includes(FOLLOW_USER_WORKSPACE_SCOPE) === true
  );
}

async function resolveContextForRequest(
  getAuthContext: AuthContextResolver,
  userId: string,
  preferredWorkspaceId: string,
  fallbackOrganizationId: string,
  options: ResolveRequestAuthOptions,
): Promise<Pick<RequestAuth, "workspaceId" | "organizationId" | "context">> {
  try {
    const context = await getAuthContext(
      userId,
      preferredWorkspaceId,
      fallbackOrganizationId,
    );
    return {
      workspaceId: context.currentWorkspace.id,
      organizationId: context.currentOrganization.id,
      context,
    };
  } catch (error) {
    if (!options.allowMissingWorkspace || !isNoActiveWorkspaceError(error)) {
      throw error;
    }

    return {
      workspaceId: preferredWorkspaceId,
      organizationId: fallbackOrganizationId,
    };
  }
}

export async function resolveRequestAuth(
  request: NextRequest,
  options: ResolveRequestAuthOptions = {},
): Promise<RequestAuth | null> {
  const authHeader = request.headers.get("authorization");

  let session: ReturnType<typeof readSessionFromRequest> = null;
  try {
    session = readSessionFromRequest(request, getAuthSessionSecret());
  } catch {
    // SST links not available (e.g. running outside `sst dev`); skip session auth
  }

  if (session) {
    const { getAuthContext } = await import(
      // @ts-ignore TS2835: root NodeNext typechecking pulls this Next-bundled file into a different resolver.
      "./auth-api"
    );
    const resolved = await resolveContextForRequest(
      getAuthContext,
      session.userId,
      session.currentWorkspaceId,
      session.currentOrganizationId,
      options,
    );

    return {
      userId: resolved.context?.user.id ?? session.userId,
      workspaceId: resolved.workspaceId,
      organizationId: resolved.organizationId,
      source: "session",
      context: resolved.context,
    };
  }

  const bearerToken = readBearerToken(authHeader);
  if (bearerToken) {
    const serviceAuth = trySageServiceAuth(bearerToken);
    if (serviceAuth) {
      return serviceAuth;
    }

    const tokenAuth = await tryApiTokenSessionAuth(bearerToken);
    if (tokenAuth) {
      if (!canFollowUserWorkspace(tokenAuth)) {
        return tokenAuth;
      }

      const { getAuthContext } = await import(
        // @ts-ignore TS2835: root NodeNext typechecking pulls this Next-bundled file into a different resolver.
        "./auth-api"
      );
      const resolved = await resolveContextForRequest(
        getAuthContext,
        tokenAuth.userId,
        tokenAuth.workspaceId,
        tokenAuth.organizationId,
        options,
      );
      return {
        ...tokenAuth,
        workspaceId: resolved.workspaceId,
        organizationId: resolved.organizationId,
        context: resolved.context,
      };
    }

    const relayfileAuth = await tryRelayfileJwtAuth(bearerToken);
    if (relayfileAuth) {
      return relayfileAuth;
    }
  }

  // Unverified bearer JWTs are not trusted as auth — callers that need
  // raw bearer claims (e.g. Daytona integration) should use
  // parseBearerClaims() explicitly.
  return null;
}
