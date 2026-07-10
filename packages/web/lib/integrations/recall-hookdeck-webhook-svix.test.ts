import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimWebhookDelivery: vi.fn(),
  releaseWebhookDelivery: vi.fn(),
  dispatchIntegrationWatchEvent: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  listWorkspaceIntegrationsForProvider: vi.fn(),
  createGitHubRelayfileClient: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn },
}));

vi.mock("@/lib/ricky/webhook-dedup", () => ({
  claimWebhookDelivery: mocks.claimWebhookDelivery,
  releaseWebhookDelivery: mocks.releaseWebhookDelivery,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findWorkspaceIntegrationByConnection: mocks.findWorkspaceIntegrationByConnection,
  listWorkspaceIntegrationsForProvider: mocks.listWorkspaceIntegrationsForProvider,
}));

vi.mock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
  dispatchIntegrationWatchEvent: mocks.dispatchIntegrationWatchEvent,
}));

vi.mock("@/lib/integrations/github-relayfile", () => ({
  createGitHubRelayfileClient: mocks.createGitHubRelayfileClient,
}));

import {
  handleRecallHookdeckWebhook,
  resolveRecallWorkspaceId,
  verifyRecallSvixSignature,
} from "./recall-hookdeck-webhook";

// Raw key bytes base64-encoded, prefixed per Svix convention.
const RAW_KEY = Buffer.from("test-secret-key-material-32bytes");
const SECRET = `whsec_${RAW_KEY.toString("base64")}`;

function sign(rawBody: string, id: string, timestamp: string, key: Buffer = RAW_KEY): string {
  return createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`, "utf8")
    .digest("base64");
}

function svixHeaders(
  rawBody: string,
  overrides: Partial<Record<"id" | "timestamp" | "signature", string | null>> = {},
): Headers {
  const id = overrides.id === undefined ? "msg_test_1" : overrides.id;
  const timestamp =
    overrides.timestamp === undefined
      ? String(Math.floor(Date.now() / 1000))
      : overrides.timestamp;
  const headers = new Headers();
  if (id !== null) headers.set("webhook-id", id);
  if (timestamp !== null) headers.set("webhook-timestamp", timestamp);
  if (overrides.signature !== undefined) {
    if (overrides.signature !== null) headers.set("webhook-signature", overrides.signature);
  } else if (id !== null && timestamp !== null) {
    headers.set("webhook-signature", `v1,${sign(rawBody, id, timestamp)}`);
  }
  return headers;
}

const BODY = JSON.stringify({
  event: "sdk_upload.complete",
  data: {
    data: {
      code: "complete",
      sub_code: null,
      updated_at: "2026-06-12T13:49:08.550355Z",
    },
    object: {
      created_at: "2026-06-12T13:48:41.345984Z",
      id: "sdk-upload-1",
      recording_id: "rec-1",
      status: { code: "complete" },
    },
    recording: {
      id: "rec-1",
      metadata: {},
    },
    sdk_upload: {
      id: "sdk-upload-1",
      metadata: {},
    },
  },
});

describe("verifyRecallSvixSignature", () => {
  it("accepts a valid v1 signature", () => {
    expect(verifyRecallSvixSignature(BODY, svixHeaders(BODY), SECRET)).toBe(true);
  });

  it("accepts when a valid entry appears among multiple signatures", () => {
    const id = "msg_test_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const good = sign(BODY, id, timestamp);
    const headers = svixHeaders(BODY, {
      id,
      timestamp,
      signature: `v1,${Buffer.from("wrong").toString("base64")} v1,${good}`,
    });
    expect(verifyRecallSvixSignature(BODY, headers, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const headers = svixHeaders(BODY);
    expect(verifyRecallSvixSignature(`${BODY} `, headers, SECRET)).toBe(false);
  });

  it("rejects a signature made with a different key", () => {
    const id = "msg_test_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = svixHeaders(BODY, {
      id,
      timestamp,
      signature: `v1,${sign(BODY, id, timestamp, Buffer.from("another-key-entirely-here!!!"))}`,
    });
    expect(verifyRecallSvixSignature(BODY, headers, SECRET)).toBe(false);
  });

  it("rejects when any Svix header is missing", () => {
    expect(verifyRecallSvixSignature(BODY, svixHeaders(BODY, { id: null }), SECRET)).toBe(false);
    expect(
      verifyRecallSvixSignature(BODY, svixHeaders(BODY, { timestamp: null }), SECRET),
    ).toBe(false);
    expect(
      verifyRecallSvixSignature(BODY, svixHeaders(BODY, { signature: null }), SECRET),
    ).toBe(false);
  });

  it("rejects stale timestamps outside the tolerance window", () => {
    const id = "msg_test_1";
    const stale = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const headers = svixHeaders(BODY, { id, timestamp: stale, signature: `v1,${sign(BODY, id, stale)}` });
    expect(verifyRecallSvixSignature(BODY, headers, SECRET)).toBe(false);
  });

  it("ignores non-v1 entries", () => {
    const id = "msg_test_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = svixHeaders(BODY, {
      id,
      timestamp,
      signature: `v2,${sign(BODY, id, timestamp)}`,
    });
    expect(verifyRecallSvixSignature(BODY, headers, SECRET)).toBe(false);
  });
});

describe("handleRecallHookdeckWebhook Svix enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RECALL_WORKSPACE_VERIFICATION_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.RECALL_WORKSPACE_VERIFICATION_SECRET;
  });

  it("rejects an unverified delivery with 401 before any processing", async () => {
    const headers = svixHeaders(BODY, { signature: `v1,${Buffer.from("bogus").toString("base64")}` });
    const result = await handleRecallHookdeckWebhook(BODY, headers);
    expect(result.handled).toBe(true);
    if (!result.handled) throw new Error("unreachable");
    expect(result.response.status).toBe(401);
    expect(mocks.claimWebhookDelivery).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Svix signature verification failed"),
      expect.objectContaining({ area: "recall-webhook" }),
    );
  });

  it("rejects a delivery missing Svix headers with 401 when the secret is set", async () => {
    const result = await handleRecallHookdeckWebhook(BODY, new Headers());
    expect(result.handled).toBe(true);
    if (!result.handled) throw new Error("unreachable");
    expect(result.response.status).toBe(401);
    expect(mocks.claimWebhookDelivery).not.toHaveBeenCalled();
  });

  it("processes a correctly signed delivery past the verification gate", async () => {
    // Dedupe claim denial keeps the test scoped to the verification layer:
    // reaching the dedupe call at all proves the signature gate passed.
    mocks.claimWebhookDelivery.mockResolvedValue(false);
    const result = await handleRecallHookdeckWebhook(BODY, svixHeaders(BODY));
    expect(result.handled).toBe(true);
    if (!result.handled) throw new Error("unreachable");
    expect(result.response.status).toBe(200);
    expect(mocks.claimWebhookDelivery).toHaveBeenCalledTimes(1);
  });

  it("warns and continues when no verification secret is configured", async () => {
    delete process.env.RECALL_WORKSPACE_VERIFICATION_SECRET;
    mocks.claimWebhookDelivery.mockResolvedValue(false);
    const result = await handleRecallHookdeckWebhook(BODY, new Headers());
    expect(result.handled).toBe(true);
    if (!result.handled) throw new Error("unreachable");
    expect(result.response.status).toBe(200);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("not configured"),
      expect.objectContaining({ area: "recall-webhook" }),
    );
  });
});

describe("resolveRecallWorkspaceId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RECALL_WORKSPACE_ID;
  });

  afterEach(() => {
    delete process.env.RECALL_WORKSPACE_ID;
  });

  it("resolves a Recall connection id to its workspace", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_workspace_a",
      connectionId: "conn_recall_a",
      metadata: {},
    });

    await expect(
      resolveRecallWorkspaceId({ connectionId: " conn_recall_a " }),
    ).resolves.toBe("rw_workspace_a");
    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "recall",
      "conn_recall_a",
    );
    expect(mocks.listWorkspaceIntegrationsForProvider).not.toHaveBeenCalled();
  });

  it("resolves relay_workspace_id directly as the primary customer workspace", async () => {
    await expect(
      resolveRecallWorkspaceId({ workspaceId: " rw_workspace_a " }),
    ).resolves.toBe("rw_workspace_a");
    expect(mocks.findWorkspaceIntegrationByConnection).not.toHaveBeenCalled();
    expect(mocks.listWorkspaceIntegrationsForProvider).not.toHaveBeenCalled();
  });

  it("resolves distinct relay_workspace_id values to distinct workspaces", async () => {
    await expect(resolveRecallWorkspaceId({ workspaceId: "rw_workspace_a" })).resolves.toBe(
      "rw_workspace_a",
    );
    await expect(resolveRecallWorkspaceId({ workspaceId: "rw_workspace_b" })).resolves.toBe(
      "rw_workspace_b",
    );
    expect(mocks.findWorkspaceIntegrationByConnection).not.toHaveBeenCalled();
    expect(mocks.listWorkspaceIntegrationsForProvider).not.toHaveBeenCalled();
  });

  it("resolves different Recall connections to different workspaces", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockImplementation(
      async (_provider: string, connectionId: string) =>
        connectionId === "conn_recall_a"
          ? { workspaceId: "rw_workspace_a", connectionId, metadata: {} }
          : { workspaceId: "rw_workspace_b", connectionId, metadata: {} },
    );

    await expect(resolveRecallWorkspaceId({ connectionId: "conn_recall_a" })).resolves.toBe(
      "rw_workspace_a",
    );
    await expect(resolveRecallWorkspaceId({ connectionId: "conn_recall_b" })).resolves.toBe(
      "rw_workspace_b",
    );
  });

  it("resolves a Recall account id from integration metadata", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);
    mocks.listWorkspaceIntegrationsForProvider.mockResolvedValue([
      {
        workspaceId: "rw_workspace_a",
        connectionId: "conn_recall_a",
        metadata: { recall_account_id: "acct_a" },
      },
      {
        workspaceId: "rw_workspace_b",
        connectionId: "conn_recall_b",
        metadata: { account_id: "acct_b" },
      },
    ]);

    await expect(resolveRecallWorkspaceId({ accountId: "acct_b" })).resolves.toBe(
      "rw_workspace_b",
    );
  });

  it("keeps RECALL_WORKSPACE_ID as an optional fallback, not primary routing", async () => {
    process.env.RECALL_WORKSPACE_ID = "rw_single_tenant_fallback";
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);
    mocks.listWorkspaceIntegrationsForProvider.mockResolvedValue([]);

    await expect(resolveRecallWorkspaceId({ connectionId: "conn_missing" })).resolves.toBe(
      "rw_single_tenant_fallback",
    );
  });
});
