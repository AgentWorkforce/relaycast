import { resolveRelayApiKeyForWorkspace } from "@/lib/workflows/relay-api-key";
import { resolveRelaycastUrl } from "@/lib/workspace-registry";

/**
 * Server-side relaycast channel helper.
 *
 * Mirrors the message bridge in `integrations/slack-relay-bridge/relaycast.ts`:
 * resolve the workspace's `rk_live_*` key, hit the relaycast HTTP API with a
 * Bearer token. Channel CRUD lives at `/v1/channels` (GET lists, POST creates);
 * the SDK's `agent.channels.create({ name })` is the agent-side equivalent.
 *
 * Used by the ctx.team spawn endpoint to provision the `team-{teamId}`
 * coordination channel before launching members (spec §10).
 */

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeChannelName(name: string): string {
  return name.replace(/^#/, "").trim();
}

export interface CreateRelaycastChannelInput {
  workspaceId: string;
  name: string;
  topic?: string;
}

export interface CreateRelaycastChannelResult {
  channel: string;
  created: boolean;
}

/**
 * Create a relaycast channel for the workspace. Idempotent: a 409 (already
 * exists) resolves to `{ created: false }` rather than throwing, so re-running
 * a spawn against an existing team channel is safe.
 */
export async function createRelaycastChannel(
  input: CreateRelaycastChannelInput,
): Promise<CreateRelaycastChannelResult> {
  const channel = normalizeChannelName(input.name);
  if (!channel) {
    throw new Error("relaycast channel name must be non-empty");
  }

  const apiKey = await resolveRelayApiKeyForWorkspace(input.workspaceId);
  if (!apiKey) {
    throw new Error(
      `Relaycast API key is not configured for workspace ${input.workspaceId}`,
    );
  }

  const response = await fetch(
    `${trimTrailingSlash(resolveRelaycastUrl())}/v1/channels`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: channel,
        ...(input.topic ? { topic: input.topic } : {}),
      }),
    },
  );

  // Already-exists is success for our purposes — the channel is usable.
  if (response.status === 409) {
    return { channel, created: false };
  }
  if (!response.ok) {
    throw new Error(
      `Relaycast channel create failed: ${response.status} ${response.statusText}`,
    );
  }

  return { channel, created: true };
}
