import { describe, expect, it } from "vitest";

import { parseArgs } from "../../scripts/backfill-provider-credential-account-email.js";

describe("provider credential account_email backfill script", () => {
  it("defaults to dry-run mode", () => {
    expect(parseArgs([])).toEqual({ dryRun: true });
  });

  it("parses scoped apply options", () => {
    expect(parseArgs([
      "--apply",
      "--workspace-id",
      "workspace-1",
      "--user-id",
      "user-1",
      "--provider",
      "claude",
      "--auth-type",
      "oauth_token",
      "--limit",
      "25",
    ])).toEqual({
      dryRun: false,
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "claude",
      authType: "oauth_token",
      limit: 25,
    });
  });

  it("rejects non-integer limits without truncating", () => {
    expect(() => parseArgs(["--limit", "10abc"])).toThrow(
      "--limit must be a positive integer",
    );
  });

  it("rejects conflicting apply and dry-run flags", () => {
    expect(() => parseArgs(["--apply", "--dry-run"])).toThrow(
      "--apply and --dry-run are mutually exclusive",
    );
  });
});
