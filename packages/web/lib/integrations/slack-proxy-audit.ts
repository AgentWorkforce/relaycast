import { logger } from "../logger";

export interface SlackProxyAuditEntry {
  workspaceId: string;
  endpoint: string;
  method: "GET" | "POST";
  channel?: string;
  httpStatus: number;
  slackOk?: boolean;
  errorCode?: string;
  latencyMs: number;
  reason:
    | "ok"
    | "unauthorized"
    | "forbidden"
    | "rate_limited"
    | "not_found"
    | "slack_error"
    | "upstream_error"
    | "bad_request";
}

export function recordSlackProxyCall(entry: SlackProxyAuditEntry): void {
  const {
    workspaceId,
    endpoint,
    method,
    channel,
    httpStatus,
    slackOk,
    errorCode,
    latencyMs,
    reason,
  } = entry;

  const context = {
    area: "slack-proxy",
    route: "/api/v1/proxy/slack",
    workspaceId,
    endpoint,
    method,
    ...(channel ? { channel } : {}),
    httpStatus,
    ...(typeof slackOk === "boolean" ? { slackOk } : {}),
    ...(errorCode ? { errorCode } : {}),
    latencyMs,
    reason,
  };

  if (reason === "ok") {
    void logger.info("Slack proxy request completed", context);
    return;
  }

  void logger.warn("Slack proxy request failed", context);
}
