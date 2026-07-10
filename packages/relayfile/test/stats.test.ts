import { describe, expect, it } from "vitest";
import { touchWorkspaceActivity } from "../src/durable-objects/stats.js";

describe("relayfile workspace activity", () => {
  it("updates last_activity and updated_at together on touch", async () => {
    const calls: Array<{ query: string; bindings: unknown[] }> = [];
    const touchedAt = "2026-04-11T09:00:00.000Z";

    await touchWorkspaceActivity(
      {
        async d1Run(query: string, ...bindings: unknown[]) {
          calls.push({ query, bindings });
        },
      },
      "ws_123",
      touchedAt,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("last_activity = excluded.last_activity");
    expect(calls[0]?.query).toContain("updated_at = excluded.updated_at");
    expect(calls[0]?.bindings).toEqual([
      "ws_123",
      touchedAt,
      touchedAt,
      touchedAt,
    ]);
  });
});
