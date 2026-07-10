import { Resource } from "sst";

/**
 * Thin client for sage's `/api/internal/proactive/*` endpoints. Cloud's
 * Integrations → Slack UI uses these to read + write the per-workspace
 * notify channel preference that drives sage's proactive follow-ups loop.
 *
 * Auth uses the existing shared `sageCloudApiToken` (bound to cloud as
 * `Resource.SageCloudApiToken`, read by sage as `CLOUD_API_TOKEN`). One
 * token, one auth surface, no new IAM scope. See sage PR
 * `feat/proactive-prefs-api` for the receiving endpoint contracts and
 * the validateAuth pattern they use.
 */

const DEFAULT_SAGE_BASE_URL = "https://sage.agentrelay.com";
const DEFAULT_SAGE_BASE_URL_DEV = "http://localhost:3777";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface NotifyChannelPref {
  channel: string;
  confirmed: boolean;
  unconfirmedPosts: number;
}

export interface NotifyChannelPrefResponse {
  pref: NotifyChannelPref | null;
  prefStoreAvailable: boolean;
}

export interface BotChannel {
  id: string;
  name: string;
  topic?: string;
  purpose?: string;
  numMembers?: number;
}

export interface BotChannelsResponse {
  channels: BotChannel[];
}

function readEnvString(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Strip a trailing Slack-webhook path so we can reuse `SAGE_WEBHOOK_URL`
 * as the base for sage's internal API. Codex review on PR #453 caught
 * this: the docker e2e mock config defaults `SAGE_WEBHOOK_URL` to a full
 * `/api/webhooks/slack` URL, and without normalization we'd build
 * `${url}/api/webhooks/slack/api/internal/proactive/notify-channel` —
 * which sage doesn't route. Mirrors the existing webhook-consumer
 * normalization: tolerate either a base URL or a full webhook URL.
 */
function stripSlackWebhookPath(url: string): string {
  const trimmed = url.replace(/\/$/, "");
  return trimmed.replace(/\/api\/webhooks\/slack$/i, "");
}

function resolveSageBaseUrl(): string {
  const explicit =
    readEnvString("SAGE_INTERNAL_BASE_URL") ?? readEnvString("SAGE_WEBHOOK_URL");
  if (explicit) {
    return stripSlackWebhookPath(explicit);
  }
  return process.env.NODE_ENV === "development"
    ? DEFAULT_SAGE_BASE_URL_DEV
    : DEFAULT_SAGE_BASE_URL;
}

/**
 * Read the shared cloud↔sage auth token. Reads `Resource.SageCloudApiToken`
 * first (the production / SST runtime path), then falls back to
 * `process.env.SAGE_CLOUD_API_TOKEN` for local dev / scripts / non-`sst dev`
 * runs where the SST proxy isn't available. Same pattern the repo's
 * `AGENTS.md` SST-Secrets rule documents (Codex review on PR #453).
 */
function resolveSageToken(): string | null {
  try {
    const value = Resource.SageCloudApiToken.value?.trim();
    if (value) return value;
  } catch {
    // Resource proxy unavailable (local dev, tests outside `sst dev`);
    // fall through to the env-var path.
  }
  return readEnvString("SAGE_CLOUD_API_TOKEN") ?? null;
}

export class SageInternalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly upstreamBody?: unknown,
  ) {
    super(message);
    this.name = "SageInternalApiError";
  }
}

interface CallSageOptions {
  method: "GET" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** Per-call timeout in ms; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

async function callSage<T>(opts: CallSageOptions): Promise<T> {
  const token = resolveSageToken();
  if (!token) {
    throw new SageInternalApiError(
      "SageCloudApiToken is not configured on this deployment",
      500,
    );
  }
  const baseUrl = resolveSageBaseUrl();
  const url = `${baseUrl}${opts.path.startsWith("/") ? opts.path : `/${opts.path}`}`;

  // Single try/finally so the AbortController timeout is cleared exactly
  // once — covering the connect-error path AND the response-read path.
  // CodeRabbit review on PR #453: the prior shape cleared the timeout
  // *before* reading the response body, leaving a window where a slow
  // body read couldn't be aborted.
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        method: opts.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SageInternalApiError(`Sage internal request failed: ${message}`, 502);
    }

    let parsed: unknown = null;
    if (response.headers.get("content-type")?.includes("application/json")) {
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
    } else {
      response.body?.cancel().catch(() => {});
    }

    if (!response.ok) {
      const message =
        typeof (parsed as { error?: { message?: string } })?.error?.message === "string"
          ? (parsed as { error: { message: string } }).error.message
          : `Sage returned HTTP ${response.status}`;
      throw new SageInternalApiError(message, response.status, parsed);
    }

    return parsed as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getNotifyChannelPref(
  workspaceId: string,
): Promise<NotifyChannelPrefResponse> {
  return callSage<NotifyChannelPrefResponse>({
    method: "GET",
    path: `/api/internal/proactive/notify-channel?workspaceId=${encodeURIComponent(workspaceId)}`,
  });
}

export async function putNotifyChannelPref(
  workspaceId: string,
  channelId: string,
): Promise<NotifyChannelPrefResponse> {
  return callSage<NotifyChannelPrefResponse>({
    method: "PUT",
    path: "/api/internal/proactive/notify-channel",
    body: { workspaceId, channelId },
  });
}

export async function deleteNotifyChannelPref(
  workspaceId: string,
): Promise<NotifyChannelPrefResponse> {
  return callSage<NotifyChannelPrefResponse>({
    method: "DELETE",
    path: "/api/internal/proactive/notify-channel",
    body: { workspaceId },
  });
}

export async function listSageBotChannels(
  workspaceId: string,
): Promise<BotChannelsResponse> {
  return callSage<BotChannelsResponse>({
    method: "GET",
    path: `/api/internal/proactive/bot-channels?workspaceId=${encodeURIComponent(workspaceId)}`,
  });
}
