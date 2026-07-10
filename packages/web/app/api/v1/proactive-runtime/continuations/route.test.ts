import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  and: vi.fn(),
  eq: vi.fn(),
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  getDb: vi.fn(),
  normalizeRelayWorkspaceIdToAppWorkspaceId: vi.fn(),
  readBoundRelayWorkspaceId: vi.fn(),
  verifySlackReplyContextInRelayWorkspace: vi.fn(),
  createSlackUserReplyContinuation: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => mocks.and(...args),
  eq: (...args: unknown[]) => mocks.eq(...args),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: (...args: unknown[]) => mocks.resolveRequestAuth(...args),
  requireAuthScope: (...args: unknown[]) => mocks.requireAuthScope(...args),
}));

vi.mock("@/lib/db", () => ({
  getDb: (...args: unknown[]) => mocks.getDb(...args),
}));

vi.mock("@/lib/db/schema", () => ({
  agents: {
    id: "agents.id",
    workspaceId: "agents.workspace_id",
    deployedName: "agents.deployed_name",
  },
  workspaces: {
    id: "workspaces.id",
  },
}));

vi.mock("@/lib/workspaces/relay-workspace-binding", () => ({
  normalizeRelayWorkspaceIdToAppWorkspaceId: (...args: unknown[]) =>
    mocks.normalizeRelayWorkspaceIdToAppWorkspaceId(...args),
  readBoundRelayWorkspaceId: (...args: unknown[]) =>
    mocks.readBoundRelayWorkspaceId(...args),
}));

vi.mock("@/lib/proactive-runtime/continuation-slack-context", () => ({
  verifySlackReplyContextInRelayWorkspace: (...args: unknown[]) =>
    mocks.verifySlackReplyContextInRelayWorkspace(...args),
}));

vi.mock("@/lib/proactive-runtime/continuation-create", () => ({
  createSlackUserReplyContinuation: (...args: unknown[]) =>
    mocks.createSlackUserReplyContinuation(...args),
}));

import { slackUserReplyCorrelationKey } from "@/lib/proactive-runtime/continuation-correlation";
import { POST } from "./route";

function request(body: Record<string, unknown> = {}): NextRequest {
  return new Request(
    "http://localhost/api/v1/proactive-runtime/continuations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        originTurnId: "turn-1",
        slackReplyPath:
          "/slack/channels/C123/messages/1700000000.000100/replies/1700000001.000200.json",
        userId: "U123",
        question: "Please resolve the merge race.",
        ...body,
      }),
    },
  ) as NextRequest;
}

function relayfileAuth(overrides: Record<string, unknown> = {}) {
  mocks.resolveRequestAuth.mockResolvedValue({
    userId: "agent-user",
    workspaceId: "rw_workspace",
    organizationId: "org-1",
    source: "relayfile",
    relayfileSponsorId: "agent-1",
    scopes: ["workflow:invoke:write"],
    ...overrides,
  });
}

function sponsorRow(
  rows = [
    {
      id: "agent-1",
      workspaceId: "workspace-1",
      deployedName: "pr-reviewer",
    },
  ],
) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  mocks.getDb.mockReturnValue({ select });
}

describe("POST /api/v1/proactive-runtime/continuations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"));
    vi.stubEnv("PROACTIVE_CONTINUATION_RESUME_TEST_MODE", "1");
    mocks.and.mockReturnValue("and");
    mocks.eq.mockReturnValue("eq");
    mocks.requireAuthScope.mockImplementation(
      (auth: { scopes?: string[] } | null, scope: string) =>
        Boolean(auth?.scopes?.includes(scope)),
    );
    mocks.normalizeRelayWorkspaceIdToAppWorkspaceId.mockResolvedValue(
      "workspace-1",
    );
    mocks.readBoundRelayWorkspaceId.mockResolvedValue("rw_workspace");
    mocks.verifySlackReplyContextInRelayWorkspace.mockResolvedValue({
      path: "/slack/channels/C123/messages/1700000000.000100/replies/1700000001.000200.json",
      channel: "C123",
      thread: "1700000000.000100",
    });
    mocks.createSlackUserReplyContinuation.mockResolvedValue({
      continuation: {
        id: "cont-turn-1",
        waitFor: {
          type: "user_reply",
          correlationKey:
            "slack:channel:C123:thread:1700000000.000100:user:U123",
        },
      },
      correlationKey: "slack:channel:C123:thread:1700000000.000100:user:U123",
    });
    relayfileAuth();
    sponsorRow();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("is default-off and performs no write when disabled", async () => {
    vi.unstubAllEnvs();

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.resolveRequestAuth).not.toHaveBeenCalled();
    expect(mocks.createSlackUserReplyContinuation).not.toHaveBeenCalled();
  });

  it("rejects non-relayfile auth even with workflow scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      source: "session",
      scopes: ["workflow:invoke:write"],
    });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.createSlackUserReplyContinuation).not.toHaveBeenCalled();
  });

  it("rejects relayfile auth without sponsor ownership in the auth workspace", async () => {
    sponsorRow([]);

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "sponsor_forbidden",
    });
    expect(mocks.createSlackUserReplyContinuation).not.toHaveBeenCalled();
  });

  it("rejects Slack contexts that are not present in the sponsor workspace Relayfile", async () => {
    mocks.verifySlackReplyContextInRelayWorkspace.mockResolvedValue(null);

    const response = await POST(
      request({
        slackReplyPath:
          "/slack/channels/C999/messages/1700000000.000100/replies/1700000001.000200.json",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "slack_context_forbidden",
    });
    expect(mocks.verifySlackReplyContextInRelayWorkspace).toHaveBeenCalledWith({
      relayWorkspaceId: "rw_workspace",
      path: "/slack/channels/C999/messages/1700000000.000100/replies/1700000001.000200.json",
      channel: "C999",
      thread: "1700000000.000100",
    });
    expect(mocks.createSlackUserReplyContinuation).not.toHaveBeenCalled();
  });

  it("rejects malformed continuation bounds instead of dropping them", async () => {
    const badExpiresAt = await POST(request({ expiresAt: "not-a-date" }));

    expect(badExpiresAt.status).toBe(400);
    await expect(badExpiresAt.json()).resolves.toMatchObject({
      error: "invalid_expiresAt",
    });

    const pastExpiresAt = await POST(
      request({ expiresAt: "2026-01-01T00:00:00.000Z" }),
    );

    expect(pastExpiresAt.status).toBe(400);
    await expect(pastExpiresAt.json()).resolves.toMatchObject({
      error: "invalid_expiresAt",
    });

    const badAttempts = await POST(request({ maxResumeAttempts: 0 }));

    expect(badAttempts.status).toBe(400);
    await expect(badAttempts.json()).resolves.toMatchObject({
      error: "invalid_maxResumeAttempts",
    });
    expect(mocks.createSlackUserReplyContinuation).not.toHaveBeenCalled();
  });

  it("creates a user-reply continuation from verified workspace-scoped Slack input", async () => {
    const response = await POST(
      request({
        expiresAt: "2026-06-03T12:00:00.000Z",
        maxResumeAttempts: 2,
      }),
    );

    expect(response.status).toBe(200);
    const expectedKey = slackUserReplyCorrelationKey({
      channel: "C123",
      thread: "1700000000.000100",
      user: "U123",
    });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      continuationId: "cont-turn-1",
      correlationKey: expectedKey,
    });
    expect(mocks.createSlackUserReplyContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: "agent-1",
        originTurnId: "turn-1",
        slack: {
          channel: "C123",
          thread: "1700000000.000100",
          user: "U123",
        },
        bounds: {
          expiresAt: "2026-06-03T12:00:00.000Z",
          maxResumeAttempts: 2,
        },
        metadata: expect.objectContaining({
          workspaceId: "workspace-1",
          relayWorkspaceId: "rw_workspace",
          relayfileSponsorId: "agent-1",
          correlationKey: expectedKey,
        }),
      }),
    );
  });
});
