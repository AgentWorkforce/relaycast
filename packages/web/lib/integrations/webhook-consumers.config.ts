import { computeLinearPath } from "@relayfile/adapter-linear/path-mapper";
import {
  computePath as computeGitHubPath,
  createGitHubRelayfileClient,
  type GitHubNormalizedWebhook,
} from "./github-relayfile";
import type {
  NormalizedWebhook,
  WebhookConsumer,
  WebhookConsumerPredicate,
  WebhookProvider,
} from "./webhook-consumer-types.js";

const PROACTIVE_ISSUE_RESOLVER_TARGET_REPO = "My-Senior-Dev/app";
const PROACTIVE_ISSUE_RESOLVER_EVENT_TYPE = "issues.opened";

const DEFAULT_SAGE_WEBHOOK_URL = "https://sage.agentrelay.com";
const DEFAULT_SAGE_WEBHOOK_URL_DEV = "http://localhost:3777";
const DEFAULT_TIMEOUT_MS = 10_000;

function readEnvString(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getSageWebhookUrl(env: Record<string, string | undefined>): string {
  const base =
    readEnvString(env, "SAGE_WEBHOOK_URL") ??
    (env.NODE_ENV === "development"
      ? DEFAULT_SAGE_WEBHOOK_URL_DEV
      : DEFAULT_SAGE_WEBHOOK_URL);
  const trimmed = trimTrailingSlash(base);

  return trimmed.endsWith("/api/webhooks/slack")
    ? trimmed
    : `${trimmed}/api/webhooks/slack`;
}

function envGatedHttpConsumer({
  id,
  provider,
  urlEnv,
  tokenEnv,
  env,
  predicate,
}: {
  id: string;
  provider: WebhookProvider;
  urlEnv: string;
  tokenEnv: string;
  env: Record<string, string | undefined>;
  predicate?: WebhookConsumerPredicate;
}): WebhookConsumer | null {
  const url = readEnvString(env, urlEnv);
  const token = readEnvString(env, tokenEnv);

  if (!url || !token) {
    return null;
  }

  const consumer: WebhookConsumer = {
    id,
    provider,
    kind: "http",
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };

  if (predicate) {
    consumer.predicate = predicate;
  }

  return consumer;
}

/**
 * Predicate for the `proactive-issue-resolver` HTTP consumer.
 *
 * Scopes webhook fanout to `issues.opened` events on the
 * `My-Senior-Dev/app` repository. The persona is the cloud half of the
 * two-PR pair tracked in `specs/proactive-issue-resolver-consumer.md` and
 * `https://github.com/My-Senior-Dev/app/pull/310`.
 *
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues
 */
export function isProactiveIssueResolverEvent(
  event: NormalizedWebhook,
): boolean {
  if (event.eventType !== PROACTIVE_ISSUE_RESOLVER_EVENT_TYPE) {
    return false;
  }

  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const repository = (payload as { repository?: unknown }).repository;
  if (typeof repository !== "object" || repository === null) {
    return false;
  }

  const fullName = (repository as { full_name?: unknown }).full_name;
  return fullName === PROACTIVE_ISSUE_RESOLVER_TARGET_REPO;
}

function resolveEventWorkspaceId(event: NormalizedWebhook): string {
  const workspaceId = event.workspaceId?.trim();
  if (!workspaceId) {
    throw new Error("Missing workspaceId for relayfile-primary webhook consumer");
  }

  return workspaceId;
}

function resolveEventPath(event: NormalizedWebhook): string {
  if (event.path?.trim()) {
    return event.path.trim();
  }

  if (event.provider === "github") {
    return computeGitHubPath(event as GitHubNormalizedWebhook);
  }

  if (event.provider === "linear") {
    if (!event.objectType || !event.objectId) {
      throw new Error("Missing objectType or objectId for linear relayfile path");
    }

    return computeLinearPath(event.objectType, event.objectId);
  }

  throw new Error(`relayfile-primary does not support provider ${event.provider}`);
}

export function createRelayfilePrimaryConsumer(): WebhookConsumer {
  return {
    id: "relayfile-primary",
    providers: ["github", "linear"],
    kind: "local",
    async handler(event) {
      const workspaceId = resolveEventWorkspaceId(event);
      const path = resolveEventPath(event);
      const client = createGitHubRelayfileClient(workspaceId);

      await client.ingestWebhook({
        workspaceId,
        provider: event.provider,
        event_type: event.eventType,
        path,
        data: Array.isArray(event.data) ? { records: event.data } : event.data ?? event.payload,
        delivery_id: event.deliveryId ?? undefined,
        headers: event.headers ?? {},
        timestamp: event.timestamp ?? new Date().toISOString(),
      });
    },
  };
}

export function getConfiguredConsumers(
  env: Record<string, string | undefined>,
): WebhookConsumer[] {
  const consumers: WebhookConsumer[] = [
    {
      id: "sage",
      provider: "slack",
      kind: "http",
      url: getSageWebhookUrl(env),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    createRelayfilePrimaryConsumer(),
  ];

  const msdBackendConsumer = envGatedHttpConsumer({
    id: "msd-backend",
    provider: "slack",
    urlEnv: "WEBHOOK_MSD_BACKEND_URL",
    tokenEnv: "WEBHOOK_MSD_BACKEND_TOKEN",
    env,
  });

  if (msdBackendConsumer) {
    consumers.push(msdBackendConsumer);
  }

  const proactiveIssueResolverConsumer = envGatedHttpConsumer({
    id: "proactive-issue-resolver",
    provider: "github",
    urlEnv: "PROACTIVE_ISSUE_RESOLVER_URL",
    tokenEnv: "PROACTIVE_ISSUE_RESOLVER_TOKEN",
    env,
    predicate: isProactiveIssueResolverEvent,
  });

  if (proactiveIssueResolverConsumer) {
    consumers.push(proactiveIssueResolverConsumer);
  }

  return consumers;
}
