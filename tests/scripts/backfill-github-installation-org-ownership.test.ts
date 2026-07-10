import { describe, expect, it } from "vitest";

import { parseArgs } from "../../scripts/backfill-github-installation-org-ownership.js";

describe("github installation org ownership backfill script", () => {
  it("defaults to dry-run mode", () => {
    expect(parseArgs([])).toEqual({ dryRun: true });
  });

  it("parses scoped apply options", () => {
    expect(parseArgs([
      "--apply",
      "--workspace-id",
      "rw_7ca2b192",
      "--limit",
      "10",
    ])).toEqual({
      dryRun: false,
      workspaceId: "rw_7ca2b192",
      limit: 10,
    });
  });

  it("parses divergence reporting as dry-run mode", () => {
    expect(parseArgs(["--report-divergence"])).toEqual({
      dryRun: true,
      reportDivergence: true,
    });
  });

  it("rejects divergence reporting when apply was also requested", () => {
    expect(() => parseArgs(["--apply", "--report-divergence"])).toThrow(
      /cannot be combined/,
    );
    expect(() => parseArgs(["--apply", "--dry-run", "--report-divergence"])).toThrow(
      /cannot be combined/,
    );
    expect(() => parseArgs(["--report-divergence", "--apply"])).toThrow(
      /cannot be combined/,
    );
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
