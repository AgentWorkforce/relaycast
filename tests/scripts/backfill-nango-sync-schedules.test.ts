import { describe, expect, it } from "vitest";

import { parseArgs } from "../../scripts/backfill-nango-sync-schedules.js";

describe("nango sync schedule backfill script", () => {
  it("defaults to dry-run mode", () => {
    expect(parseArgs([])).toEqual({ dryRun: true });
  });

  it("parses scoped apply options", () => {
    expect(parseArgs([
      "--apply",
      "--workspace-id",
      "rw_7ca2b192",
      "--provider",
      "slack",
      "--limit",
      "10",
    ])).toEqual({
      dryRun: false,
      workspaceId: "rw_7ca2b192",
      provider: "slack",
      limit: 10,
    });
  });

  it("returns help for --help", () => {
    expect(parseArgs(["--help"])).toBe("help");
  });

  it("rejects unknown arguments and bad limits", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--limit", "zero"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--workspace-id"])).toThrow(/requires a value/);
  });
});
