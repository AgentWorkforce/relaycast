/**
 * Local end-to-end test for the direct-proxy Slack writeback fast path.
 *
 * Spins up a real in-process HTTP server on a random port, rewrites
 * `https://slack.com/api` → `http://localhost:{port}` via a fetchImpl shim,
 * and drives `executeRelayfileProviderWriteback` end-to-end without Docker,
 * Nango, or a real Slack workspace.
 */

import * as http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic import of the bridge
// ---------------------------------------------------------------------------

const {
  getWorkspaceIntegrationByProviderAliasMock,
  proxyMock,
  findReceiptMock,
  recordReceiptMock,
  markReceiptAckedMock,
  claimIdempotencyMock,
  completeIdempotencyMock,
  releaseIdempotencyMock,
  waitForIdempotencyMock,
} = vi.hoisted(() => ({
  getWorkspaceIntegrationByProviderAliasMock: vi.fn(),
  proxyMock: vi.fn(),
  findReceiptMock: vi.fn(),
  recordReceiptMock: vi.fn(),
  markReceiptAckedMock: vi.fn(),
  claimIdempotencyMock: vi.fn(),
  completeIdempotencyMock: vi.fn(),
  releaseIdempotencyMock: vi.fn(),
  waitForIdempotencyMock: vi.fn(),
}));

vi.mock("./workspace-integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-integrations")>()),
  getWorkspaceIntegrationByProviderAlias: getWorkspaceIntegrationByProviderAliasMock,
}));

vi.mock("./nango-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nango-service")>()),
  getNangoClient: vi.fn(() => ({ proxy: proxyMock })),
  getProviderConfigKey: vi.fn((provider: string) => `${provider}-default`),
  getSlackProviderConfigKey: vi.fn().mockReturnValue("slack-relay"),
}));

vi.mock("./relayfile-writeback-receipts", () => ({
  findRelayfileWritebackReceipt: findReceiptMock,
  recordRelayfileWritebackReceipt: recordReceiptMock,
  markRelayfileWritebackReceiptAcked: markReceiptAckedMock,
}));

vi.mock("./slack-direct-proxy-writeback-idempotency", () => ({
  claimSlackDirectProxyWriteback: claimIdempotencyMock,
  completeSlackDirectProxyWriteback: completeIdempotencyMock,
  releaseSlackDirectProxyWritebackClaim: releaseIdempotencyMock,
  waitForSlackDirectProxyWritebackResult: waitForIdempotencyMock,
}));

vi.mock("../relayfile", () => ({
  resolveRelayfileConfig: () => ({
    relayfileUrl: "https://relayfile.test",
    relayAuthUrl: "https://relayauth.test",
    relayAuthApiKey: "relayauth-key",
  }),
}));

vi.mock("@relayfile/sdk", () => ({
  RelayFileClient: class {
    getBaseUrl(): string {
      return "https://relayfile.test";
    }
    async getToken(): Promise<string> {
      return "test-token";
    }
  },
}));

// ---------------------------------------------------------------------------
// Captured request shape
// ---------------------------------------------------------------------------

type CapturedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// In-process HTTP server setup
// ---------------------------------------------------------------------------

let server: http.Server;
let serverPort: number;
const capturedRequests: CapturedRequest[] = [];

// Tests set this to control what the mock server returns.
let mockServerResponse: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify({ ok: true, ts: "1234567890.000100" }),
};
// Per-request queue: when non-empty, each request pops the next entry.
// Falls back to mockServerResponse when queue is empty.
let mockResponseQueue: Array<{ status: number; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let rawBody = "";
    req.on("data", (chunk: Buffer | string) => {
      rawBody += chunk.toString();
    });
    req.on("end", () => {
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        // leave as empty object for non-JSON bodies
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers[key] = value;
        } else if (Array.isArray(value)) {
          headers[key] = value.join(", ");
        }
      }

      capturedRequests.push({
        method: req.method ?? "UNKNOWN",
        url: req.url ?? "/",
        headers,
        body: parsedBody,
      });

      const queued = mockResponseQueue.shift();
      const { status, body } = queued ?? mockServerResponse;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Unexpected server address type");
  }
  serverPort = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * fetchImpl shim: rewrites `https://slack.com/api` → `http://localhost:{port}`
 * and delegates to the real global fetch.
 */
function makeLocalFetchImpl(port: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const original =
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : (input as Request).url;
    const rewritten = original.replace(
      "https://slack.com/api",
      `http://127.0.0.1:${port}`,
    );
    return fetch(rewritten, init);
  };
}

const resolveBotToken = async (_workspaceId: string): Promise<string | null> =>
  "xoxb-e2e-test-token";

function buildSlackIntegration(
  overrides: Partial<WorkspaceIntegrationRecord> = {},
): WorkspaceIntegrationRecord {
  return {
    id: "integration_slack_e2e",
    workspaceId: "ws_e2e",
    provider: "slack",
    connectionId: "conn_slack_e2e",
    providerConfigKey: "slack-relay",
    installationId: null,
    metadata: {},
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

// Path: /slack/channels/C0TESTCHAN/messages/1111111111_000100/replies/reply.json
// → channel="C0TESTCHAN", thread_ts="1111111111.000100"
const REPLY_PATH =
  "/slack/channels/C0TESTCHAN/messages/1111111111_000100/replies/reply.json";
const REPLY_CONTENT = JSON.stringify({ text: "Hello from direct-proxy e2e!" });

function resetIdempotencyMocks(): void {
  claimIdempotencyMock.mockResolvedValue({ claimed: true });
  completeIdempotencyMock.mockResolvedValue(undefined);
  releaseIdempotencyMock.mockResolvedValue(undefined);
  waitForIdempotencyMock.mockResolvedValue(null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("direct-proxy Slack writeback e2e — writebackDispatchVia: cf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotencyMocks();
    capturedRequests.length = 0;
    mockResponseQueue = [];
    mockServerResponse = { status: 200, body: JSON.stringify({ ok: true, ts: "1234567890.000100" }) };

    // No pre-existing receipt → always execute
    findReceiptMock.mockResolvedValue(null);
    recordReceiptMock.mockResolvedValue(undefined);
    markReceiptAckedMock.mockResolvedValue(undefined);

    // Nango proxy should not be needed; configure a fallback just in case
    proxyMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      data: { ok: true, ts: "nango-should-not-be-called.000000" },
    });
  });

  it("routes through direct egress and hits the local HTTP server", async () => {
    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      {
        opId: "op_e2e_direct_proxy",
        workspaceId: "ws_e2e",
        path: REPLY_PATH,
        revision: "rev_1",
        correlationId: "corr_e2e",
        action: "file_upsert",
        content: REPLY_CONTENT,
      },
      {
        fetchImpl: makeLocalFetchImpl(serverPort),
        resolveBotToken,
      },
    );

    // --- outcome ---
    expect(result.outcome).toBe("success");
    expect(result.metadata?.externalId).toBe("1234567890.000100");

    // --- server received exactly 1 request ---
    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0]!;

    expect(req.method).toBe("POST");
    expect(req.url).toBe("/chat.postMessage");
    expect(req.headers["authorization"]).toBe("Bearer xoxb-e2e-test-token");
    expect(req.headers["content-type"]).toMatch(/^application\/json/);

    // --- Slack payload ---
    expect(req.body["channel"]).toBe("C0TESTCHAN");
    expect(req.body["text"]).toBe("Hello from direct-proxy e2e!");
    expect(req.body["thread_ts"]).toBe("1111111111.000100");

    // --- Nango was never called ---
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("post_message path — no thread_ts in request body", async () => {
    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);
    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      {
        opId: "op_e2e_post_message",
        workspaceId: "ws_e2e",
        path: "/slack/channels/C0TESTCHAN/messages/draft@top-level.json",
        revision: "rev_pm",
        correlationId: "corr_pm",
        action: "file_upsert",
        content: JSON.stringify({ text: "Top-level message" }),
      },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("success");
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]!.body["channel"]).toBe("C0TESTCHAN");
    expect(capturedRequests[0]!.body["thread_ts"]).toBeUndefined();
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("Slack ratelimited → retryable_failure", async () => {
    mockServerResponse = { status: 200, body: JSON.stringify({ ok: false, error: "ratelimited" }) };
    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);
    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      { opId: "op_ratelimited", workspaceId: "ws_e2e", path: REPLY_PATH, revision: "rev_rl", correlationId: "corr_rl", action: "file_upsert", content: REPLY_CONTENT },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("retryable_failure");
  });

  it("Slack channel_not_found → permanent_failure", async () => {
    mockServerResponse = { status: 200, body: JSON.stringify({ ok: false, error: "channel_not_found" }) };
    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);
    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      { opId: "op_not_found", workspaceId: "ws_e2e", path: REPLY_PATH, revision: "rev_nf", correlationId: "corr_nf", action: "file_upsert", content: REPLY_CONTENT },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("permanent_failure");
  });

  it("HTTP 429 → retryable_failure", async () => {
    mockServerResponse = { status: 429, body: "Too Many Requests" };
    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);
    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      { opId: "op_429", workspaceId: "ws_e2e", path: REPLY_PATH, revision: "rev_429", correlationId: "corr_429", action: "file_upsert", content: REPLY_CONTENT },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("retryable_failure");
  });

  it("non-JSON 2xx → retryable_failure (invalid_response bug fix)", async () => {
    mockServerResponse = { status: 200, body: "<html>502 Bad Gateway</html>" };
    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);
    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      { opId: "op_nonjson", workspaceId: "ws_e2e", path: REPLY_PATH, revision: "rev_nj", correlationId: "corr_nj", action: "file_upsert", content: REPLY_CONTENT },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("retryable_failure");
  });
});

// ---------------------------------------------------------------------------
// Reactions direct-proxy e2e tests
// ---------------------------------------------------------------------------

describe("direct-proxy Slack reaction writeback e2e — add_reaction + remove_reaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotencyMocks();
    capturedRequests.length = 0;
    mockServerResponse = { status: 200, body: JSON.stringify({ ok: true }) };

    findReceiptMock.mockResolvedValue(null);
    recordReceiptMock.mockResolvedValue(undefined);
    markReceiptAckedMock.mockResolvedValue(undefined);

    proxyMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      data: { ok: true },
    });
  });

  it("add_reaction: hits /reactions.add on local server with correct payload", async () => {
    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    // add_reaction is file_upsert; path format: /slack/channels/<ch>/messages/<ts_token>/reactions/draft@reaction.json
    // content is a plain emoji name
    const result = await executeRelayfileProviderWriteback(
      {
        opId: "op_add_reaction_e2e",
        workspaceId: "ws_e2e",
        path: "/slack/channels/C0TESTCHAN/messages/1111111111_000100/reactions/draft@reaction.json",
        revision: "rev_ar",
        correlationId: "corr_ar",
        action: "file_upsert",
        content: "white_check_mark",
      },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("success");
    expect(capturedRequests).toHaveLength(1);

    const req = capturedRequests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/reactions.add");
    expect(req.headers["authorization"]).toBe("Bearer xoxb-e2e-test-token");
    expect(req.body["channel"]).toBe("C0TESTCHAN");
    expect(req.body["timestamp"]).toBe("1111111111.000100");
    expect(req.body["name"]).toBe("white_check_mark");

    // Nango was never called
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("remove_reaction: hits /reactions.remove on local server with correct payload", async () => {
    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    // remove_reaction is file_delete; path format: /slack/channels/<ch>/messages/<ts_token>/reactions/<name>.json
    const result = await executeRelayfileProviderWriteback(
      {
        opId: "op_remove_reaction_e2e",
        workspaceId: "ws_e2e",
        path: "/slack/channels/C0TESTCHAN/messages/1111111111_000100/reactions/eyes.json",
        revision: "rev_rr",
        correlationId: "corr_rr",
        action: "file_delete",
        content: "",
      },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("success");
    expect(capturedRequests).toHaveLength(1);

    const req = capturedRequests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/reactions.remove");
    expect(req.headers["authorization"]).toBe("Bearer xoxb-e2e-test-token");
    expect(req.body["channel"]).toBe("C0TESTCHAN");
    expect(req.body["timestamp"]).toBe("1111111111.000100");
    expect(req.body["name"]).toBe("eyes");

    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("add_reaction ratelimited → retryable_failure", async () => {
    mockServerResponse = { status: 200, body: JSON.stringify({ ok: false, error: "ratelimited" }) };
    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      {
        opId: "op_reaction_ratelimited",
        workspaceId: "ws_e2e",
        path: "/slack/channels/C0TESTCHAN/messages/1111111111_000100/reactions/draft@reaction.json",
        revision: "rev_rl_r",
        correlationId: "corr_rl_r",
        action: "file_upsert",
        content: "eyes",
      },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("retryable_failure");
  });
});

describe("bridge fallback Slack writeback e2e — writebackDispatchVia: bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotencyMocks();
    capturedRequests.length = 0;
    mockResponseQueue = [];
    mockServerResponse = { status: 200, body: JSON.stringify({ ok: true, ts: "1234567890.000100" }) };

    findReceiptMock.mockResolvedValue(null);
    recordReceiptMock.mockResolvedValue(undefined);
    markReceiptAckedMock.mockResolvedValue(undefined);

    proxyMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      data: { ok: true, ts: "bridge-ts.000100" },
    });
  });

  it("calls Nango proxy and does NOT hit the local HTTP server", async () => {
    const integration = buildSlackIntegration({ writebackDispatchVia: "bridge" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      {
        opId: "op_e2e_bridge_fallback",
        workspaceId: "ws_e2e",
        path: REPLY_PATH,
        revision: "rev_2",
        correlationId: "corr_e2e_bridge",
        action: "file_upsert",
        content: REPLY_CONTENT,
      },
      {
        fetchImpl: makeLocalFetchImpl(serverPort),
        resolveBotToken,
      },
    );

    expect(result.outcome).toBe("success");

    // Nango proxy IS called (bridge path)
    expect(proxyMock).toHaveBeenCalledOnce();

    // Local server receives 0 requests (direct egress NOT called)
    expect(capturedRequests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DM direct-proxy e2e tests
// ---------------------------------------------------------------------------

describe("direct-proxy Slack DM writeback e2e — post_dm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotencyMocks();
    capturedRequests.length = 0;
    mockResponseQueue = [];
    mockServerResponse = { status: 200, body: JSON.stringify({ ok: true }) };

    findReceiptMock.mockResolvedValue(null);
    recordReceiptMock.mockResolvedValue(undefined);
    markReceiptAckedMock.mockResolvedValue(undefined);

    proxyMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      data: { ok: true, ts: "nango-should-not-be-called.000000" },
    });
  });

  it("post_dm cf → two requests (conversations.open then chat.postMessage), correct payloads", async () => {
    // Queue two responses: first for conversations.open, second for chat.postMessage
    mockResponseQueue = [
      { status: 200, body: JSON.stringify({ ok: true, channel: { id: "D0TESTDM" } }) },
      { status: 200, body: JSON.stringify({ ok: true, ts: "1234567890.000200" }) },
    ];

    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      {
        opId: "op_dm_e2e",
        workspaceId: "ws_e2e",
        path: "/slack/users/U0TESTUSER/messages/draft@dm.json",
        revision: "rev_dm",
        correlationId: "corr_dm",
        action: "file_upsert",
        content: JSON.stringify({ text: "Hello DM!" }),
      },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("success");
    expect(result.metadata?.externalId).toBe("1234567890.000200");

    // Two requests: conversations.open then chat.postMessage
    expect(capturedRequests).toHaveLength(2);

    const openReq = capturedRequests[0]!;
    expect(openReq.method).toBe("POST");
    expect(openReq.url).toBe("/conversations.open");
    expect(openReq.headers["authorization"]).toBe("Bearer xoxb-e2e-test-token");
    expect(openReq.body["users"]).toBe("U0TESTUSER");
    expect(openReq.body["return_im"]).toBe(true);

    const postReq = capturedRequests[1]!;
    expect(postReq.method).toBe("POST");
    expect(postReq.url).toBe("/chat.postMessage");
    expect(postReq.headers["authorization"]).toBe("Bearer xoxb-e2e-test-token");
    expect(postReq.body["channel"]).toBe("D0TESTDM");
    expect(postReq.body["text"]).toBe("Hello DM!");

    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("post_dm conversations.open ratelimited → retryable_failure, no second request", async () => {
    mockServerResponse = { status: 200, body: JSON.stringify({ ok: false, error: "ratelimited" }) };

    const integration = buildSlackIntegration({ writebackDispatchVia: "cf" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      {
        opId: "op_dm_ratelimited",
        workspaceId: "ws_e2e",
        path: "/slack/users/U0TESTUSER/messages/draft@dm.json",
        revision: "rev_dm_rl",
        correlationId: "corr_dm_rl",
        action: "file_upsert",
        content: JSON.stringify({ text: "Hello!" }),
      },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("retryable_failure");
    // Only conversations.open was called; chat.postMessage was never reached
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]!.url).toBe("/conversations.open");
  });

  it("post_dm bridge → Nango called, no local server requests", async () => {
    proxyMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        data: { ok: true, channel: { id: "D0TESTDM" } },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        data: { ok: true, ts: "bridge-dm.000100" },
      });

    const integration = buildSlackIntegration({ writebackDispatchVia: "bridge" });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(integration);

    const { executeRelayfileProviderWriteback } = await import("./relayfile-writeback-bridge");

    const result = await executeRelayfileProviderWriteback(
      {
        opId: "op_dm_bridge",
        workspaceId: "ws_e2e",
        path: "/slack/users/U0TESTUSER/messages/draft@dm.json",
        revision: "rev_dm_br",
        correlationId: "corr_dm_br",
        action: "file_upsert",
        content: JSON.stringify({ text: "Bridge DM" }),
      },
      { fetchImpl: makeLocalFetchImpl(serverPort), resolveBotToken },
    );

    expect(result.outcome).toBe("success");
    expect(proxyMock).toHaveBeenCalledTimes(2);
    expect(capturedRequests).toHaveLength(0);
  });
});
