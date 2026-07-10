import { describe, expect, it, vi } from "vitest";

import { createNotionLibrarianApiFallback, type NotionIntegration } from "./notion-api-fallback.js";

type ListPages = NonNullable<NotionIntegration["listPages"]>;

function createPageRecord(id: string, title: string, databaseId: string) {
  return {
    object: "page",
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: `2026-04-26T09:0${id.slice(-1)}:00.000Z`,
    parent: {
      type: "database_id",
      database_id: databaseId,
    },
    properties: {
      Name: {
        type: "title",
        title: [{ plain_text: title }],
      },
      Tags: {
        type: "multi_select",
        multi_select: [{ name: "alpha" }, { name: "beta" }],
      },
      Author: {
        type: "people",
        people: [{ name: "Ada Lovelace" }],
      },
    },
  };
}

describe("createNotionLibrarianApiFallback", () => {
  it("passes database filters into listPages and preserves mapped properties on all returned entries", async () => {
    const listPages = vi
      .fn<Parameters<ListPages>, ReturnType<ListPages>>()
      .mockResolvedValue({
        data: Array.from({ length: 5 }, (_, index) =>
          createPageRecord(`page-${index + 1}`, `Roadmap ${index + 1}`, "db-123"),
        ),
      });

    const fallback = createNotionLibrarianApiFallback({ listPages });

    // The agent-assistant LibrarianFallbackRequest type doesn't declare a
    // `limit` field but the cloud fallback's `limitFromRequest` helper reads
    // it from the request at runtime as a structural extension. Cast through
    // unknown so the runtime contract is testable without weakening the
    // upstream type.
    const entries = await fallback({
      instruction: "Enumerate database pages",
      text: "show me roadmap items",
      filters: { database: ["db-123"] },
      types: ["page"],
      limit: 5,
    } as unknown as Parameters<typeof fallback>[0]);

    expect(listPages).toHaveBeenCalledWith({ database: "db-123", limit: 5 });
    expect(entries).toHaveLength(5);
    expect(entries[0]?.properties).toEqual(
      expect.objectContaining({
        type: "page",
        title: "Roadmap 1",
        parent: "db-123",
        tags: JSON.stringify(["alpha", "beta"]),
        author: "Ada Lovelace",
        lastEditedAt: "2026-04-26T09:01:00.000Z",
        url: "https://www.notion.so/page-1",
      }),
    );
  });

  it("does not substring-filter listPages results based on request.text", async () => {
    const listPages = vi
      .fn<Parameters<ListPages>, ReturnType<ListPages>>()
      .mockResolvedValue({
        data: [
          createPageRecord("page-1", "Alpha plan", "db-9"),
          createPageRecord("page-2", "Beta notes", "db-9"),
          createPageRecord("page-3", "Gamma log", "db-9"),
        ],
      });

    const fallback = createNotionLibrarianApiFallback({ listPages });

    const entries = await fallback({
      instruction: "Enumerate pages",
      text: "only return pages mentioning zebra",
      filters: {},
      types: ["page"],
      limit: 3,
    } as unknown as Parameters<typeof fallback>[0]);

    expect(listPages).toHaveBeenCalledWith({ limit: 3 });
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.title)).toEqual([
      "Alpha plan",
      "Beta notes",
      "Gamma log",
    ]);
  });
});
