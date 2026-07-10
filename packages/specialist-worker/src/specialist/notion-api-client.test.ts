import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNotionIntegration } from "./notion-api-client.js";

// vitest 1.6's vi.fn<T>() expects an array generic for arg types, not a
// function type. Accept the looser shape here — the mock is invoked via
// globalThis.fetch and asserted on its mock.calls payload, neither of which
// needs the precise function-overload typing.
type FetchMock = ReturnType<typeof vi.fn>;

describe("createNotionIntegration", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts each supported Notion operation with auth headers", async () => {
    const integration = createNotionIntegration({
      cloudApiUrl: "https://cloud.example/",
      cloudApiToken: "specialist-token",
      workspaceId: "ws_test",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: "page-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const listPages = await integration.listPages({
      database: "db-1",
      query: "roadmap",
      limit: 12,
    });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({
      workspaceId: "ws_test",
      operation: "listPages",
      params: { database: "db-1", query: "roadmap", limit: 12 },
    });
    expect(new Headers((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers)).toEqual(
      expect.objectContaining({
        get: expect.any(Function),
      }),
    );
    const listPagesHeaders = new Headers(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers,
    );
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      "https://cloud.example/api/v1/notion/query",
    );
    expect(listPagesHeaders.get("accept")).toBe("application/json");
    expect(listPagesHeaders.get("authorization")).toBe("Bearer specialist-token");
    expect(listPagesHeaders.get("content-type")).toBe("application/json");
    expect(listPages.data).toEqual([{ id: "page-1" }]);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: "database-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const listDatabases = await integration.listDatabases({ limit: 7 });
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)).toEqual({
      workspaceId: "ws_test",
      operation: "listDatabases",
      params: { limit: 7 },
    });
    expect(listDatabases.data).toEqual([{ id: "database-1" }]);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: "search-page-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const searchPages = await integration.searchPages("quarterly", { limit: 4 });
    expect(JSON.parse((fetchMock.mock.calls[2] as [string, RequestInit])[1].body as string)).toEqual({
      workspaceId: "ws_test",
      operation: "searchPages",
      params: { query: "quarterly", limit: 4 },
    });
    expect(searchPages.data.items).toEqual([{ id: "search-page-1" }]);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "page-42" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const getPage = await integration.getPage("page-42");
    expect(JSON.parse((fetchMock.mock.calls[3] as [string, RequestInit])[1].body as string)).toEqual({
      workspaceId: "ws_test",
      operation: "getPage",
      params: { id: "page-42" },
    });
    expect(getPage.data).toEqual({ id: "page-42" });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "database-42" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const getDatabase = await integration.getDatabase("database-42");
    expect(JSON.parse((fetchMock.mock.calls[4] as [string, RequestInit])[1].body as string)).toEqual({
      workspaceId: "ws_test",
      operation: "getDatabase",
      params: { id: "database-42" },
    });
    expect(getDatabase.data).toEqual({ id: "database-42" });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: "block-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const listBlocks = await integration.listBlocks("page-42", { limit: 3 });
    expect(JSON.parse((fetchMock.mock.calls[5] as [string, RequestInit])[1].body as string)).toEqual({
      workspaceId: "ws_test",
      operation: "listBlocks",
      params: { pageId: "page-42", limit: 3 },
    });
    expect(listBlocks.data).toEqual([{ id: "block-1" }]);
  });

  it("throws with the response body text on non-ok responses", async () => {
    const responseText = vi.fn().mockResolvedValue("upstream exploded");
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: responseText,
    } as unknown as Response);

    const integration = createNotionIntegration({
      cloudApiUrl: "https://cloud.example",
      cloudApiToken: "specialist-token",
      workspaceId: "ws_test",
    });

    await expect(integration.getPage("page-1")).rejects.toThrow(
      /notion cloud query getPage page-1 failed: status=502 body=upstream exploded/u,
    );
    expect(responseText).toHaveBeenCalledTimes(1);
  });
});
