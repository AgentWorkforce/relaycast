// Per-key request rate limiting for the Cloudflare edge gateways.
//
// Two Workers front the platform: the `AgentRelayRouter` worker
// (agentrelay.com / cloud router) and the `RelayfileApi` worker
// (api.relayfile.dev). A misbehaving client today (e.g. a relayfile
// mount stuck in a polling loop) can hammer either gateway with
// dozens of requests per second; the upstream Lambda has a 10-slot
// concurrency cap, so once a single key saturates the gateway every
// other user starts seeing 429s. The rate limiter in this module
// runs at the edge BEFORE the request reaches the Lambda, so a
// runaway key is contained to its own per-workspace bucket and
// doesn't deplete shared capacity.
//
// Design choices (intentional trade-offs):
//
//   * Counter storage is Cloudflare KV (a `RATE_LIMIT_COUNTERS`
//     namespace bound to both Workers). KV is eventually consistent
//     across edges, so the effective ceiling at high traffic can be
//     ~2-3x the configured per-minute limit. For the 60 req/min
//     target that means ~180 req/min worst case — still 100x lower
//     than the runaway today and good enough for the runaway-client
//     class of bug. Sub-second precision and global atomicity would
//     require a Durable Object, which we may add later if KV drift
//     bites — but the simpler path ships first.
//
//   * Buckets are minute-aligned (epoch-minute integer). Each
//     `(limitKey, bucket)` pair is one KV key with a 120-second TTL
//     so the previous and current minute coexist briefly during the
//     turn. Reads are racy w.r.t. writes; that's accepted (see above).
//
//   * Limits are read from `ROUTER_CONFIG` KV at request time, so
//     operators can dial them up/down or kill-switch the limiter
//     entirely via `wrangler kv:key put` without redeploying.
//
//   * Defaults: 60 req/min per workspace-or-user-or-ip key, 1000
//     req/min global ceiling (a separate safety-net counter shared
//     across all keys). Both defaults are intentionally conservative
//     given the actual runaway pattern observed (30+ req/sec from a
//     single key).
//
//   * Bypass list mirrors the recorder's deny list plus a few
//     observability paths — these must never be rate limited because
//     they're either health probes, browser asset requests, or
//     observer/webhook ingress that already has its own backpressure.

const ONE_MINUTE_SECONDS = 60;
// KV TTL on counter entries. Must be >= 60 to cover a full bucket
// window even if the request arrives at the very start of the
// minute. We pick 120s so the previous bucket is still readable
// briefly during the turnover, which means a borderline client that
// straddles the boundary still sees its prior count and can't double
// up by ~timing requests across the second.
const COUNTER_TTL_SECONDS = 120;

// Default config — operators tune via `wrangler kv:key put` on the
// `ROUTER_CONFIG` namespace; we re-read every request.
const DEFAULT_PER_KEY_PER_MIN = 60;
const DEFAULT_GLOBAL_PER_MIN = 1000;

// KV config keys we read from `ROUTER_CONFIG`. Centralized here so
// the docs and the infra seed step refer to the same names.
export const RATE_LIMIT_CONFIG_KEYS = {
  PER_KEY_PER_MIN: "RATE_LIMIT_PER_WORKSPACE_PER_MIN",
  GLOBAL_PER_MIN: "RATE_LIMIT_GLOBAL_PER_MIN",
  DISABLED: "RATE_LIMIT_DISABLED",
  // Comma-separated path prefixes added to the bypass list at
  // runtime. Static `BYPASS_PREFIXES` below is the safe core; this
  // key lets an operator whitelist a new path (e.g. a freshly-added
  // health probe) without redeploying. Values are matched the same
  // way as static prefixes — exact match or `${prefix}/...` startswith.
  // Example KV value: `/api/k8s-readiness,/internal/uptime`
  BYPASS_PREFIXES_EXTRA: "RATE_LIMIT_BYPASS_PREFIXES_EXTRA",
} as const;

// Paths that must NEVER be rate limited. Health probes, static
// assets, and observability endpoints. The router/relayfile-api
// share this list — both Workers see these paths even though only
// one of them actually serves them, and accidentally rate-limiting
// a health probe would self-DoS the upstream monitoring.
const BYPASS_PREFIXES: readonly string[] = [
  "/api/health",
  "/health",
  "/observer",
  "/_next/static",
  "/favicon.ico",
  // Webhook ingress has no auth token and no workspace path, so it
  // would bucket by IP and trip the 60/min cap with even modest
  // burst traffic from a single provider (GitHub, Composio, Nango,
  // Hookdeck). The webhook worker already has queue-backed
  // backpressure, so rate-limiting at the edge would only cause us
  // to drop legitimate events. See Codex P1.4 on bundle PR #647.
  "/api/v1/webhooks",
];

export interface RateLimitEnv {
  // Counter storage — shared across both gateway Workers so a
  // workspace's limit isn't accidentally doubled by hitting both.
  RATE_LIMIT_COUNTERS?: KVNamespace;
  // Configuration knobs — same KV namespace the router already uses
  // for other flags (e.g. WEBHOOK_ORIGIN). Optional so unit tests
  // can run without it.
  ROUTER_CONFIG?: KVNamespace;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec?: number;
  counter: number;
  limit: number;
  // The key the decision applies to — exposed so callers can put it
  // in the 429 body (helps operators correlate gateway logs with the
  // offending workspace/user/IP).
  key: string;
}

// Pure path helper so we can unit test it without a real Request.
// Checks ONLY the static hardcoded prefix list — does not consult KV.
// Use `isBypassPathDynamic` when env is available and you want the
// runtime-extensible bypass list to apply.
export function isBypassPath(pathname: string): boolean {
  return matchesAnyPrefix(pathname, BYPASS_PREFIXES);
}

function matchesAnyPrefix(
  pathname: string,
  prefixes: readonly string[],
): boolean {
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

// Module-scoped cache for the KV-resolved extra bypass prefixes.
// Refreshed at most once per `BYPASS_EXTRAS_TTL_MS` per Worker
// isolate. Operators tuning the KV value see propagation within
// roughly `BYPASS_EXTRAS_TTL_MS` plus the time CF's eventually-
// consistent KV takes to fan out to edges (typically <60s). This
// is the same staleness window that applies to the existing numeric
// config keys (`RATE_LIMIT_PER_WORKSPACE_PER_MIN`, etc.) — keeping
// the model consistent across all runtime knobs.
const BYPASS_EXTRAS_TTL_MS = 60_000;
let cachedBypassExtras: readonly string[] = [];
let cachedBypassExtrasFetchedAt = 0;

/**
 * Test-only: reset the bypass-extras cache between test cases.
 * Production code never calls this.
 */
export function __resetBypassExtrasCacheForTests(): void {
  cachedBypassExtras = [];
  cachedBypassExtrasFetchedAt = 0;
}

async function getBypassExtras(
  env: RateLimitEnv,
  now: number,
): Promise<readonly string[]> {
  if (!env.ROUTER_CONFIG) {
    return [];
  }
  if (now - cachedBypassExtrasFetchedAt < BYPASS_EXTRAS_TTL_MS) {
    return cachedBypassExtras;
  }
  try {
    const raw = await env.ROUTER_CONFIG.get(
      RATE_LIMIT_CONFIG_KEYS.BYPASS_PREFIXES_EXTRA,
    );
    cachedBypassExtras = parseBypassExtras(raw);
    cachedBypassExtrasFetchedAt = now;
  } catch {
    // ROUTER_CONFIG read failures should never break the data plane.
    // Keep the last known list (or the empty initial) and try again
    // after the TTL.
    cachedBypassExtrasFetchedAt = now;
  }
  return cachedBypassExtras;
}

/**
 * Exported for unit tests. Parses the comma-separated KV value into a
 * deduped, trimmed list of prefixes, filtering out anything that
 * doesn't look like an absolute path (must start with `/`). Defensive
 * parsing — bad operator input shouldn't be able to break the bypass
 * check.
 */
export function parseBypassExtras(raw: string | null): readonly string[] {
  if (!raw) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("/")) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Returns true if the path should bypass rate limiting — checks both
 * the static `BYPASS_PREFIXES` list and the KV-runtime-tunable
 * `RATE_LIMIT_BYPASS_PREFIXES_EXTRA` list. The static check is fast
 * (no KV read); the KV list is cached per-isolate for
 * `BYPASS_EXTRAS_TTL_MS`. Used by `maybeRateLimit` internally.
 *
 * @param pathname - the URL pathname to check
 * @param env - rate limit env containing the KV bindings
 * @param now - wall-clock ms; injectable for tests
 */
export async function isBypassPathDynamic(
  pathname: string,
  env: RateLimitEnv,
  now: number = Date.now(),
): Promise<boolean> {
  if (isBypassPath(pathname)) {
    return true;
  }
  const extras = await getBypassExtras(env, now);
  return matchesAnyPrefix(pathname, extras);
}

// Extract a workspace ID from any of the path shapes both gateways
// see. Matches the literal "workspaces/" segment (Hono routes both
// `/v1/workspaces/:id/...` on the relayfile worker and
// `/cloud/api/v1/workspaces/:id/...` on the cloud router).
function extractWorkspaceId(pathname: string): string | null {
  const match = pathname.match(/\/workspaces\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

// Cheap, non-cryptographic hash for opaque bearer tokens so we can
// shard rate counters by token without ever storing the token. We
// don't need collision resistance against an adversary — we just
// want different tokens to map to different buckets. FNV-1a 32-bit
// fits in a few lines and is fine for this.
function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit multiply, kept unsigned via `>>> 0`.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// The session cookie name used by the web app. Must match
// `SESSION_COOKIE_NAME` in `packages/core/src/session/jwt.ts`.
// Defined inline here to keep the rate-limit module self-contained —
// the router package has no dependency on the web package.
const SESSION_COOKIE_NAME = "agent_relay_session";

// Parse a single named cookie out of a Cookie header value. Returns
// null when the cookie is absent or has an empty value. Handles both
// quoted and unquoted values; uses the first match when the name
// appears more than once (which is invalid per RFC 6265 but occurs
// in the wild).
function parseCookieValue(cookieHeader: string, name: string): string | null {
  // Regex: look for `; name=` or start-of-string `name=`, then capture
  // the value up to the next `;` or end-of-string.
  const pattern = new RegExp(
    `(?:^|;)\\s*${name}\\s*=\\s*"?([^";]*)"?(?:;|$)`,
  );
  const match = cookieHeader.match(pattern);
  const value = match?.[1]?.trim() ?? null;
  return value && value.length > 0 ? value : null;
}

// Build a stable limit key from the incoming request. Pure function —
// no network calls, no JWKS verify (too expensive for the hot path).
// Order of precedence reflects which signal is most specific:
//
//   1. workspace ID from the path (covers the actual runaway shape)
//   2. authenticated user via bearer token hash (covers non-workspace
//      authenticated traffic — e.g. /api/v1/me)
//   3. session cookie for cookie-authenticated /cloud* traffic. Without
//      this, cookie-auth requests have neither a workspace ID nor an
//      auth header and collapse to IP buckets — conflating all users
//      that share a NAT IP into one rate limit bucket. We hash the
//      cookie value with FNV-1a 32 so the rate counter key never
//      contains the raw session token.
//   4. CF-connecting-IP (anonymous fallback; X-Forwarded-For untrusted
//      because anyone can set it, but `cf-connecting-ip` is set by
//      Cloudflare edge and can't be spoofed by the client)
//   5. "anon" — last-resort bucket so a misbehaving anon flood is
//      still bounded, just bundled together (acceptable: this is the
//      least-trusted traffic anyway)
export function extractLimitKey(request: Request): string {
  const url = new URL(request.url);
  const workspaceId = extractWorkspaceId(url.pathname);
  if (workspaceId) {
    return `ws:${workspaceId}`;
  }

  const auth = request.headers.get("authorization");
  if (auth) {
    // Strip the scheme prefix ("Bearer ", "Basic ", etc.) before
    // hashing so the same token doesn't bucket differently when a
    // client toggles capitalization or omits the scheme.
    const token = auth.replace(/^[A-Za-z]+\s+/, "").trim();
    if (token.length > 0) {
      return `user:${fnv1a32Hex(token)}`;
    }
  }

  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const sessionToken = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
    if (sessionToken) {
      return `session:${fnv1a32Hex(sessionToken)}`;
    }
  }

  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  if (ip) {
    return `ip:${ip}`;
  }

  return "anon";
}

async function readNumberConfig(
  kv: KVNamespace | undefined,
  configKey: string,
  fallback: number,
): Promise<number> {
  if (!kv) {
    return fallback;
  }
  try {
    const raw = await kv.get(configKey);
    if (raw == null) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  } catch {
    // ROUTER_CONFIG read failures should never break the data plane —
    // we'd rather rate-limit at the default than 500 every request.
    return fallback;
  }
}

async function readBooleanConfig(
  kv: KVNamespace | undefined,
  configKey: string,
): Promise<boolean> {
  if (!kv) {
    return false;
  }
  try {
    const raw = await kv.get(configKey);
    return raw?.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

// Increment-and-read with KV. Not atomic — two concurrent requests at
// the same edge can both read N, both write N+1, and we lose a count.
// Accepted per the module-level note. The `now` parameter is injected
// for testability.
async function bumpCounter(
  kv: KVNamespace,
  bucketKey: string,
  now: number,
): Promise<number> {
  let prior = 0;
  try {
    const raw = await kv.get(bucketKey);
    if (raw != null) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        prior = parsed;
      }
    }
  } catch {
    // Counter-store read failure — treat as zero and continue.
    // Failing closed (blocking the request) on a transient KV error
    // would amplify a single CF KV hiccup into a customer outage.
    prior = 0;
  }

  const next = prior + 1;
  try {
    await kv.put(bucketKey, String(next), {
      expirationTtl: COUNTER_TTL_SECONDS,
    });
  } catch {
    // Same reasoning — log via the surrounding fetch handler if
    // observability is needed, but never break the request.
  }
  void now; // reserved for future jittered TTLs; keeps the signature stable
  return next;
}

function bucketForNow(now: number): number {
  return Math.floor(now / 1000 / ONE_MINUTE_SECONDS);
}

function secondsUntilNextBucket(now: number): number {
  const elapsedInMinute = Math.floor(now / 1000) % ONE_MINUTE_SECONDS;
  return Math.max(1, ONE_MINUTE_SECONDS - elapsedInMinute);
}

export interface CheckRateLimitOptions {
  // Injected for deterministic tests; defaults to Date.now() in prod.
  now?: () => number;
}

export async function checkRateLimit(
  key: string,
  env: RateLimitEnv,
  options: CheckRateLimitOptions = {},
): Promise<RateLimitDecision> {
  const nowFn = options.now ?? (() => Date.now());
  const now = nowFn();

  const [disabled, perKeyLimit, globalLimit] = await Promise.all([
    readBooleanConfig(env.ROUTER_CONFIG, RATE_LIMIT_CONFIG_KEYS.DISABLED),
    readNumberConfig(
      env.ROUTER_CONFIG,
      RATE_LIMIT_CONFIG_KEYS.PER_KEY_PER_MIN,
      DEFAULT_PER_KEY_PER_MIN,
    ),
    readNumberConfig(
      env.ROUTER_CONFIG,
      RATE_LIMIT_CONFIG_KEYS.GLOBAL_PER_MIN,
      DEFAULT_GLOBAL_PER_MIN,
    ),
  ]);

  if (disabled || !env.RATE_LIMIT_COUNTERS) {
    return { allowed: true, counter: 0, limit: perKeyLimit, key };
  }

  const bucket = bucketForNow(now);
  const perKeyBucket = `rl:${key}:${bucket}`;
  const globalBucket = `rl:__global__:${bucket}`;

  // Sequential reads/writes — KV doesn't support transactions and
  // we want the global counter to include this request even if the
  // per-key one rejects. Order is intentional: per-key first so a
  // single runaway key doesn't get to skew the global ceiling by
  // also incrementing the global bucket *before* its per-key check
  // would have rejected it. Net effect: a blocked request still
  // contributes 1 to per-key but NOT to global.
  const perKeyCount = await bumpCounter(
    env.RATE_LIMIT_COUNTERS,
    perKeyBucket,
    now,
  );

  if (perKeyCount > perKeyLimit) {
    return {
      allowed: false,
      retryAfterSec: secondsUntilNextBucket(now),
      counter: perKeyCount,
      limit: perKeyLimit,
      key,
    };
  }

  const globalCount = await bumpCounter(
    env.RATE_LIMIT_COUNTERS,
    globalBucket,
    now,
  );

  if (globalCount > globalLimit) {
    return {
      allowed: false,
      retryAfterSec: secondsUntilNextBucket(now),
      counter: globalCount,
      limit: globalLimit,
      key: "__global__",
    };
  }

  return {
    allowed: true,
    counter: perKeyCount,
    limit: perKeyLimit,
    key,
  };
}

// Builds the 429 response. Centralized so both Workers return the
// same shape; clients (relayfile mount, CLI) can rely on it.
export function rateLimitResponse(
  retryAfterSec: number,
  key: string,
): Response {
  const body = JSON.stringify({
    error: "rate_limited",
    retryAfter: retryAfterSec,
    limitKey: key,
  });
  return new Response(body, {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSec),
      "x-ratelimit-key": key,
    },
  });
}

// Convenience wrapper that combines bypass check, key extraction,
// the actual limit check, and the 429 response. Both Workers call
// this at the very top of their fetch handler.
//
// Returns:
//   * `null` — request is allowed; continue to normal handling
//   * `Response` — return this 429 immediately
export async function maybeRateLimit(
  request: Request,
  env: RateLimitEnv,
  options: CheckRateLimitOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  // Check both the static `BYPASS_PREFIXES` and the KV-runtime-tunable
  // extras (cached 60s per isolate). Static check is fast; KV cache
  // means at most one KV read per minute per isolate per Worker.
  if (await isBypassPathDynamic(url.pathname, env, options.now?.() ?? Date.now())) {
    return null;
  }

  const key = extractLimitKey(request);
  const decision = await checkRateLimit(key, env, options);
  if (decision.allowed) {
    return null;
  }
  return rateLimitResponse(decision.retryAfterSec ?? 60, decision.key);
}
