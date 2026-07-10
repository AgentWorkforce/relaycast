import { RelayAuthError, TokenVerifier } from "@relayauth/sdk";
import type { RelayAuthTokenClaims } from "@relayauth/sdk";
import { createMiddleware } from "hono/factory";
import type { AppContext, AppEnv, Bindings } from "../env.js";
import { fetchWorkspaceDOWithBackpressure } from "../workspace-do-backpressure.js";

export interface TokenClaims {
  workspaceId: string;
  agentName: string;
  /**
   * Optional product identifier from the JWT (`product_id` claim). Used for
   * dedup tracking so the server can record which product originally wrote
   * a given contentIdentity. Absent on legacy tokens minted before the
   * platform-v1 wave-1 relayauth bump.
   */
  productId?: string;
  scopes: Set<string>;
  exp: number;
}

const DEFAULT_RELAYAUTH_JWKS_URL =
  "https://api.relayauth.dev/.well-known/jwks.json";
const DEFAULT_RELAYAUTH_ISSUER = "https://relayauth.dev";
const RELAYFILE_AUDIENCE = "relayfile";

// Module-level TokenVerifier cache so the JWKS fetch is shared across
// requests in the same Worker isolate. Keyed on (jwksUrl, issuer) so a
// stage-specific override rebuilds a distinct verifier and we never
// accidentally accept a token meant for a different issuer.
const verifierCache = new Map<string, TokenVerifier>();

function getRelayAuthVerifier(
  env: Pick<Bindings, "RELAYAUTH_JWKS_URL" | "RELAYAUTH_ISSUER">,
): TokenVerifier {
  const jwksUrl = env.RELAYAUTH_JWKS_URL?.trim() || DEFAULT_RELAYAUTH_JWKS_URL;
  const issuer = env.RELAYAUTH_ISSUER?.trim() || DEFAULT_RELAYAUTH_ISSUER;
  const cacheKey = `${jwksUrl}::${issuer}`;
  const cached = verifierCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const verifier = new TokenVerifier({
    jwksUrl,
    issuer,
    audience: [RELAYFILE_AUDIENCE],
  });
  verifierCache.set(cacheKey, verifier);
  return verifier;
}

interface AuthErrorShape {
  status: number;
  code: string;
  message: string;
}

const DEFAULT_INTERNAL_MAX_SKEW_MS = 5 * 60 * 1000;

export function getCorrelationId(c: AppContext): string {
  return (
    c.get("correlationId") ?? c.req.header("X-Correlation-Id")?.trim() ?? ""
  );
}

export function jsonError(
  c: AppContext,
  status: number,
  code: string,
  message: string,
  correlationId = getCorrelationId(c),
): Response {
  return c.json(
    {
      code,
      message,
      correlationId,
    },
    status as any,
  );
}

export const requireCorrelationId = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const correlationId = c.req.header("X-Correlation-Id")?.trim() ?? "";
    if (!correlationId) {
      return jsonError(
        c,
        400,
        "bad_request",
        "missing X-Correlation-Id header",
        "",
      );
    }
    c.set("correlationId", correlationId);
    await next();
  });

/**
 * Match a required scope (`fs:read`, `fs:write`, `fs:manage`, etc.)
 * against the granted scopes on a token's claims. Accepts BOTH the
 * coarse bare form (`fs:read`) AND the relayauth path-scoped form
 * (`relayfile:fs:read:/github/*`).
 *
 * Pre-this-fix, the cloud-side check was a literal `Set.has(required)`
 * — token grants of the form `relayfile:fs:read:/github/*` (what
 * relayauth's `/v1/tokens/path` mints, and what the cloud-agent box
 * and proactive runtime both use) didn't match the `fs:read`
 * requirement, returning 403 `missing required scope: fs:read` on
 * every relayfile-mount poll. Verified against proactive-agents#108
 * post-cloud#984 + #993: mount daemon authenticated (no more 401
 * invalid jwt header), but every sync cycle hit this 403 and the
 * cleanup-trap flush hammered them until Daytona's proxy 524'd.
 *
 * Match logic mirrors the Go-side `scopeMatches` in
 * `agentworkforce/relayfile/internal/httpapi/auth.go`:
 *   - bare exact match wins (`claims.scopes.has(required)`)
 *   - otherwise: parse required as `resource:action`, iterate granted
 *     scopes as `plane:res:act[:path]`, accept if plane is
 *     `relayfile` or `*`, res matches required.resource (or `*`),
 *     act matches required.action (or `*`, or `manage` when required
 *     action is `read` / `write`)
 *
 * Does NOT do path-aware matching here — that's a separate
 * `scopeMatchesPath` concern when an endpoint specifies a concrete
 * path. The top-level `requireBearerScope` middleware is bare-
 * capability matching, which is what this helper handles.
 */
function scopeActionMatches(granted: string, required: string): boolean {
  if (granted === required || granted === "*") {
    return true;
  }
  return granted === "manage" && (required === "read" || required === "write");
}

function pathScopeForRequired(
  scope: string,
  resource: string,
  action: string,
): string | null {
  const segments = scope.split(":", 4);
  if (segments.length < 3) {
    return null;
  }

  const [plane] = segments;
  if (plane === "relayfile" || plane === "*") {
    const [, grantedResource, grantedAction, grantedPath] = segments;
    if (grantedResource !== resource && grantedResource !== "*") {
      return null;
    }
    if (!scopeActionMatches(grantedAction, action)) {
      return null;
    }
    return grantedPath?.trim() || "*";
  }

  if (plane === "workspace") {
    // RelayAuth workspace path grants are shaped as
    // `workspace:<sponsor>:read:/path/**`; the second segment is the
    // sponsor, not an fs resource. Treat these as filesystem path grants.
    const [, , grantedAction, grantedPath] = segments;
    if (resource !== "fs" || !scopeActionMatches(grantedAction, action)) {
      return null;
    }
    return grantedPath?.trim() || "*";
  }

  return null;
}

export function scopePathMatchesPath(
  scopePath: string,
  filePath: string,
): boolean {
  if (scopePathMatchesPathLiteral(scopePath, filePath)) {
    return true;
  }

  const normalizedScopePath = normalizeSlackChannelPathForAuth(scopePath);
  const normalizedFilePath = normalizeSlackChannelPathForAuth(filePath);
  if (normalizedScopePath !== scopePath || normalizedFilePath !== filePath) {
    return scopePathMatchesPathLiteral(normalizedScopePath, normalizedFilePath);
  }

  return false;
}

function scopePathMatchesPathLiteral(
  scopePath: string,
  filePath: string,
): boolean {
  if (scopePath === filePath) {
    return true;
  }
  if (scopePath === "*") {
    return true;
  }
  if (scopePathHasInternalSegmentGlob(scopePath)) {
    return scopePathSegmentGlobMatches(scopePath, filePath);
  }
  if (scopePath.endsWith("/**")) {
    const scopeDir = scopePath.slice(0, -"/**".length);
    return filePath === scopeDir || filePath.startsWith(`${scopeDir}/`);
  }
  if (scopePath.endsWith("/*")) {
    const scopeDir = scopePath.slice(0, -"/*".length);
    return filePath.startsWith(`${scopeDir}/`);
  }
  if (scopePath.endsWith("*")) {
    return filePath.startsWith(scopePath.slice(0, -1));
  }
  return false;
}

function scopePathHasInternalSegmentGlob(scopePath: string): boolean {
  const withoutTrailingGlob = scopePath.endsWith("/**")
    ? scopePath.slice(0, -"/**".length)
    : scopePath.endsWith("/*")
      ? scopePath.slice(0, -"/*".length)
      : scopePath;
  return withoutTrailingGlob
    .split("/")
    .some((segment) => segment === "*" || segment === "**");
}

function scopePathSegmentGlobMatches(
  scopePath: string,
  filePath: string,
): boolean {
  const scopeSegments = scopePath.split("/").filter(Boolean);
  const fileSegments = filePath.split("/").filter(Boolean);
  const memo = new Map<string, boolean>();

  const matches = (scopeIndex: number, fileIndex: number): boolean => {
    const key = `${scopeIndex}:${fileIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const segment = scopeSegments[scopeIndex];
    let result = false;
    if (segment === undefined) {
      result = fileIndex === fileSegments.length;
    } else if (segment === "**") {
      result = matches(scopeIndex + 1, fileIndex) ||
        (fileIndex < fileSegments.length && matches(scopeIndex, fileIndex + 1));
    } else if (fileIndex < fileSegments.length) {
      result =
        (segment === "*" || segment === fileSegments[fileIndex]) &&
        matches(scopeIndex + 1, fileIndex + 1);
    }

    memo.set(key, result);
    return result;
  };

  return matches(0, 0);
}

function normalizeSlackChannelPathForAuth(path: string): string {
  return path.replace(
    /^\/slack\/channels\/([^/]+)/,
    (_match, channelSegment: string) => {
      const channelId = channelSegment.split("__", 1)[0] || channelSegment;
      return `/slack/channels/${channelId}`;
    },
  );
}

export function scopeMatchesPath(
  claims: TokenClaims,
  requiredScope: string,
  filePath: string,
): boolean {
  const parts = requiredScope.split(":");
  if (parts.length < 2) {
    return false;
  }
  const [resource, action] = parts;
  let hasNarrowPathGrant = false;

  for (const scope of claims.scopes) {
    const scopePath = pathScopeForRequired(scope, resource, action);
    if (scopePath === null) {
      continue;
    }
    if (scopePath === "*") {
      return true;
    }
    hasNarrowPathGrant = true;
    if (filePath && scopePathMatchesPath(scopePath, filePath)) {
      return true;
    }
  }

  if (claims.scopes.has(requiredScope)) {
    return !hasNarrowPathGrant;
  }
  return false;
}

function scopeMatches(claims: TokenClaims, requiredScope: string): boolean {
  if (claims.scopes.has(requiredScope)) {
    return true;
  }
  const parts = requiredScope.split(":");
  if (parts.length < 2) {
    return false;
  }
  const [resource, action] = parts;
  for (const granted of claims.scopes) {
    if (pathScopeForRequired(granted, resource, action) !== null) return true;
  }
  return false;
}

export function scopeMatchesCapability(
  claims: TokenClaims,
  requiredScope: string,
): boolean {
  return scopeMatches(claims, requiredScope);
}

export function hasAnyScope(
  claims: TokenClaims,
  ...requiredScopes: string[]
): boolean {
  if (requiredScopes.length === 0) {
    return true;
  }
  return requiredScopes.some((scope) => scopeMatches(claims, scope));
}

/**
 * Cloud-internal writers whose `fs.write` / `fs.bulkWrite` calls represent
 * a SYNC ingest from an upstream provider, NOT a user/agent-driven mutation
 * that should be written back to the provider.
 *
 * The Nango sync worker and workflow mint tokens with reserved agent names
 * and call the same `writeFile` SDK that user-facing agents use. Without
 * this gate every synced record (e.g. a `/notion/pages/<id>.json` row)
 * would create a writeback op and the queue consumer would attempt to
 * UPDATE the upstream record by calling the Notion adapter — which fails
 * permanently because the synced record shape has no `properties` field.
 *
 * **Trust model.** This check is only safe because every name in this set
 * is also reserved at token-issuance time — see `RESERVED_AGENT_NAMES` in
 * `packages/web/lib/relay-workspaces.ts:isValidAgentName`. External callers
 * who hit `/v1/workspaces/:id/join` or `/v1/agents/provision` cannot mint a
 * token with these names, so any token claims hitting `isProviderSyncWriter`
 * must have come from an internal `mintRelayfileToken` call.
 *
 * Keep this list in sync with the agentName claims minted by every
 * cloud-internal sync worker AND with `RESERVED_AGENT_NAMES` in
 * relay-workspaces.ts. New entries must be added to both.
 */
const PROVIDER_SYNC_AGENT_NAMES = new Set([
  "cloud-github",
  "nango-sync-worker",
  "nango-sync-workflow",
  "github-clone-worker",
]);

export function isProviderSyncWriter(
  claims: TokenClaims | null | undefined,
): boolean {
  if (!claims) {
    return false;
  }
  return isProviderSyncAgentName(claims.agentName);
}

export function isProviderSyncAgentName(
  agentName: string | null | undefined,
): boolean {
  return (
    typeof agentName === "string" && PROVIDER_SYNC_AGENT_NAMES.has(agentName)
  );
}

export function isGithubCloneWriter(
  claims: TokenClaims | null | undefined,
): boolean {
  return claims?.agentName === "github-clone-worker";
}

export async function authorizeBearer(
  authHeader: string | undefined,
  env: BearerEnv,
  workspaceId: string,
  requiredScope: string,
  scopePath?: string,
): Promise<TokenClaims> {
  const claims = await parseBearer(authHeader, env);
  if (workspaceId && claims.workspaceId !== workspaceId) {
    throw {
      status: 403,
      code: "forbidden",
      message: "workspace mismatch",
    } satisfies AuthErrorShape;
  }
  const authorized =
    scopePath === undefined
      ? scopeMatchesPath(claims, requiredScope, "")
      : scopeMatchesPath(claims, requiredScope, scopePath);
  if (requiredScope && !authorized) {
    throw {
      status: 403,
      code: "forbidden",
      message: `missing required scope: ${requiredScope}`,
    } satisfies AuthErrorShape;
  }
  return claims;
}

export const requireBearerScope = (requiredScope: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    try {
      const claims = await authorizeBearer(
        c.req.header("Authorization"),
        c.env,
        c.req.param("workspaceId") ?? "",
        requiredScope,
      );
      c.set("authClaims", serializeClaims(claims));
      await next();
    } catch (error) {
      const authError = toAuthError(error);
      return jsonError(c, authError.status, authError.code, authError.message);
    }
  });

export const requireBearerCapabilityScope = (requiredScope: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    try {
      const claims = await authorizeBearer(
        c.req.header("Authorization"),
        c.env,
        c.req.param("workspaceId") ?? "",
        "",
      );
      if (!scopeMatchesCapability(claims, requiredScope)) {
        return jsonError(
          c,
          403,
          "forbidden",
          `missing required scope: ${requiredScope}`,
        );
      }
      c.set("authClaims", serializeClaims(claims));
      await next();
    } catch (error) {
      const authError = toAuthError(error);
      return jsonError(c, authError.status, authError.code, authError.message);
    }
  });

export const requireBearerScopeForPath = (
  requiredScope: string,
  pathForRequest: (c: AppContext) => string,
) =>
  createMiddleware<AppEnv>(async (c, next) => {
    try {
      const claims = await authorizeBearer(
        c.req.header("Authorization"),
        c.env,
        c.req.param("workspaceId") ?? "",
        requiredScope,
        pathForRequest(c),
      );
      c.set("authClaims", serializeClaims(claims));
      await next();
    } catch (error) {
      const authError = toAuthError(error);
      return jsonError(c, authError.status, authError.code, authError.message);
    }
  });

export const requireBearerAnyScope = (...requiredScopes: string[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    try {
      const claims = await authorizeBearer(
        c.req.header("Authorization"),
        c.env,
        "",
        "",
      );
      if (!hasAnyScope(claims, ...requiredScopes)) {
        return jsonError(
          c,
          403,
          "forbidden",
          `missing required scope: ${requiredScopes[0] ?? ""}`,
        );
      }
      c.set("authClaims", serializeClaims(claims));
      await next();
    } catch (error) {
      const authError = toAuthError(error);
      return jsonError(c, authError.status, authError.code, authError.message);
    }
  });

export async function authorizeWebSocketToken(
  c: AppContext,
  workspaceId: string,
  requiredScope: string,
  scopePath?: string,
): Promise<TokenClaims> {
  const token = c.req.query("token")?.trim();
  if (!token) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "missing or invalid bearer token",
    } satisfies AuthErrorShape;
  }
  return authorizeBearer(
    `Bearer ${token}`,
    c.env,
    workspaceId,
    requiredScope,
    scopePath,
  );
}

export async function authorizeWebSocketTokenCapability(
  c: AppContext,
  workspaceId: string,
  requiredScope: string,
): Promise<TokenClaims> {
  const token = c.req.query("token")?.trim();
  if (!token) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "missing or invalid bearer token",
    } satisfies AuthErrorShape;
  }
  const claims = await authorizeBearer(
    `Bearer ${token}`,
    c.env,
    workspaceId,
    "",
  );
  if (!scopeMatchesCapability(claims, requiredScope)) {
    throw {
      status: 403,
      code: "forbidden",
      message: `missing required scope: ${requiredScope}`,
    } satisfies AuthErrorShape;
  }
  return claims;
}

export async function verifyInternalHmac(
  headers: Headers,
  body: ArrayBuffer,
  secret: string | undefined,
): Promise<void> {
  const timestamp = headers.get("X-Relay-Timestamp")?.trim() ?? "";
  const signature =
    headers.get("X-Relay-Signature")?.trim().toLowerCase() ?? "";
  if (!timestamp || !signature) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "missing internal auth headers",
    } satisfies AuthErrorShape;
  }

  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "invalid internal timestamp",
    } satisfies AuthErrorShape;
  }

  const delta = Math.abs(Date.now() - ts);
  if (delta > DEFAULT_INTERNAL_MAX_SKEW_MS) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "internal request outside replay window",
    } satisfies AuthErrorShape;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(requireSecret(secret, "INTERNAL_HMAC_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    concatBuffers(encoder.encode(`${timestamp}\n`), new Uint8Array(body)),
  );
  const expected = bytesToHex(new Uint8Array(signed));
  if (signature !== expected) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "internal signature mismatch",
    } satisfies AuthErrorShape;
  }
}

export async function signInternalHmac(
  timestamp: string,
  body: string | ArrayBuffer | Uint8Array,
  secret: string | undefined,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(requireSecret(secret, "INTERNAL_HMAC_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bodyBytes =
    typeof body === "string"
      ? encoder.encode(body)
      : body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : body;
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    concatBuffers(encoder.encode(`${timestamp}\n`), bodyBytes),
  );
  return bytesToHex(new Uint8Array(signed));
}

export async function signRelayWebhookPayload(
  timestamp: string,
  rawBody: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  return bytesToHex(new Uint8Array(signed));
}

export function getWorkspaceStub(
  c: AppContext,
  workspaceId: string,
): DurableObjectStub {
  const id = c.env.WORKSPACE_DO.idFromName(workspaceId);
  return c.env.WORKSPACE_DO.get(id);
}

export async function forwardToWorkspaceDO(
  c: AppContext,
  workspaceId: string,
  pathname?: string,
  requestOverride?: Request,
): Promise<Response> {
  const source = requestOverride ?? c.req.raw;
  const url = new URL(source.url);
  if (pathname) {
    url.pathname = pathname;
  }
  const headers = new Headers(source.headers);
  headers.delete("content-length");
  headers.set("X-Workspace-Id", workspaceId);
  const authClaims = c.get("authClaims");
  if (authClaims?.workspaceId) {
    headers.set("X-Auth-Workspace-Id", authClaims.workspaceId);
  }
  const init: RequestInit = {
    method: source.method,
    headers,
    redirect: "manual",
  };
  if (!["GET", "HEAD"].includes(source.method.toUpperCase())) {
    init.body = await source.clone().arrayBuffer();
  }
  return fetchWorkspaceDOWithBackpressure(
    getWorkspaceStub(c, workspaceId),
    new Request(url.toString(), init),
    {
      reason: "durable_object_overloaded",
      retryAfterSeconds: positiveInt(c.env.RELAYFILE_DO_RETRY_AFTER_SECONDS, 5),
    },
  );
}

export function getAdminStubKey(c: AppContext): string {
  return c.req.query("workspaceId")?.trim() || "__admin__";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type BearerEnv = Pick<Bindings, "RELAYAUTH_JWKS_URL" | "RELAYAUTH_ISSUER">;

// Relayauth's `/v1/tokens/path` and `/v1/tokens/workspace` mint endpoints
// wrap the access token they issue with a class-prefix
// (`relay_pa_<jwt>`, `relay_ws_<jwt>`, `relay_id_<jwt>`). The prefix
// encodes the token class for clients that route by token type, but is
// NOT part of the RS256 JWS string that follows.
//
// Pre-fix, `parseBearer` would `.split(".")` the raw bearer without
// stripping the prefix. For a `relay_pa_eyJ.eyJ.<sig>` token, `parts[0]`
// ended up as `relay_pa_eyJ<header_b64>`. The base64url decode either
// surfaced as "invalid jwt header" (decoded bytes weren't valid JSON)
// or — if the prefix happened to land outside the dot-segments — as
// "invalid jwt format". Net effect: every relayauth-wrapped token
// returned 401 even though the underlying JWT was perfectly valid.
//
// Most visibly this broke `relayfile-mount` running inside the cloud
// proactive runtime's per-fire Daytona sandboxes: the daemon polls
// `/v1/workspaces/<ws>/fs/events` with this bearer, hit 401 on every
// cycle, never pushed handler drafts to relayfile cloud or the
// upstream provider. Cloud-agent boxes share the same mint helper so
// they were silently broken the same way; nobody noticed because
// neither flow had an E2E test asserting on relayfile-side state.
//
// Keep this in sync with the prefixes minted by relayauth's
// `packages/server/src/routes/tokens.ts` (`relay_pa_*` for path-access,
// `relay_ws_*` for workspace, `relay_id_*` for identity, `relay_ag_*`
// for agent — the delegated-token / `relayfile workspace join` chain
// issues `relay_ag_` access tokens via `/v1/tokens/agent`).
const RELAYAUTH_TOKEN_PREFIXES = [
  "relay_pa_",
  "relay_ws_",
  "relay_id_",
  "relay_ag_",
] as const;

export function stripRelayauthTokenPrefix(raw: string): string {
  for (const prefix of RELAYAUTH_TOKEN_PREFIXES) {
    if (raw.startsWith(prefix)) {
      return raw.slice(prefix.length);
    }
  }
  return raw;
}

async function parseBearer(
  authHeader: string | undefined,
  env: BearerEnv,
): Promise<TokenClaims> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "missing or invalid bearer token",
    } satisfies AuthErrorShape;
  }

  const raw = stripRelayauthTokenPrefix(
    authHeader.slice("Bearer ".length).trim(),
  );
  const parts = raw.split(".");
  if (parts.length !== 3) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "invalid jwt format",
    } satisfies AuthErrorShape;
  }

  const [encodedHeader] = parts;
  const header = parseJson<Record<string, unknown>>(
    decodeBase64Url(encodedHeader),
    "invalid jwt header",
  );
  const alg = typeof header.alg === "string" ? header.alg : "";

  if (alg !== "RS256") {
    // HS256 (and any other alg) rejected unconditionally. The HS256 shared-
    // secret path was retired as part of the relayfile RS256 migration
    // (cloud#318): sage + specialist-worker now mint RS256 tokens via
    // RelayAuth's /v1/tokens. `RELAYFILE_JWT_SECRET` is no longer a
    // supported binding — attempts to use it were soak-verified silent
    // via RELAYFILE_VERIFIER_ACCEPT_HS256="false" in phase 1 (cloud#321).
    throw {
      status: 401,
      code: "unauthorized",
      message: "unsupported jwt algorithm",
    } satisfies AuthErrorShape;
  }

  return verifyRs256(raw, env);
}

async function verifyRs256(
  rawToken: string,
  env: Pick<Bindings, "RELAYAUTH_JWKS_URL" | "RELAYAUTH_ISSUER">,
): Promise<TokenClaims> {
  const verifier = getRelayAuthVerifier(env);

  let claims: RelayAuthTokenClaims;
  try {
    // TokenVerifier handles signature, kid lookup, iss, aud, exp, nbf.
    // `audience` is set at construction time to ["relayfile"], and `issuer`
    // to the relayauth production issuer (overridable via RELAYAUTH_ISSUER).
    claims = await verifier.verify(rawToken);
  } catch (error) {
    // Distinguish infrastructure failure (JWKS unreachable) from auth
    // failure (invalid token). Collapsing both to 401 would hide outages
    // and misconfigured bindings as rejected-token errors.
    if (error instanceof RelayAuthError && error.code === "jwks_fetch_failed") {
      throw {
        status: 503,
        code: "jwks_unreachable",
        message: "relayauth JWKS unreachable",
      } satisfies AuthErrorShape;
    }
    throw {
      status: 401,
      code: "unauthorized",
      message: errorMessage(error) || "invalid rs256 token",
    } satisfies AuthErrorShape;
  }

  return normalizeClaims(claims as unknown as Record<string, unknown>);
}

/**
 * Normalize a RelayAuth-issued RS256 JWT payload to the internal TokenClaims
 * shape. HS256 is rejected upstream in `parseBearer`, so only relayauth-native
 * claims are accepted here: `wks` for workspace, `sponsorId` for the logical
 * agent (with `sub`, the identity UUID, as a fallback when a token has no
 * sponsor).
 */
export function normalizeClaims(payload: Record<string, unknown>): TokenClaims {
  const workspaceId = typeof payload.wks === "string" ? payload.wks.trim() : "";
  if (!workspaceId) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "missing workspace claim",
    } satisfies AuthErrorShape;
  }

  // Prefer `sponsorId` so ACL rules like `allow:agent:cloud-workspace-admin`
  // match the logical agent; `sub` is the identity UUID and only used when
  // no sponsor is set.
  const sponsorId =
    typeof payload.sponsorId === "string" ? payload.sponsorId.trim() : "";
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const agentName = sponsorId || sub;
  if (!agentName) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "missing subject claim",
    } satisfies AuthErrorShape;
  }

  const exp = parseExp(payload.exp);
  if (exp === null) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "invalid exp claim",
    } satisfies AuthErrorShape;
  }
  // TokenVerifier already validates `exp`/`aud` for RS256 tokens against
  // the constructor config, but re-checking here keeps `normalizeClaims`
  // self-contained (e.g., the pure unit tests in
  // test/auth-normalize-claims.test.ts assert the expiry/aud contract
  // without going through TokenVerifier).
  if (Math.floor(Date.now() / 1000) >= exp) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "token expired",
    } satisfies AuthErrorShape;
  }

  if (!hasAudience(payload.aud, RELAYFILE_AUDIENCE)) {
    throw {
      status: 401,
      code: "unauthorized",
      message: "invalid aud claim",
    } satisfies AuthErrorShape;
  }

  const scopes = parseScopes(payload.scopes);
  if (scopes.size === 0) {
    throw {
      status: 403,
      code: "forbidden",
      message: "no scopes granted",
    } satisfies AuthErrorShape;
  }

  // Optional — wave-1 of the platform-v1 migration introduced per-workspace
  // product tagging. Absent on legacy tokens; dedup code handles the
  // undefined case by falling back to agentName.
  const rawProductId =
    typeof payload.product_id === "string" ? payload.product_id.trim() : "";
  const productId = rawProductId.length > 0 ? rawProductId : undefined;

  return { workspaceId, agentName, productId, scopes, exp };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function serializeClaims(
  claims: TokenClaims,
): AppEnv["Variables"]["authClaims"] {
  return {
    workspaceId: claims.workspaceId,
    agentName: claims.agentName,
    scopes: [...claims.scopes],
    exp: claims.exp,
  };
}

function parseScopes(value: unknown): Set<string> {
  const scopes = new Set<string>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) {
        scopes.add(entry.trim());
      }
    }
    return scopes;
  }
  if (typeof value === "string") {
    for (const scope of value.split(/\s+/)) {
      if (scope.trim()) {
        scopes.add(scope.trim());
      }
    }
  }
  return scopes;
}

function hasAudience(value: unknown, required: string): boolean {
  if (typeof value === "string") {
    return value.trim() === required;
  }
  if (Array.isArray(value)) {
    return value.some(
      (entry) => typeof entry === "string" && entry.trim() === required,
    );
  }
  return false;
}

function parseExp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function decodeBase64Url(value: string, errorMessage?: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const decoded = atob(padded);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw {
      status: 401,
      code: "unauthorized",
      message: errorMessage ?? "invalid base64 payload",
    } satisfies AuthErrorShape;
  }
}

function parseJson<T>(bytes: Uint8Array, errorMessage: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw {
      status: 401,
      code: "unauthorized",
      message: errorMessage,
    } satisfies AuthErrorShape;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBuffers(left: Uint8Array, right: Uint8Array): ArrayBuffer {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged.buffer.slice(
    merged.byteOffset,
    merged.byteOffset + merged.byteLength,
  );
}

function requireSecret(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw {
      status: 500,
      code: "configuration_error",
      message: `missing required secret: ${name}`,
    } satisfies AuthErrorShape;
  }
  return trimmed;
}

function toAuthError(error: unknown): AuthErrorShape {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    "code" in error &&
    "message" in error
  ) {
    const authError = error as AuthErrorShape;
    return authError;
  }
  return {
    status: 500,
    code: "internal_error",
    message: error instanceof Error ? error.message : "Internal server error",
  };
}
