import { describe, expect, it } from "vitest";

import { parseArgs } from "../../scripts/audit-workspace-integration-rows.js";

describe("workspace integration row audit script", () => {
  it("defaults to a full read-only scan", () => {
    expect(parseArgs([])).toEqual({ mismatchedOnly: false });
  });

  it("parses scoped options", () => {
    expect(parseArgs([
      "--workspace-id",
      "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      "--provider",
      "linear",
      "--limit",
      "25",
      "--mismatched-only",
    ])).toEqual({
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      provider: "linear",
      limit: 25,
      mismatchedOnly: true,
    });
  });

  it("returns help for --help and rejects bad input", () => {
    expect(parseArgs(["--help"])).toBe("help");
    expect(() => parseArgs(["--apply"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--limit", "-3"])).toThrow(/positive integer/);
  });
});
