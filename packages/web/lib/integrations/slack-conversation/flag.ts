import { tryResourceValue } from "@/lib/env";

export const SLACK_CONVERSATION_ROUTING_ENABLED_ENV =
  "CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED";
export const SLACK_CONVERSATION_ROUTING_ENABLED_RESOURCE =
  "SlackConversationRoutingEnabled";
export const SLACK_CONVERSATION_ROUTING_TEST_ENV =
  "SLACK_CONVERSATION_ROUTING_TEST_MODE";

export function isSlackConversationRoutingEnabled(): boolean {
  return truthyFlag(
    tryResourceValue(SLACK_CONVERSATION_ROUTING_ENABLED_RESOURCE) ??
      readProcessEnvString(SLACK_CONVERSATION_ROUTING_ENABLED_ENV) ??
      readProcessEnvString(SLACK_CONVERSATION_ROUTING_TEST_ENV),
  );
}

function truthyFlag(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "enabled"
  );
}

function readProcessEnvString(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env[name];
}
