import type {
  SlackProgressResult,
  SlackProgressStreamEgress,
} from "@agent-assistant/surfaces";
import { getNangoClient, getSlackProviderConfigKey } from "@/lib/integrations/nango-service";
import { getWorkspaceIntegrationByProviderAlias } from "@/lib/integrations/workspace-integrations";

const SLACK_API_BASE_URL = "https://slack.com/api";
const APPEND_THROTTLE_MS = 1_000;

// Input shapes are derived from the @agent-assistant/surfaces contract so this
// module cannot drift from the package-owned egress interface. The follow-up
// streamed-turn work (SPEC section 3) hands this egress straight to
// startSlackProgressStream/appendSlackProgressStream/finishSlackProgressStream.
type SlackProgressStartInput = Parameters<SlackProgressStreamEgress["startStream"]>[0];
type SlackProgressAppendInput = Parameters<
  NonNullable<SlackProgressStreamEgress["appendStream"]>
>[0];
type SlackProgressStopInput = Parameters<SlackProgressStreamEgress["stopStream"]>[0];

export type SlackConversationIdentity = {
  username?: string;
  iconUrl?: string;
};

export type SlackConversationEgressError = {
  code:
    | "missing_workspace_id"
    | "missing_bot_token"
    | "request_failed"
    | "slack_http_error"
    | "invalid_response"
    | "slack_api_error";
  message: string;
  status?: number;
  slackError?: string;
};

// SlackProgressResult carries `error?: string`; the cloud egress additionally
// preserves the structured failure in `errorDetail` for logging/diagnostics.
export type SlackConversationEgressResult = SlackProgressResult & {
  errorDetail?: SlackConversationEgressError;
};

// Extends the agent-assistant contract: any SlackConversationProgressStreamEgress
// is a valid SlackProgressStreamEgress. Cloud-specific widenings only:
// - threadTs is optional on startStream (top-of-channel acks for non-thread mentions)
// - identity (chat:write.customize) on startStream
export interface SlackConversationProgressStreamEgress extends SlackProgressStreamEgress {
  startStream(
    input: Omit<SlackProgressStartInput, "threadTs"> & {
      threadTs?: string;
      identity?: SlackConversationIdentity;
    },
  ): Promise<SlackConversationEgressResult>;
  appendStream(input: SlackProgressAppendInput): Promise<SlackConversationEgressResult>;
  stopStream(input: SlackProgressStopInput): Promise<SlackConversationEgressResult>;
}

export type SlackConversationEgressDeps = {
  fetchImpl?: typeof fetch;
  resolveBotToken: (workspaceId: string) => Promise<string | null>;
};

type SlackApiResponse = {
  ok?: boolean;
  ts?: unknown;
  error?: unknown;
};

type StreamState = {
  chain: Promise<void>;
  busy: boolean;
  lastUpdateAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  queuedBatch?: QueuedAppendBatch;
};

type QueuedAppendBatch = {
  text: string;
  waiters: Array<(result: SlackConversationEgressResult) => void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNestedRecord(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return isRecord(nested) ? nested : null;
}

function readTokenFromConnectionPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const connectionConfig =
    readNestedRecord(payload, "connection_config") ??
    readNestedRecord(payload, "connectionConfig");
  const credentials =
    readNestedRecord(payload, "credentials") ??
    (connectionConfig ? readNestedRecord(connectionConfig, "credentials") : null);
  const rawCredentials = credentials ? readNestedRecord(credentials, "raw") : null;

  for (const candidate of [
    payload.access_token,
    payload.accessToken,
    payload.token,
    connectionConfig?.access_token,
    connectionConfig?.accessToken,
    connectionConfig?.token,
    credentials?.access_token,
    credentials?.accessToken,
    credentials?.token,
    rawCredentials?.access_token,
    rawCredentials?.accessToken,
    rawCredentials?.token,
  ]) {
    const token = readNonEmptyString(candidate);
    if (token) {
      return token;
    }
  }

  return null;
}

function readTokenFromNangoTokenResponse(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return null;
  }

  for (const key of ["access_token", "accessToken", "token"] as const) {
    const token = readNonEmptyString(value[key]);
    if (token) {
      return token;
    }
  }

  return null;
}

function normalizeSlackTs(value: unknown): string | undefined {
  return readNonEmptyString(value) ?? undefined;
}

function egressFailure(detail: SlackConversationEgressError): SlackConversationEgressResult {
  return { ok: false, error: detail.message, errorDetail: detail };
}

function queueWaiter(batch: QueuedAppendBatch): Promise<SlackConversationEgressResult> {
  return new Promise<SlackConversationEgressResult>((resolve) => {
    batch.waiters.push(resolve);
  });
}

function resolveQueuedWaiters(batch: QueuedAppendBatch | undefined, result: SlackConversationEgressResult): void {
  for (const waiter of batch?.waiters ?? []) {
    waiter(result);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveSlackConversationBotToken(
  workspaceId: string,
): Promise<string | null> {
  const integration = await getWorkspaceIntegrationByProviderAlias(workspaceId, "slack");
  if (!integration) {
    return null;
  }

  const providerConfigKey = integration.providerConfigKey ?? getSlackProviderConfigKey();
  const details = await getNangoClient()
    .proxy({
      method: "GET",
      endpoint: `/connections/${encodeURIComponent(integration.connectionId)}`,
      providerConfigKey,
      connectionId: integration.connectionId,
    })
    .catch(() => null);
  const tokenFromProxy = readTokenFromConnectionPayload(details);
  if (tokenFromProxy) {
    return tokenFromProxy;
  }

  try {
    return readTokenFromNangoTokenResponse(
      await getNangoClient().getToken(providerConfigKey, integration.connectionId),
    );
  } catch {
    return null;
  }
}

export function createSlackConversationEgress(
  deps: SlackConversationEgressDeps,
): SlackConversationProgressStreamEgress {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const streamStates = new Map<string, StreamState>();

  // Slack `ts` values are only unique per channel — key throttle/serialization
  // state by workspace + channel + ts so streams never share state across
  // channels or workspaces.
  function streamStateKey(input: { workspaceId?: string; channel: string; ts: string }): string {
    return `${input.workspaceId ?? ""}:${input.channel}:${input.ts}`;
  }

  function getStreamState(key: string): StreamState {
    const existing = streamStates.get(key);
    if (existing) {
      return existing;
    }

    const created: StreamState = {
      chain: Promise.resolve(),
      busy: false,
      lastUpdateAt: 0,
      timer: null,
    };
    streamStates.set(key, created);
    return created;
  }

  async function callSlackApi(input: {
    workspaceId: string | undefined;
    endpoint: string;
    body: Record<string, unknown>;
  }): Promise<SlackConversationEgressResult> {
    if (!input.workspaceId) {
      return egressFailure({
        code: "missing_workspace_id",
        message: `Slack ${input.endpoint} call did not include a workspaceId; cannot resolve a bot token.`,
      });
    }

    let token: string | null;
    try {
      token = await deps.resolveBotToken(input.workspaceId);
    } catch (error) {
      return egressFailure({
        code: "missing_bot_token",
        message:
          `Slack bot token resolution failed for workspace '${input.workspaceId}': ` +
          `${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (!token) {
      return egressFailure({
        code: "missing_bot_token",
        message: `Slack bot token was not available for workspace '${input.workspaceId}'.`,
      });
    }

    let response: Response;
    try {
      response = await fetchImpl(`${SLACK_API_BASE_URL}${input.endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(input.body),
      });
    } catch (error) {
      return egressFailure({
        code: "request_failed",
        message:
          `Slack ${input.endpoint} request failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      });
    }

    let payload: SlackApiResponse | null = null;
    try {
      payload = (await response.json()) as SlackApiResponse;
    } catch {
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        return egressFailure({
          code: "slack_http_error",
          status: response.status,
          message: bodyText
            ? `Slack ${input.endpoint} failed with status ${response.status}: ${bodyText}`
            : `Slack ${input.endpoint} failed with status ${response.status}.`,
        });
      }
      return egressFailure({
        code: "invalid_response",
        status: response.status,
        message: `Slack ${input.endpoint} returned a non-JSON response.`,
      });
    }

    if (!response.ok) {
      const slackError = readNonEmptyString(payload?.error);
      return egressFailure({
        code: "slack_http_error",
        status: response.status,
        ...(slackError ? { slackError } : {}),
        message: slackError
          ? `Slack ${input.endpoint} failed with status ${response.status}: ${slackError}`
          : `Slack ${input.endpoint} failed with status ${response.status}.`,
      });
    }

    if (!payload || payload.ok !== true) {
      const slackError = readNonEmptyString(payload?.error);
      return egressFailure({
        code: "slack_api_error",
        ...(slackError ? { slackError } : {}),
        message: slackError
          ? `Slack ${input.endpoint} rejected the request: ${slackError}`
          : `Slack ${input.endpoint} rejected the request.`,
      });
    }

    return {
      ok: true,
      ...(normalizeSlackTs(payload.ts) ? { ts: normalizeSlackTs(payload.ts) } : {}),
    };
  }

  function runSerialized<T>(
    ts: string,
    state: StreamState,
    action: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      state.chain = state.chain
        .catch(() => undefined)
        .then(async () => {
          state.busy = true;
          try {
            resolve(await action());
          } catch (error) {
            reject(error);
          } finally {
            state.busy = false;
          }
        });
    });
  }

  function throttleDelayMs(state: StreamState): number {
    return Math.max(0, state.lastUpdateAt + APPEND_THROTTLE_MS - Date.now());
  }

  function scheduleQueuedAppend(input: {
    workspaceId?: string;
    channel: string;
    ts: string;
  }, state: StreamState): void {
    if (state.timer) {
      return;
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      void runSerialized(input.ts, state, async () => {
        const batch = state.queuedBatch;
        state.queuedBatch = undefined;
        if (!batch) {
          return {
            batch: undefined,
            result: { ok: true } satisfies SlackConversationEgressResult,
          };
        }

        const remaining = throttleDelayMs(state);
        if (remaining > 0) {
          await sleep(remaining);
        }

        const result = await callSlackApi({
          workspaceId: input.workspaceId,
          endpoint: "/chat.update",
          body: {
            channel: input.channel,
            ts: input.ts,
            text: batch.text,
          },
        });
        if (result.ok) {
          state.lastUpdateAt = Date.now();
        }
        return { batch, result };
      }).then(({ batch, result }) => {
        resolveQueuedWaiters(batch, result);
        if (state.queuedBatch !== undefined) {
          scheduleQueuedAppend(input, state);
        }
      });
    }, throttleDelayMs(state));
  }

  return {
    startStream(input) {
      return callSlackApi({
        workspaceId: input.workspaceId,
        endpoint: "/chat.postMessage",
        body: {
          channel: input.channel,
          ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
          ...(input.markdownText ? { text: input.markdownText } : {}),
          ...(input.identity?.username ? { username: input.identity.username } : {}),
          ...(input.identity?.iconUrl ? { icon_url: input.identity.iconUrl } : {}),
        },
      });
    },

    appendStream(input) {
      const state = getStreamState(streamStateKey(input));
      const shouldQueue =
        state.busy ||
        state.timer !== null ||
        state.queuedBatch !== undefined ||
        throttleDelayMs(state) > 0;

      if (!shouldQueue) {
        return runSerialized(input.ts, state, async () => {
          const result = await callSlackApi({
            workspaceId: input.workspaceId,
            endpoint: "/chat.update",
            body: {
              channel: input.channel,
              ts: input.ts,
              text: input.markdownText,
            },
          });
          if (result.ok) {
            state.lastUpdateAt = Date.now();
          }
          return result;
        });
      }

      const batch = state.queuedBatch ?? {
        text: input.markdownText,
        waiters: [],
      };
      batch.text = input.markdownText;
      state.queuedBatch = batch;
      const promise = queueWaiter(batch);
      scheduleQueuedAppend(input, state);
      return promise;
    },

    stopStream(input) {
      const state = getStreamState(streamStateKey(input));
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      const queuedBatch = state.queuedBatch;
      const finalText = input.markdownText ?? queuedBatch?.text;
      state.queuedBatch = undefined;

      return runSerialized(input.ts, state, async () => {
        const result = await callSlackApi({
          workspaceId: input.workspaceId,
          endpoint: "/chat.update",
          body: {
            channel: input.channel,
            ts: input.ts,
            ...(finalText ? { text: finalText } : {}),
          },
        });
        resolveQueuedWaiters(queuedBatch, result);
        return result;
      }).finally(() => {
        streamStates.delete(streamStateKey(input));
      });
    },
  };
}

export const slackConversationEgress = createSlackConversationEgress({
  resolveBotToken: resolveSlackConversationBotToken,
});
