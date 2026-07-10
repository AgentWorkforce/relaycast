import { RelayFileApiError, RelayFileClient } from "@relayfile/sdk";
import { mintRelayfileToken } from "@cloud/core/relayfile/client.js";

import { resolveRelayfileConfig } from "@/lib/relayfile";

const CONTINUATION_CONTEXT_AGENT = "cloud-continuation-create";

export type VerifiedSlackReplyContext = {
  path: string;
  channel: string;
  thread: string;
};

export type VerifySlackReplyContextInput = {
  relayWorkspaceId: string;
  path: string;
  channel: string;
  thread: string;
};

export async function verifySlackReplyContextInRelayWorkspace(
  input: VerifySlackReplyContextInput,
): Promise<VerifiedSlackReplyContext | null> {
  const client = createRelayfileClient(input.relayWorkspaceId);
  try {
    await client.readFile(input.relayWorkspaceId, input.path);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
  return {
    path: input.path,
    channel: input.channel,
    thread: input.thread,
  };
}

function createRelayfileClient(relayWorkspaceId: string): RelayFileClient {
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } =
    resolveRelayfileConfig();
  return new RelayFileClient({
    baseUrl: relayfileUrl,
    token: () =>
      mintRelayfileToken({
        workspaceId: relayWorkspaceId,
        relayAuthUrl,
        relayAuthApiKey,
        agentName: CONTINUATION_CONTEXT_AGENT,
        scopes: ["fs:read"],
      }),
  });
}

function isNotFound(error: unknown): boolean {
  if (error instanceof RelayFileApiError && error.status === 404) {
    return true;
  }
  return Boolean(
    error &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status?: unknown }).status === 404,
  );
}
