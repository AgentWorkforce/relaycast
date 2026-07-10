import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schedules, executions } from "../db/schema.js";
import { getNextCronDate } from "./cron.js";
import type { Database } from "../types.js";

type WebhookOccurrence = {
  scheduleId?: string | null;
  scheduledRunAt?: number | null;
};

// --- SSRF guard for tenant-supplied webhook URLs ----------------------
//
// Threat model: a tenant can create a schedule with an arbitrary webhook
// URL that fires on every tick. Without validation, that URL can point
// at cloud metadata services (169.254.169.254, metadata.google.internal),
// loopback, or RFC1918 private ranges — turning relaycron into an SSRF
// vector from the attacker's perspective.
//
// Limitations on Cloudflare Workers:
//   - DNS rebinding / TOCTOU is NOT mitigated here: a tenant can
//     register a hostname whose DNS record points at a public IP at
//     schedule creation time, then flip the record to 127.0.0.1 before
//     a fire. Workers' fetch() does DNS resolution internally with no
//     hook for the resolved IP. If DNS rebinding is in scope, the
//     defense has to live at the Cloudflare platform layer (Egress
//     Worker Policies, Hyperdrive, or a dedicated egress proxy).
//
// What this guard reliably blocks:
//   - Tenant pastes a literal reserved-range IPv4 (127.0.0.1, 10.x,
//     169.254.169.254, etc.) — including octal/shortened smuggling.
//   - Tenant pastes a literal reserved-range IPv6 (::1, fe80::/10,
//     fc00::/7, ::ffff:127.0.0.1 IPv4-mapped, etc.).
//   - Tenant pastes a known-internal hostname (localhost,
//     metadata.google.internal, *.internal, *.local).
//   - Non-http(s) schemes (file:, gopher:, data:, etc.).

class UnsafeUrlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UnsafeUrlError";
    this.code = code;
  }
}

const BLOCKED_HOSTNAMES = new Set<string>([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  // Cloud metadata hostnames (GCE + resolved-public-looking variants).
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
]);

/**
 * Strict IPv4 parser. Rejects leading zeros, extra digits, and
 * shortened forms (e.g. "10.0.0" or "0177.0.0.1") because those can
 * be used to smuggle reserved-range IPs through lax parsers.
 */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^[0-9]+$/.test(part)) return null;
    // Reject leading zeros to avoid ambiguity with octal (e.g. "0177").
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/**
 * Returns true if the IPv4 octets fall in a reserved, loopback,
 * link-local, private, CGN, multicast, or otherwise non-public range.
 */
function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGN
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (AWS/GCE metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
  if (a >= 240) return true; // 240.0.0.0/4 reserved
  return false;
}

/**
 * Conservative IPv6 literal check. Workers' URL.hostname strips the
 * brackets from `[::1]` so we receive the bare form. False positives
 * are acceptable; false negatives are not.
 */
function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded IPv4.
  const ipv4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (ipv4Mapped) {
    const mapped = parseIpv4(ipv4Mapped[1]);
    if (mapped && isPrivateIpv4(mapped)) return true;
  }
  if (/^fc[0-9a-f]{2}:/.test(h) || /^fd[0-9a-f]{2}:/.test(h)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(h)) return true; // ff00::/8 multicast
  return false;
}

/**
 * Throws UnsafeUrlError if the URL is not safe for tenant-supplied
 * outbound fetches. Called immediately before every fetch so that a
 * schedule mutation or parse change doesn't let a stale validation
 * slip through.
 */
function assertPublicUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid_url", "URL failed to parse");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeUrlError(
      "unsupported_scheme",
      `URL scheme must be http: or https:, got ${parsed.protocol}`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) {
    throw new UnsafeUrlError("empty_host", "URL has no hostname");
  }

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new UnsafeUrlError(
      "blocked_host",
      `Hostname '${host}' is blocked from tenant-supplied webhook targets`,
    );
  }

  if (
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new UnsafeUrlError(
      "blocked_host_suffix",
      `Hostname '${host}' is in a blocked suffix`,
    );
  }

  const ipv4 = parseIpv4(host);
  if (ipv4 && isPrivateIpv4(ipv4)) {
    throw new UnsafeUrlError(
      "blocked_ipv4",
      `IPv4 ${host} is in a reserved / private / loopback range`,
    );
  }

  if (isPrivateIpv6(host)) {
    throw new UnsafeUrlError(
      "blocked_ipv6",
      `IPv6 ${host} is in a reserved / private / loopback range`,
    );
  }

  return parsed;
}

// --- Header sanitization ---------------------------------------------

export interface ExecutionResult {
  status: "success" | "failure" | "timeout";
  http_status?: number;
  response_body?: string;
  error?: string;
  duration_ms: number;
  attempt_count: number;
}

export interface RetryConfig {
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
}

export const TARGET_MISSING_PAUSE_THRESHOLD = 10;

export function nextTargetMissingState(
  prev: number,
  httpStatus: number | null | undefined,
  threshold = TARGET_MISSING_PAUSE_THRESHOLD
): { count: number; pause: boolean } {
  if (httpStatus !== 404) {
    return { count: 0, pause: false };
  }

  const previousCount = Number.isFinite(prev) && prev > 0 ? Math.floor(prev) : 0;
  const count = previousCount + 1;
  return { count, pause: count >= threshold };
}

/**
 * Sanitize tenant-supplied headers before merging into the outbound
 * fetch. Positive allowlist: only tenant-namespaced `x-*` headers are
 * passed through, with two carve-outs:
 *   - `x-agentcron-*` is reserved for our own tracing (so tenants can
 *     never spoof `X-AgentCron-Delivery`)
 *   - `x-forwarded-*` and `x-real-ip` are reserved for upstream proxies
 *     (so tenants can never inject fake client-IP signals)
 *
 * Everything else (`Host`, `Authorization`, `Cookie`, `User-Agent`,
 * `Content-Type`, standard headers of any kind) is dropped. Defaults
 * the executor sets win regardless via spread order below.
 */
function sanitizeTenantHeaders(
  tenantHeaders: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(tenantHeaders)) {
    const lower = key.toLowerCase();
    if (!lower.startsWith("x-")) continue;
    if (lower.startsWith("x-agentcron-")) continue;
    if (lower.startsWith("x-forwarded-")) continue;
    if (lower === "x-real-ip") continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveOccurrence(input: {
  payload: unknown;
  occurrence?: WebhookOccurrence;
}): Promise<{ epoch: number; id: string } | null> {
  const scheduledRunAt = input.occurrence?.scheduledRunAt;
  if (!Number.isFinite(scheduledRunAt)) {
    return null;
  }
  const payloadScheduleId = isRecord(input.payload)
    ? stringValue(input.payload.gatewayScheduleId) ?? stringValue(input.payload.scheduleId)
    : null;
  const scheduleId = payloadScheduleId ?? stringValue(input.occurrence?.scheduleId);
  if (!scheduleId) {
    return null;
  }
  const epoch = Number(scheduledRunAt);
  return {
    epoch,
    id: await sha256Hex(`${scheduleId}:${epoch}`),
  };
}

function payloadWithOccurrence(
  payload: unknown,
  occurrence: { epoch: number; id: string } | null,
): unknown {
  if (!occurrence) {
    return payload;
  }
  if (isRecord(payload)) {
    return {
      ...payload,
      occurrenceEpoch: occurrence.epoch,
      occurrenceId: occurrence.id,
    };
  }
  return {
    payload,
    occurrenceEpoch: occurrence.epoch,
    occurrenceId: occurrence.id,
  };
}

export async function executeWebhook(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  timeoutMs: number = 10000,
  occurrence?: WebhookOccurrence,
): Promise<ExecutionResult> {
  const start = Date.now();

  // SSRF guard — re-evaluated at every fetch, not cached from schedule
  // creation, so an attacker who created a schedule with a borderline
  // hostname can't bypass the check via later schema mutations. Note
  // that this only defends against literal-IP and known-hostname
  // attacks; DNS rebinding requires platform-layer egress controls.
  let validatedUrl: URL;
  try {
    validatedUrl = assertPublicUrl(url);
  } catch (err) {
    return {
      status: "failure",
      error:
        err instanceof UnsafeUrlError
          ? `blocked_url: ${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "URL validation failed",
      duration_ms: Date.now() - start,
      attempt_count: 1,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resolvedOccurrence = await resolveOccurrence({ payload, occurrence });
    const occurrenceHeaders = resolvedOccurrence
      ? {
          "X-AgentCron-Occurrence-Epoch": String(resolvedOccurrence.epoch),
          "X-AgentCron-Occurrence-Id": resolvedOccurrence.id,
        }
      : {};
    // Use `globalThis.fetch` rather than a bare `fetch` identifier: Cloudflare
    // Workers with `nodejs_compat` can hoist bare `fetch` off `globalThis` and
    // throw `TypeError: Illegal invocation`. See sage `.claude/rules/workers-fetch.md`.
    const response = await globalThis.fetch(validatedUrl.toString(), {
      method: "POST",
      // Spread order is defaults LAST so tenant-supplied (sanitized)
      // headers cannot override Content-Type, User-Agent, or the
      // X-AgentCron-Delivery tracing header.
      headers: {
        ...sanitizeTenantHeaders(headers),
        "Content-Type": "application/json",
        "User-Agent": "AgentCron/1.0",
        "X-AgentCron-Delivery": nanoid(),
        ...occurrenceHeaders,
      },
      body: JSON.stringify(payloadWithOccurrence(payload, resolvedOccurrence)),
      signal: controller.signal,
    });

    const duration_ms = Date.now() - start;
    const body = await response.text().catch(() => "");

    return {
      status: response.ok ? "success" : "failure",
      http_status: response.status,
      response_body: body.slice(0, 4096),
      duration_ms,
      attempt_count: 1,
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const isTimeout =
      err instanceof DOMException && err.name === "AbortError";
    return {
      status: isTimeout ? "timeout" : "failure",
      error: err instanceof Error ? err.message : "Unknown error",
      duration_ms,
      attempt_count: 1,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function shouldRetry(result: ExecutionResult): boolean {
  if (result.status === "success") {
    return false;
  }

  // SSRF-blocked or otherwise invalid URLs are deterministic failures;
  // retrying them will always produce the same result.
  if (result.error?.startsWith("blocked_url:")) {
    return false;
  }

  return !(
    typeof result.http_status === "number" &&
    result.http_status >= 400 &&
    result.http_status < 500
  );
}

function getBackoffDelayMs(
  retryConfig: RetryConfig,
  failedAttemptCount: number
): number {
  return retryConfig.initialBackoffMs *
    retryConfig.backoffMultiplier ** (failedAttemptCount - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWebhookWithRetry(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  timeoutMs: number = 10000,
  retryConfig: RetryConfig,
  occurrence?: WebhookOccurrence,
): Promise<ExecutionResult> {
  const maxAttempts = Math.max(1, retryConfig.maxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await executeWebhook(url, payload, headers, timeoutMs, occurrence);

    if (attempt === maxAttempts || !shouldRetry(result)) {
      return {
        ...result,
        attempt_count: attempt,
      };
    }

    await sleep(getBackoffDelayMs(retryConfig, attempt));
  }

  throw new Error("Webhook retry loop exited without returning a result");
}

export async function recordExecution(
  db: Database,
  scheduleId: string,
  transportType: "webhook" | "websocket",
  result: ExecutionResult
): Promise<string> {
  const executionId = nanoid();
  const now = new Date().toISOString();
  const startedAt = new Date(Date.now() - result.duration_ms).toISOString();

  await db.insert(executions).values({
    id: executionId,
    schedule_id: scheduleId,
    started_at: startedAt,
    completed_at: now,
    status: result.status,
    transport_type: transportType,
    http_status: result.http_status ?? null,
    response_body: result.response_body ?? null,
    error: result.error ?? null,
    duration_ms: result.duration_ms,
  });

  // Update schedule counters
  const updates: Record<string, unknown> = {
    last_run_at: now,
    run_count: sql`${schedules.run_count} + 1`,
    updated_at: now,
  };
  if (result.status !== "success") {
    updates.failure_count = sql`${schedules.failure_count} + 1`;
  }

  await db.update(schedules).set(updates).where(eq(schedules.id, scheduleId));

  return executionId;
}

export async function advanceSchedule(
  db: Database,
  scheduleId: string,
  scheduleType: string,
  cronExpression: string | null,
  timezone: string
): Promise<string | null> {
  if (scheduleType === "once") {
    await db
      .update(schedules)
      .set({ status: "completed", next_run_at: null, updated_at: new Date().toISOString() })
      .where(eq(schedules.id, scheduleId));
    return null;
  }

  if (scheduleType === "cron" && cronExpression) {
    const next = getNextCronDate(cronExpression, timezone);
    if (next) {
      const nextIso = next.toISOString();
      await db
        .update(schedules)
        .set({ next_run_at: nextIso, updated_at: new Date().toISOString() })
        .where(eq(schedules.id, scheduleId));
      return nextIso;
    }
  }

  return null;
}
