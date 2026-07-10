import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  tryResourceValue: vi.fn(),
  createWebhookSyncJob: vi.fn((input: Record<string, unknown>) => input),
  writeBatchToRelayfile: vi.fn(),
  createGitHubRelayfileClient: vi.fn(),
  dispatchIntegrationWatchEvent: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock("@cloud/core/sync/record-writer.js", () => ({
  createWebhookSyncJob: mocks.createWebhookSyncJob,
  writeBatchToRelayfile: mocks.writeBatchToRelayfile,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ select: mocks.dbSelect }),
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/integrations/github-relayfile", () => ({
  createGitHubRelayfileClient: mocks.createGitHubRelayfileClient,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findWorkspaceIntegrationByConnection: mocks.findWorkspaceIntegrationByConnection,
}));

vi.mock("@/lib/logger", () => ({
  captureError: mocks.captureError,
  logger: {
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
  },
}));

vi.mock("@/lib/proactive-runtime/service-client", () => ({
  dispatchIntegrationWatchEvent: mocks.dispatchIntegrationWatchEvent,
}));

import { POST } from "./route";

const SECRET = "linear-secret";

function sign(rawBody: string): string {
  return createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

function linearIssuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "update",
    type: "Issue",
    organizationId: "org_linear_123",
    webhookTimestamp: 1_780_000_000_000,
    webhookId: "webhook_123",
    data: {
      id: "issue_123",
      identifier: "AR-267",
      title: "[factory] Phase 2 cloud lift",
      description: "Lift the factory brain into cloud.",
      priority: 2,
      url: "https://linear.app/acme/issue/AR-267",
      createdAt: "2026-06-15T10:00:00.000Z",
      updatedAt: "2026-06-16T10:00:00.000Z",
      state: { name: "Ready for Agent", type: "started" },
      labels: {
        nodes: [
          { id: "label_factory", name: "factory" },
          { id: "label_cloud", name: "cloud" },
        ],
      },
    },
    ...overrides,
  };
}

function makeRequest(payload: Record<string, unknown>, signature?: string): NextRequest {
  const rawBody = JSON.stringify(payload);
  return new NextRequest("https://agentrelay.test/api/v1/webhooks/linear", {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "linear-event": "Issue",
      "linear-delivery": "delivery_123",
      "linear-signature": signature ?? sign(rawBody),
      "x-relay-connection-id": "conn_linear_123",
      "x-relay-provider-config-key": "linear-relay",
    },
  });
}

// Request that carries no connection identifier in query/headers/payload, so
// the route falls back to the organization-id lookup
// (findLinearIntegrationByOrganizationId).
function makeRequestWithoutConnection(payload: Record<string, unknown>): NextRequest {
  const rawBody = JSON.stringify(payload);
  return new NextRequest("https://agentrelay.test/api/v1/webhooks/linear", {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "linear-event": "Issue",
      "linear-delivery": "delivery_123",
      "linear-signature": sign(rawBody),
    },
  });
}

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "integration_1",
    workspaceId: "workspace-1",
    provider: "linear",
    name: null,
    connectionId: "conn_linear_123",
    providerConfigKey: "linear-relay",
    installationId: null,
    metadataJson: JSON.stringify({ organizationId: "org_linear_123" }),
    writebackDispatchVia: "bridge",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

// Stubs the fluent drizzle select() chain used by
// findLinearIntegrationByOrganizationId to return the provided rows.
function stubOrgLookupRows(rows: Array<Record<string, unknown>>): void {
  mocks.dbSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  });
}

function integration(metadata: Record<string, unknown> = { organizationId: "org_linear_123" }) {
  return {
    id: "integration_1",
    workspaceId: "workspace-1",
    provider: "linear",
    name: null,
    connectionId: "conn_linear_123",
    providerConfigKey: "linear-relay",
    installationId: null,
    metadata,
    writebackDispatchVia: "bridge" as const,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

describe("POST /api/v1/webhooks/linear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryResourceValue.mockImplementation((name: string) =>
      name === "LinearWebhookSecret" ? SECRET : undefined,
    );
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(integration());
    mocks.createGitHubRelayfileClient.mockReturnValue({
      ingestWebhook: vi.fn(),
    });
    mocks.writeBatchToRelayfile.mockResolvedValue({ written: 1, deleted: 0, errors: 0 });
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({ matched: 1, delivered: 1, failed: 0 });
  });

  it("rejects invalid Linear signatures before workspace lookup", async () => {
    const response = await POST(makeRequest(linearIssuePayload(), "bad-signature"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid signature" });
    expect(mocks.findWorkspaceIntegrationByConnection).not.toHaveBeenCalled();
    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
  });

  it("rejects unconfigured Linear workspaces", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);

    const response = await POST(makeRequest(linearIssuePayload()));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Linear workspace integration is not configured",
    });
    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
  });

  it("rejects a connection whose configured Linear organization does not match the webhook", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(
      integration({ organizationId: "org_other" }),
    );

    const response = await POST(makeRequest(linearIssuePayload()));

    expect(response.status).toBe(404);
    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
  });

  it("writes Linear issue records before dispatching the watch event", async () => {
    const response = await POST(makeRequest(linearIssuePayload()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "written",
      id: "delivery_123",
      path: "/linear/issues/issue_123.json",
      workspaceId: "workspace-1",
    });

    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledWith(
      expect.any(Object),
      [
        expect.objectContaining({
          id: "issue_123",
          identifier: "AR-267",
          title: "[factory] Phase 2 cloud lift",
          labels: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({ name: "factory" }),
            ]),
          }),
          _webhook: expect.objectContaining({
            eventType: "issue.update",
            organizationId: "org_linear_123",
          }),
        }),
      ],
      expect.objectContaining({
        workspaceId: "workspace-1",
        connectionId: "conn_linear_123",
        providerConfigKey: "linear-relay",
        provider: "linear",
        syncName: "fetch-active-issues",
        model: "LinearIssue",
      }),
    );
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      provider: "linear",
      eventType: "issue.update",
      connectionId: "conn_linear_123",
      deliveryId: "delivery_123",
      paths: expect.arrayContaining([
        "/linear/issues/issue_123.json",
        "/linear/issues/by-state/ready-for-agent/AR-267.json",
      ]),
      payload: expect.objectContaining({
        id: "issue_123",
        identifier: "AR-267",
        labels: expect.any(Object),
      }),
      occurredAt: expect.any(String),
    });
    expect(
      mocks.writeBatchToRelayfile.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0]);
  });

  it("fails closed when no webhook secret is configured", async () => {
    mocks.tryResourceValue.mockReturnValue(undefined);
    const prior = process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRET;

    try {
      const response = await POST(makeRequest(linearIssuePayload()));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Linear webhook signature verification is not configured",
      });
      expect(mocks.findWorkspaceIntegrationByConnection).not.toHaveBeenCalled();
      expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
      expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) {
        delete process.env.LINEAR_WEBHOOK_SECRET;
      } else {
        process.env.LINEAR_WEBHOOK_SECRET = prior;
      }
    }
  });

  it("treats the SST 'unset' placeholder secret as not configured and fails closed", async () => {
    mocks.tryResourceValue.mockImplementation((name: string) =>
      name === "LinearWebhookSecret" ? "unset" : undefined,
    );
    const prior = process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRET;

    try {
      const response = await POST(makeRequest(linearIssuePayload()));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Linear webhook signature verification is not configured",
      });
      expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
      expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) {
        delete process.env.LINEAR_WEBHOOK_SECRET;
      } else {
        process.env.LINEAR_WEBHOOK_SECRET = prior;
      }
    }
  });

  it("emits a Linear issue 'remove' webhook as a deletion, not an upsert", async () => {
    mocks.writeBatchToRelayfile.mockResolvedValue({ written: 0, deleted: 1, errors: 0 });

    const response = await POST(
      makeRequest(linearIssuePayload({ action: "remove" })),
    );

    expect(response.status).toBe(200);
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    const [, records, job] = mocks.writeBatchToRelayfile.mock.calls[0];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "issue_123",
      _nango_metadata: {
        last_action: "deleted",
        deleted_at: expect.any(String),
      },
    });
    expect(job).toMatchObject({ model: "LinearIssue", syncName: "fetch-active-issues" });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "issue.remove" }),
    );
  });

  it("keeps a terminal state change (canceled) as an upsert that preserves state", async () => {
    const response = await POST(
      makeRequest(
        linearIssuePayload({
          action: "update",
          data: {
            id: "issue_123",
            identifier: "AR-267",
            title: "[factory] Phase 2 cloud lift",
            state: { name: "Canceled", type: "canceled" },
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    const [, records] = mocks.writeBatchToRelayfile.mock.calls[0];
    expect(records[0]).toMatchObject({
      id: "issue_123",
      state: { type: "canceled" },
    });
    expect(records[0]).not.toHaveProperty("_nango_metadata");
  });

  it("dispatches canonical and by-state alias paths for an issue state change (regression: BUG-8)", async () => {
    // BUG-8: dispatch was called with only the canonical path; by-state alias paths were missing.
    const response = await POST(makeRequest(linearIssuePayload()));

    expect(response.status).toBe(200);
    const call = mocks.dispatchIntegrationWatchEvent.mock.calls[0]?.[0] as
      | { paths: string[] }
      | undefined;
    expect(call).toBeDefined();
    expect(call?.paths).toContain("/linear/issues/issue_123.json");
    expect(call?.paths).toContain("/linear/issues/by-state/ready-for-agent/AR-267.json");
  });

  it("does not add by-state alias paths for non-issue Linear object types", async () => {
    const commentPayload = {
      action: "create",
      type: "Comment",
      organizationId: "org_linear_123",
      webhookTimestamp: 1_780_000_000_001,
      webhookId: "webhook_comment_1",
      data: {
        id: "comment_abc",
        body: "LGTM",
        issueId: "issue_123",
        createdAt: "2026-06-16T11:00:00.000Z",
        updatedAt: "2026-06-16T11:00:00.000Z",
      },
    };
    const rawBody = JSON.stringify(commentPayload);
    const request = new NextRequest("https://agentrelay.test/api/v1/webhooks/linear", {
      method: "POST",
      body: rawBody,
      headers: {
        "content-type": "application/json",
        "linear-event": "Comment",
        "linear-delivery": "delivery_comment_1",
        "linear-signature": sign(rawBody),
        "x-relay-connection-id": "conn_linear_123",
        "x-relay-provider-config-key": "linear-relay",
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const call = mocks.dispatchIntegrationWatchEvent.mock.calls[0]?.[0] as
      | { paths: string[] }
      | undefined;
    expect(call).toBeDefined();
    expect(call?.paths?.some((p) => p.includes("by-state"))).toBe(false);
  });

  it("resolves a suffixed linear-* integration via the organization-id fallback", async () => {
    stubOrgLookupRows([
      dbRow({
        id: "integration_ricky",
        provider: "linear-ricky",
        connectionId: "conn_ricky",
        providerConfigKey: "linear-ricky-relay",
      }),
    ]);

    const payload = linearIssuePayload();
    const response = await POST(makeRequestWithoutConnection(payload));

    expect(response.status).toBe(200);
    expect(mocks.findWorkspaceIntegrationByConnection).not.toHaveBeenCalled();
    expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      status: "written",
      workspaceId: "workspace-1",
    });
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      expect.objectContaining({ connectionId: "conn_ricky" }),
    );
  });
});
