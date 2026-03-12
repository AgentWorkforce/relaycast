#!/usr/bin/env node
import { startStdio } from "./transports.js";
import { parseWorkspaceEnv } from "./workspaces.js";

/**
 * Resolve the Relaycast API key from RELAY_API_KEY env var.
 * When spawned by the broker, RELAY_API_KEY is always injected into the environment.
 */
function resolveApiKey(): string | undefined {
  return process.env.RELAY_API_KEY;
}

function resolveWorkspaces() {
  return parseWorkspaceEnv(process.env.RELAY_WORKSPACES_JSON);
}

function parseStrictAgentName(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function parseAgentType(
  value: string | undefined,
): "agent" | "human" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "agent" || normalized === "human") {
    return normalized;
  }
  return undefined;
}

const workspaces = resolveWorkspaces();

startStdio({
  apiKey: workspaces ? undefined : resolveApiKey(),
  baseUrl: process.env.RELAY_BASE_URL,
  agentToken: workspaces ? undefined : process.env.RELAY_AGENT_TOKEN,
  agentName: workspaces ? undefined : (process.env.RELAY_AGENT_NAME ?? process.env.RELAY_CLAW_NAME),
  agentType: workspaces ? undefined : parseAgentType(process.env.RELAY_AGENT_TYPE),
  strictAgentName: parseStrictAgentName(process.env.RELAY_STRICT_AGENT_NAME),
  workspaces,
  defaultWorkspace: process.env.RELAY_DEFAULT_WORKSPACE,
});
