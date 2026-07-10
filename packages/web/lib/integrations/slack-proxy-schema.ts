import { z } from "zod";

import { WORKSPACE_ID_PATTERN } from "./workspace-identifiers";

export const SLACK_PROXY_ALLOW_LIST = [
  { endpoint: "/chat.postMessage", method: "POST" },
  { endpoint: "/chat.update", method: "POST" },
  { endpoint: "/chat.delete", method: "POST" },
  { endpoint: "/chat.postEphemeral", method: "POST" },
  { endpoint: "/chat.startStream", method: "POST" },
  { endpoint: "/chat.appendStream", method: "POST" },
  { endpoint: "/chat.stopStream", method: "POST" },
  { endpoint: "/views.open", method: "POST" },
  { endpoint: "/reactions.add", method: "POST" },
  { endpoint: "/reactions.remove", method: "POST" },
  { endpoint: "/conversations.replies", method: "GET" },
  { endpoint: "/conversations.replies", method: "POST" },
  { endpoint: "/conversations.history", method: "GET" },
  { endpoint: "/conversations.history", method: "POST" },
  { endpoint: "/reactions.get", method: "GET" },
  { endpoint: "/auth.test", method: "GET" },
  { endpoint: "/auth.test", method: "POST" },
  { endpoint: "/users.conversations", method: "GET" },
] as const;

export type SlackProxyAllowedRoute = (typeof SLACK_PROXY_ALLOW_LIST)[number];
export type SlackProxyMethod = SlackProxyAllowedRoute["method"];
export type SlackProxyEndpoint = SlackProxyAllowedRoute["endpoint"];

const allowedRouteKeys = new Set(
  SLACK_PROXY_ALLOW_LIST.map((entry) => `${entry.method}:${entry.endpoint}`),
);

const allowedMethodsByEndpoint = new Map<string, SlackProxyMethod[]>();
for (const entry of SLACK_PROXY_ALLOW_LIST) {
  const existing = allowedMethodsByEndpoint.get(entry.endpoint);
  if (existing) {
    existing.push(entry.method);
  } else {
    allowedMethodsByEndpoint.set(entry.endpoint, [entry.method]);
  }
}

function normalizeRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key.trim().length > 0),
  );
}

export function normalizeSlackProxyEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Slack proxy request body. Service callers must include at least one
 * workspace identifier — either a cloud workspace UUID (`workspaceId`, used by
 * direct cloud-to-cloud calls and dashboard flows) or a Slack team id
 * (`slackTeamId`, used by sage when it's processing a webhook event and only
 * has the team id from the event payload). Workspace-scoped bearer callers may
 * omit both; the route defaults to the authenticated workspace id after auth.
 *
 * Cloud's workspace-identity-resolver handles the actual translation: UUIDs
 * fast-path into a direct integration lookup; Slack team ids go through
 * `findSlackIntegrationByTeamId` which matches the team id against
 * `metadata_json` on `slack-*` rows.
 */
export const slackProxyRequestSchema = z
  .object({
    workspaceId: z
      .string()
      .trim()
      .regex(
        WORKSPACE_ID_PATTERN,
        "workspaceId must be a UUID or rw_<8hex>",
      )
      .optional(),
    slackTeamId: z.string().trim().min(1).optional(),
    endpoint: z.string().trim().min(1).transform(normalizeSlackProxyEndpoint),
    method: z.enum(["GET", "POST"]),
    data: z.record(z.string(), z.unknown()).optional().transform(normalizeRecord),
    params: z.record(z.string(), z.string()).optional().transform((value) => {
      if (!value) {
        return undefined;
      }

      return Object.fromEntries(
        Object.entries(value)
          .map(([key, entry]) => [key.trim(), entry.trim()])
          .filter(([key, entry]) => key.length > 0 && entry.length > 0),
      );
    }),
  })
  .strict();

export type SlackProxyRequestBody = z.infer<typeof slackProxyRequestSchema>;

export function isAllowedSlackProxyRoute(
  endpoint: string,
  method: SlackProxyMethod,
): endpoint is SlackProxyEndpoint {
  return allowedRouteKeys.has(`${method}:${normalizeSlackProxyEndpoint(endpoint)}`);
}

export function getAllowedSlackProxyMethods(
  endpoint: string,
): SlackProxyMethod[] {
  return allowedMethodsByEndpoint.get(normalizeSlackProxyEndpoint(endpoint)) ?? [];
}

export function getSlackProxyChannel(input: {
  method: SlackProxyMethod;
  data?: Record<string, unknown>;
  params?: Record<string, string>;
}): string | undefined {
  if (input.method === "POST") {
    const channel = input.data?.channel;
    return typeof channel === "string" && channel.trim().length > 0
      ? channel.trim()
      : undefined;
  }

  const channel = input.params?.channel;
  return typeof channel === "string" && channel.trim().length > 0
    ? channel.trim()
    : undefined;
}
