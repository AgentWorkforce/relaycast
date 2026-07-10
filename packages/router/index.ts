import { maybeRecord, type RecorderEnv } from "./src/recorder.js";
import { maybeRateLimit, type RateLimitEnv } from "./src/rate-limit.js";

interface Env {
  CLOUD_APP_ORIGIN: string;
  CLOUD_WEB_WORKER?: {
    fetch(request: Request): Promise<Response>;
  };
  FILE_OBSERVER_ORIGIN?: string;
  TRAFFIC_RECORDER?: RecorderEnv["TRAFFIC_RECORDER"];
  ROUTER_CONFIG?: RecorderEnv["ROUTER_CONFIG"];
  RATE_LIMIT_COUNTERS?: RateLimitEnv["RATE_LIMIT_COUNTERS"];
  WEBHOOK_WORKER?: {
    fetch(request: Request): Promise<Response>;
  };
  WEBHOOK_WORKER_ORIGIN?: string;
  RELAYFILE_CLOUD_WORKER?: {
    fetch(request: Request): Promise<Response>;
  };
  RELAYFILE_CLOUD_ORIGIN?: string;
}

function hasRecorderEnv(env: Env): env is Env & RecorderEnv {
  return Boolean(env.TRAFFIC_RECORDER && env.ROUTER_CONFIG);
}

// The apex agentrelay.com marketing/docs site. Served by the standalone
// agentrelay.com repo on Cloudflare Workers (OpenNext); the legacy AWS origin
// at origin.agentrelay.net is retired. See AgentWorkforce/agentrelay.com.
const FALLBACK_PROXY_ORIGIN = "https://origin-web.agentrelay.com";
const OBSERVER_ORIGIN = "https://observer.relaycast.dev";
const DEFAULT_FILE_OBSERVER_ORIGIN = "https://relayfile-file-observer.pages.dev";
const PRIMARY_HOST = "agentrelay.com";
const FILE_OBSERVER_PATH_PREFIX = "/observer/file";
const OBSERVER_PATH_PREFIX = "/observer";
const CLOUD_PATH_PREFIX = "/cloud";
const WEBHOOK_ORIGIN_FLAG_KEY = "WEBHOOK_ORIGIN";
const WEBHOOK_ORIGIN_WORKER = "worker";
const WEBHOOK_ORIGIN_RELAYFILE_CLOUD = "relayfile-cloud";

// Header set by webhook-worker's queue consumer
// (`packages/webhook-worker/src/queue-consumer.ts`'s `buildForwardHeaders`) on
// outbound forwards to cloud-web's `/api/v1/webhooks/nango`. When the
// `WEBHOOK_ORIGIN` flag is `"worker"`, the router would otherwise redirect
// every `/api/v1/webhooks/nango` POST back to webhook-worker — including
// webhook-worker's own outbound forwards, producing an infinite redelivery
// loop bounded only by `maxRetries`. Honouring this header lets webhook-worker
// reach cloud-web's `routeForwardEvent` → `handleGitHubForward` path which is
// the actual destination of the forward.
const WEBHOOK_WORKER_FORWARDED_HEADER = "x-cloud-webhook-worker-forwarded";
const WEBHOOK_WORKER_FORWARDED_VALUE = "webhook-worker";
const RELAYFILE_CLOUD_FORWARDED_HEADER =
  "x-cloud-webhook-relayfile-cloud-forwarded";
const RELAYFILE_CLOUD_FORWARDED_VALUE = "relayfile-cloud";
let loggedPhase5aLambdaEliminated = false;

// Exact paths the webhook worker handles. Other sub-paths under
// /api/v1/webhooks (notably /api/v1/webhooks/composio/connect/callback, an
// OAuth callback served by Next.js) must continue to route to the Lambda even
// when WEBHOOK_ORIGIN=worker, otherwise they 404 against the Worker.
const WEBHOOK_WORKER_PATHS = new Set<string>([
  "/api/v1/webhooks/composio",
  "/api/v1/webhooks/github",
  "/api/v1/webhooks/hookdeck",
  "/api/v1/webhooks/nango",
]);
const NANGO_WEBHOOK_WORKER_PATH = "/api/v1/webhooks/nango";
const RELAYFILE_CLOUD_NANGO_WEBHOOK_PATH = "/v1/nango/webhook";
const RELAYFILE_CLOUD_NANGO_LIFECYCLE_TYPES = new Set([
  "auth",
  "connection.created",
]);
const RELAYFILE_CLOUD_NANGO_INGEST_TYPES = new Set([
  "forward",
  "sync",
  "webhook",
]);
const RELAYFILE_CLOUD_NANGO_PROVIDER_CONFIG_KEYS = new Set([
  "github-relay",
  "github-sage",
  "github-app",
  "github-app-oauth",
  "linear-relay",
  "linear-sage",
  "notion-relay",
  "notion-sage",
  "slack-relay",
  "slack-sage",
  "slack-sage-preview",
]);

function isPathWithinPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isObserverPath(pathname: string): boolean {
  return isPathWithinPrefix(pathname, OBSERVER_PATH_PREFIX);
}

function isFileObserverPath(pathname: string): boolean {
  return isPathWithinPrefix(pathname, FILE_OBSERVER_PATH_PREFIX);
}

function isPrimaryFileObserverPath(hostname: string, pathname: string): boolean {
  return hostname === PRIMARY_HOST && isFileObserverPath(pathname);
}

function isCloudPath(pathname: string): boolean {
  return isPathWithinPrefix(pathname, CLOUD_PATH_PREFIX);
}

// True only for the exact paths the webhook worker knows how to handle. Used
// to gate worker forwarding so unrelated routes under /api/v1/webhooks/* (e.g.
// the Composio OAuth callback) still reach the Lambda.
export function isWebhookWorkerPath(pathname: string): boolean {
  return WEBHOOK_WORKER_PATHS.has(stripPathPrefix(pathname, CLOUD_PATH_PREFIX));
}

function isNangoWebhookWorkerPath(pathname: string): boolean {
  return stripPathPrefix(pathname, CLOUD_PATH_PREFIX) === NANGO_WEBHOOK_WORKER_PATH;
}

function stripPathPrefix(pathname: string, prefix: string): string {
  if (pathname === prefix) {
    return "/";
  }

  if (pathname.startsWith(`${prefix}/`)) {
    return pathname.slice(prefix.length);
  }

  return pathname;
}

function addPathPrefix(pathname: string, prefix: string): string {
  if (!prefix) {
    return pathname;
  }

  if (pathname === "/") {
    return prefix;
  }

  if (pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}?`)) {
    return pathname;
  }

  return `${prefix}${pathname}`;
}

function hostnameFromHost(host: string, protocol: string): string {
  try {
    return new URL(`${protocol}//${host}`).hostname;
  } catch {
    return host.split(":")[0] ?? host;
  }
}

function isPublicFileObserverLocation(hostname: string, pathname: string): boolean {
  return isPrimaryFileObserverPath(hostname, pathname);
}

export function getUpstreamPath(hostname: string, pathname: string): string {
  if (isPrimaryFileObserverPath(hostname, pathname)) {
    return stripPathPrefix(pathname, FILE_OBSERVER_PATH_PREFIX);
  }

  return pathname;
}

export function getMountPrefix(hostname: string, pathname: string): string {
  if (isCloudPath(pathname)) {
    return CLOUD_PATH_PREFIX;
  }

  if (isPrimaryFileObserverPath(hostname, pathname)) {
    return FILE_OBSERVER_PATH_PREFIX;
  }

  return "";
}

export function rewriteLocation(
  location: string,
  originUrl: URL,
  requestHost: string,
  requestProtocol: string,
  mountPrefix = "",
): string {
  if (!location) {
    return location;
  }

  try {
    const absolute = new URL(location);
    if (isPublicFileObserverLocation(absolute.hostname, absolute.pathname)) {
      return location;
    }

    if (absolute.hostname !== originUrl.hostname) {
      return location;
    }

    absolute.hostname = requestHost;
    absolute.port = "";
    absolute.protocol = requestProtocol;
    absolute.pathname = addPathPrefix(absolute.pathname, mountPrefix);
    return absolute.toString();
  } catch {
    if (location.startsWith("/")) {
      try {
        const requestHostname = hostnameFromHost(requestHost, requestProtocol);
        const locationUrl = new URL(location, `${requestProtocol}//${requestHost}`);
        if (isPublicFileObserverLocation(requestHostname, locationUrl.pathname)) {
          return location;
        }
      } catch {
        // Fall through to the normal mount-prefix rewrite.
      }

      return addPathPrefix(location, mountPrefix);
    }

    return location;
  }
}

export function getOrigin(hostname: string, pathname: string, env: Env): string {
  // /cloud* defaults to the Next.js cloud app regardless of host. Requests only
  // reach this fallback when the cloud-web Worker service binding is absent.
  if (isCloudPath(pathname)) {
    return env.CLOUD_APP_ORIGIN;
  }

  // The production agentrelay.com apex is a split router:
  //   1. /observer/file* goes to the RelayFile file observer app
  //   2. /observer* stays on the Relaycast observer app
  //   3. everything else falls back to the relay web origin
  if (hostname === PRIMARY_HOST) {
    if (isPrimaryFileObserverPath(hostname, pathname)) {
      return env.FILE_OBSERVER_ORIGIN ?? DEFAULT_FILE_OBSERVER_ORIGIN;
    }

    if (isObserverPath(pathname)) {
      return OBSERVER_ORIGIN;
    }
  }

  return FALLBACK_PROXY_ORIGIN;
}

async function shouldUseCloudWebWorker(
  pathname: string,
  request: Request,
  env: Env,
): Promise<boolean> {
  if (!isCloudPath(pathname)) {
    return false;
  }

  if (await shouldUseWebhookWorker(pathname, request, env)) {
    return false;
  }

  if (await shouldUseRelayfileCloudWebhook(pathname, request, env)) {
    return false;
  }

  return true;
}

function logPhase5aLambdaEliminatedOnce(): void {
  if (loggedPhase5aLambdaEliminated) {
    return;
  }

  loggedPhase5aLambdaEliminated = true;
  console.log(JSON.stringify({ router_phase: "5a_lambda_eliminated" }));
}

export async function readWebhookOriginFlag(env: Env): Promise<string | null> {
  try {
    return (await env.ROUTER_CONFIG?.get(WEBHOOK_ORIGIN_FLAG_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function shouldUseNangoWebhookWorkerRoute(
  pathname: string,
  env: Env,
): Promise<boolean> {
  if (!isNangoWebhookWorkerPath(pathname)) {
    return false;
  }

  const configured = await readWebhookOriginFlag(env);
  return configured?.trim().toLowerCase() === WEBHOOK_ORIGIN_WORKER;
}

export async function shouldUseNangoRelayfileCloudRoute(
  pathname: string,
  env: Env,
): Promise<boolean> {
  if (!isNangoWebhookWorkerPath(pathname)) {
    return false;
  }

  const configured = await readWebhookOriginFlag(env);
  return configured?.trim().toLowerCase() === WEBHOOK_ORIGIN_RELAYFILE_CLOUD;
}

function isWebhookWorkerForward(request: Request): boolean {
  return (
    request.headers.get(WEBHOOK_WORKER_FORWARDED_HEADER) ===
    WEBHOOK_WORKER_FORWARDED_VALUE
  );
}

function isRelayfileCloudForward(request: Request): boolean {
  return (
    request.headers.get(RELAYFILE_CLOUD_FORWARDED_HEADER) ===
    RELAYFILE_CLOUD_FORWARDED_VALUE
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNangoWebhookType(record: Record<string, unknown>): string | null {
  return (
    readString(record, "type") ??
    readString(record, "eventType") ??
    readString(record, "event_type")
  )?.toLowerCase() ?? null;
}

function readNangoProviderConfigKey(record: Record<string, unknown>): string | null {
  return (
    readString(record, "providerConfigKey") ??
    readString(record, "provider_config_key") ??
    readString(record, "from") ??
    readString(record, "provider")
  )?.toLowerCase() ?? null;
}

async function isRelayfileCloudNangoIngestRequest(request: Request): Promise<boolean> {
  let body: unknown;
  try {
    // Classification must not consume the forwarded request body. Nango HMAC
    // verification downstream is over the exact raw bytes the provider sent.
    body = await request.clone().json();
  } catch {
    return false;
  }

  if (!isRecord(body)) {
    return false;
  }

  const type = readNangoWebhookType(body);
  if (!type || RELAYFILE_CLOUD_NANGO_LIFECYCLE_TYPES.has(type)) {
    return false;
  }

  if (!RELAYFILE_CLOUD_NANGO_INGEST_TYPES.has(type)) {
    return false;
  }

  const providerConfigKey = readNangoProviderConfigKey(body);
  return providerConfigKey
    ? RELAYFILE_CLOUD_NANGO_PROVIDER_CONFIG_KEYS.has(providerConfigKey)
    : false;
}

async function shouldUseWebhookWorker(
  pathname: string,
  request: Request,
  env: Env,
): Promise<boolean> {
  // Break the redelivery loop: webhook-worker's queue consumer forwards the
  // raw envelope back to the same `/api/v1/webhooks/nango` route on
  // `origin.agentrelay.com` so cloud-web's `handleGitHubForward` can run.
  // Without this header check, the router catches that forward and redirects
  // it back to webhook-worker, which re-enqueues, ad infinitum (or until
  // `maxRetries`).
  if (isWebhookWorkerForward(request)) {
    return false;
  }
  return shouldUseNangoWebhookWorkerRoute(pathname, env);
}

async function shouldUseRelayfileCloudWebhook(
  pathname: string,
  request: Request,
  env: Env,
): Promise<boolean> {
  // Preserve both internal loop-break rails. The webhook-worker header handles
  // its existing forward-to-cloud path; the relayfile-cloud header gives the
  // new target the same safe return path if a future callback reaches this
  // stable provider-facing URL.
  if (isWebhookWorkerForward(request) || isRelayfileCloudForward(request)) {
    return false;
  }

  if (!(await shouldUseNangoRelayfileCloudRoute(pathname, env))) {
    return false;
  }

  return isRelayfileCloudNangoIngestRequest(request);
}

function buildWebhookWorkerRequest(
  request: Request,
  requestUrl: URL,
  workerOrigin?: string,
): Request {
  const targetUrl = new URL(requestUrl.toString());
  targetUrl.pathname = stripPathPrefix(targetUrl.pathname, CLOUD_PATH_PREFIX);

  if (workerOrigin) {
    const originUrl = new URL(workerOrigin);
    targetUrl.protocol = originUrl.protocol;
    targetUrl.hostname = originUrl.hostname;
    targetUrl.port = originUrl.port;
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
    duplex: "half",
  };

  return new Request(targetUrl.toString(), init);
}

function buildRelayfileCloudWebhookRequest(
  request: Request,
  requestUrl: URL,
  relayfileCloudOrigin?: string,
): Request {
  const targetUrl = new URL(requestUrl.toString());
  targetUrl.pathname = RELAYFILE_CLOUD_NANGO_WEBHOOK_PATH;

  if (relayfileCloudOrigin) {
    const originUrl = new URL(relayfileCloudOrigin);
    targetUrl.protocol = originUrl.protocol;
    targetUrl.hostname = originUrl.hostname;
    targetUrl.port = originUrl.port;
  }

  const headers = new Headers(request.headers);
  headers.set(RELAYFILE_CLOUD_FORWARDED_HEADER, RELAYFILE_CLOUD_FORWARDED_VALUE);

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    duplex: "half",
  };

  return new Request(targetUrl.toString(), init);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Per-key rate limiting runs BEFORE any worker routing so a runaway
    // workspace gets bounded everywhere — including webhook ingress and
    // /cloud* traffic. The bypass list inside maybeRateLimit exempts
    // health and observer paths. See packages/router/src/rate-limit.ts
    // and docs/security/rate-limiting.md.
    const rateLimited = await maybeRateLimit(request, env);
    if (rateLimited) {
      return rateLimited;
    }

    // Clone the request up front so any branch that returns early (cloud-web
    // Worker service binding, webhook Worker service binding, etc.) can
    // still feed the recorder the original payload. Without this clone, the
    // /cloud Worker path bypasses the recorder entirely and the replay
    // harness has no corpus to prove equivalence during Phase 4 cutover.
    // See Codex P2.6 on bundle PR #647.
    const recorderEnv = hasRecorderEnv(env) ? env : null;
    const recorderRequestClone = recorderEnv
      ? (request.clone() as unknown as Request)
      : null;

    if (await shouldUseCloudWebWorker(url.pathname, request, env)) {
      logPhase5aLambdaEliminatedOnce();
      if (!env.CLOUD_WEB_WORKER) {
        return new Response(
          JSON.stringify({ error: "cloud web worker binding unavailable" }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      }

      const workerResponse = await env.CLOUD_WEB_WORKER.fetch(request);
      if (recorderRequestClone && recorderEnv) {
        ctx.waitUntil(
          maybeRecord(recorderRequestClone, workerResponse.clone(), recorderEnv, ctx),
        );
      }
      return workerResponse;
    }

    if (await shouldUseRelayfileCloudWebhook(url.pathname, request, env)) {
      if (env.RELAYFILE_CLOUD_WORKER) {
        const relayfileCloudRequest = buildRelayfileCloudWebhookRequest(request, url);
        const workerResponse =
          await env.RELAYFILE_CLOUD_WORKER.fetch(relayfileCloudRequest);
        if (recorderRequestClone && recorderEnv) {
          ctx.waitUntil(
            maybeRecord(recorderRequestClone, workerResponse.clone(), recorderEnv, ctx),
          );
        }
        return workerResponse;
      }

      const relayfileCloudOrigin = env.RELAYFILE_CLOUD_ORIGIN?.trim();
      if (relayfileCloudOrigin) {
        const originResponse = await globalThis.fetch(
          buildRelayfileCloudWebhookRequest(request, url, relayfileCloudOrigin),
        );
        if (recorderRequestClone && recorderEnv) {
          ctx.waitUntil(
            maybeRecord(recorderRequestClone, originResponse.clone(), recorderEnv, ctx),
          );
        }
        return originResponse;
      }

      return new Response(
        JSON.stringify({ error: "relayfile-cloud worker binding unavailable" }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (await shouldUseWebhookWorker(url.pathname, request, env)) {
      const webhookWorkerRequest = buildWebhookWorkerRequest(request, url);
      if (env.WEBHOOK_WORKER) {
        const workerResponse = await env.WEBHOOK_WORKER.fetch(webhookWorkerRequest);
        if (recorderRequestClone && recorderEnv) {
          ctx.waitUntil(
            maybeRecord(recorderRequestClone, workerResponse.clone(), recorderEnv, ctx),
          );
        }
        return workerResponse;
      }

      const workerOrigin = env.WEBHOOK_WORKER_ORIGIN?.trim();
      if (workerOrigin) {
        const originResponse = await globalThis.fetch(
          buildWebhookWorkerRequest(request, url, workerOrigin),
        );
        if (recorderRequestClone && recorderEnv) {
          ctx.waitUntil(
            maybeRecord(recorderRequestClone, originResponse.clone(), recorderEnv, ctx),
          );
        }
        return originResponse;
      }
    }

    const requestHost = request.headers.get("Host") || url.hostname;
    const originUrl = new URL(getOrigin(url.hostname, url.pathname, env));
    const mountPrefix = getMountPrefix(url.hostname, url.pathname);

    url.pathname = getUpstreamPath(url.hostname, url.pathname);
    url.hostname = originUrl.hostname;
    url.port = "";
    url.protocol = "https:";

    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Host", requestHost);
    headers.set("X-Original-Host", requestHost);
    headers.set("X-Forwarded-Proto", "https");
    if (mountPrefix) {
      headers.set("X-Forwarded-Prefix", mountPrefix);
    }

    // Reuse the clone made at the top of fetch() for the recorder. The
    // earlier clone covers all branches; making a second one here would
    // be wasted bytes on every request and would double-record on the
    // Lambda origin path.
    const recordingRequest = recorderRequestClone;
    const subRequest = new Request(url.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });

    try {
      // Use `globalThis.fetch` rather than a bare `fetch` identifier: Cloudflare
      // Workers can hoist bare `fetch` off `globalThis` and throw
      // `TypeError: Illegal invocation`. See sage `.claude/rules/workers-fetch.md`.
      const upstreamResponse = await globalThis.fetch(subRequest);
      const responseHeaders = new Headers(upstreamResponse.headers);

      const location = responseHeaders.get("Location");
      if (location) {
        responseHeaders.set(
          "Location",
          rewriteLocation(location, originUrl, requestHost, "https:", mountPrefix),
        );
      }

      const response = new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });

      if (recordingRequest && hasRecorderEnv(env)) {
        ctx.waitUntil(maybeRecord(recordingRequest, response.clone(), env, ctx));
      }

      return response;
    } catch (error) {
      return new Response(JSON.stringify({ error: (error as Error).message }), {
        status: 500,
      });
    }
  },
};
