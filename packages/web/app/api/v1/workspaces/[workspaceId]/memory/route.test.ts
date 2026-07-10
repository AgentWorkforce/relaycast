import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireSessionAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  tryResourceValue: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: mocks.requireSessionAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: vi.fn(() => undefined),
  tryResourceValue: mocks.tryResourceValue,
}));

import { GET, POST } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000002";
const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token" as const,
  subjectType: "sandbox" as const,
  scopes: ["workflow:runs:read"],
};

function context() {
  return { params: Promise.resolve({ workspaceId }) };
}

describe("workspace memory route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireSessionAuth.mockReturnValue(false);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.tryResourceValue.mockReturnValue("supermemory-key");
  });

  it("saves memory into the workspace space", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "mem_1" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        body: JSON.stringify({ content: "remember this", tags: ["a"] }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "mem_1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.supermemory.ai/v3/memories",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
        body: expect.stringContaining(`agentrelay-ws-${workspaceId}`),
      }),
    );
  });

  it("uses the shared global memory space", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "mem_global" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        body: JSON.stringify({ scope: "global", content: "remember this" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.supermemory.ai/v3/memories",
      expect.objectContaining({
        body: expect.stringContaining('"space":"agentrelay-global"'),
      }),
    );
  });

  it("recalls memory items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [{ id: "mem_1", content: "hello", tags: ["a"] }] })),
    );

    const url = new URL(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`);
    url.searchParams.set("query", "hello");
    const response = await GET(new NextRequest(url), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [{ id: "mem_1", content: "hello", tags: ["a"], createdAt: null }],
    });
  });

  it("returns a controlled timeout response when Supermemory hangs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );

    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        body: JSON.stringify({ content: "remember this" }),
      }),
      context(),
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ code: "supermemory_timeout" });
  });

  it("returns a controlled timeout response when Supermemory recall aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      }),
    );

    const url = new URL(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`);
    url.searchParams.set("query", "hello");
    const response = await GET(new NextRequest(url), context());

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ code: "supermemory_timeout" });
  });

  it("returns a controlled upstream error response when Supermemory fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const url = new URL(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`);
    url.searchParams.set("query", "hello");
    const response = await GET(new NextRequest(url), context());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "supermemory_unavailable" });
  });

  it("rejects invalid scopes", async () => {
    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        body: JSON.stringify({ scope: "org", content: "remember this" }),
      }),
      context(),
    );

    expect(response.status).toBe(400);
  });

  it("allows session UI access through workspace membership", async () => {
    const sessionAuth = {
      ...auth,
      source: "session" as const,
      context: {},
    };
    mocks.resolveRequestAuth.mockResolvedValueOnce(sessionAuth);
    mocks.requireSessionAuth.mockReturnValueOnce(true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "mem_session" })));

    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        body: JSON.stringify({ content: "remember this" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.hasWorkspaceAccess).toHaveBeenCalledWith(sessionAuth, workspaceId);
  });

  it("allows relayfile workflow tokens to access workspace memory", async () => {
    const relayfileAuth = {
      ...auth,
      source: "relayfile" as const,
      scopes: ["workflow:invoke:write", "workflow:runs:read"],
      subjectType: undefined,
      relayfileSponsorId: "agent-1",
    };
    mocks.resolveRequestAuth.mockResolvedValueOnce(relayfileAuth);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "mem_relayfile" })));

    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        body: JSON.stringify({ content: "remember this" }),
      }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "mem_relayfile" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.supermemory.ai/v3/memories",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(`agentrelay-ws-${workspaceId}`),
      }),
    );
  });

  it("rejects relayfile tokens without workflow invoke scope", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...auth,
      source: "relayfile",
      scopes: ["workflow:runs:read"],
      subjectType: undefined,
      relayfileSponsorId: "agent-1",
    });

    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        body: JSON.stringify({ content: "remember this" }),
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects relayfile workflow tokens without a sponsor identity", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...auth,
      source: "relayfile",
      scopes: ["workflow:invoke:write"],
      subjectType: undefined,
      relayfileSponsorId: null,
    });

    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        body: JSON.stringify({ content: "remember this" }),
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects generic workspace-scoped CLI tokens", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...auth,
      subjectType: "cli",
      scopes: ["cli:auth"],
    });

    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/memory`, {
        method: "POST",
        body: JSON.stringify({ content: "remember this" }),
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
