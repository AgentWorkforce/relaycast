import { resolveRelayApiKeyForWorkspace } from "@/lib/workflows/relay-api-key";
import { resolveRelaycastUrl } from "@/lib/workspace-registry";
import type { RelayPostInput, RelayPostResult, RelayPoster } from "./types";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  for (const key of ["id", "messageId", "message_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

export function createRelaycastPoster(): RelayPoster {
  return {
    async post(input: RelayPostInput): Promise<RelayPostResult> {
      const apiKey = await resolveRelayApiKeyForWorkspace(input.workspaceId);
      if (!apiKey) {
        throw new Error(`Relaycast API key is not configured for workspace ${input.workspaceId}`);
      }

      const response = await fetch(`${trimTrailingSlash(resolveRelaycastUrl())}/v1/message`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(input.idempotencyKey
            ? {
                "Idempotency-Key": input.idempotencyKey,
                "X-Idempotency-Key": input.idempotencyKey,
              }
            : {}),
        },
        body: JSON.stringify({
          channel: input.relayChannelId.replace(/^#/, ""),
          text: input.fromName ? `**${input.fromName}:** ${input.text}` : input.text,
          mode: "wait",
        }),
      });

      if (!response.ok) {
        throw new Error(`Relaycast message post failed: ${response.status} ${response.statusText}`);
      }

      const payload = await response.json().catch(() => null);
      const messageId = readMessageId(payload);
      if (!messageId) {
        throw new Error("Relaycast message post did not return a message id");
      }

      return { messageId };
    },
  };
}
