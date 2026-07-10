import { describe, expect, it } from "vitest";

import {
  WORKSPACE_ID_PATTERN,
  looksLikeWorkspaceId,
} from "../packages/web/lib/integrations/workspace-identifiers";

const VALID_UUID_LOWER = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_UPPER = "11111111-1111-4111-8111-111111111111".toUpperCase();
const VALID_RW = "rw_517d60b6";

// Reviewer-flagged drift case (CodeRabbit on PR #488): a single combined
// regex with the `/i` flag would silently case-fold the entire pattern,
// including `rw_` and the relay hex suffix, and accept this string. The
// helper used to disagree with the schema regex about it. Both must
// reject it now.
const UPPERCASE_RW = "RW_517D60B6";

describe("WORKSPACE_ID_PATTERN / looksLikeWorkspaceId", () => {
  it("accepts a lowercase UUID", () => {
    expect(WORKSPACE_ID_PATTERN.test(VALID_UUID_LOWER)).toBe(true);
    expect(looksLikeWorkspaceId(VALID_UUID_LOWER)).toBe(true);
  });

  it("accepts an uppercase UUID (Windows-GUID-style callers)", () => {
    expect(WORKSPACE_ID_PATTERN.test(VALID_UUID_UPPER)).toBe(true);
    expect(looksLikeWorkspaceId(VALID_UUID_UPPER)).toBe(true);
  });

  it("accepts a productized rw_<8hex> workspace id", () => {
    expect(WORKSPACE_ID_PATTERN.test(VALID_RW)).toBe(true);
    expect(looksLikeWorkspaceId(VALID_RW)).toBe(true);
  });

  it("rejects an uppercase rw_ prefix (matches core's strict-lowercase contract)", () => {
    // `core/src/workspace/id.ts:generateWorkspaceId` emits lowercase hex
    // and `isValidWorkspaceId` is strict-lowercase, so RW_* cannot be a
    // real id and must not pass here either.
    expect(WORKSPACE_ID_PATTERN.test(UPPERCASE_RW)).toBe(false);
    expect(looksLikeWorkspaceId(UPPERCASE_RW)).toBe(false);
  });

  it("rejects rw_ ids with non-hex suffixes", () => {
    expect(looksLikeWorkspaceId("rw_zzzzzzzz")).toBe(false);
    expect(looksLikeWorkspaceId("rw_517d60bg")).toBe(false);
  });

  it("rejects garbage strings", () => {
    expect(looksLikeWorkspaceId("not-a-workspace-id")).toBe(false);
    expect(looksLikeWorkspaceId("")).toBe(false);
  });

  it("trims whitespace before checking", () => {
    expect(looksLikeWorkspaceId(`  ${VALID_RW}  `)).toBe(true);
  });

  it("schema regex and helper agree on every case", () => {
    // Belt-and-suspenders: the whole point of collapsing to one regex
    // was so these two views can never disagree again.
    const samples = [
      VALID_UUID_LOWER,
      VALID_UUID_UPPER,
      VALID_RW,
      UPPERCASE_RW,
      "rw_zzzzzzzz",
      "not-an-id",
      "",
    ];
    for (const sample of samples) {
      const helperAccepts = looksLikeWorkspaceId(sample);
      const schemaAccepts = WORKSPACE_ID_PATTERN.test(sample.trim());
      expect(helperAccepts).toBe(schemaAccepts);
    }
  });
});
