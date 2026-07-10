import { describe, expect, it } from "vitest";
import { compileJoinAccess } from "../packages/web/lib/relay-workspaces.ts";

const NO_PERMISSIONS = { ignored: [], readonly: [] };

describe("compileJoinAccess token scopes", () => {
  // The writeback-reliability spec (#448 phase 3) requires every
  // wizard-issued workspace JWT to carry ops:read and sync:trigger so
  // agents can introspect the writeback pipeline through documented
  // CLI surfaces (`relayfile pull`, `relayfile ops list`,
  // GET /v1/workspaces/{id}/ops/{opId}). Without these, a failed
  // writeback is invisible to the user.
  it("includes ops:read and sync:trigger when the agent has read access", () => {
    const compiled = compileJoinAccess(
      "relayfile-cli",
      ["relayfile:fs:read:*"],
      NO_PERMISSIONS,
    );

    expect(compiled.tokenScopes).toContain("ops:read");
    expect(compiled.tokenScopes).toContain("sync:trigger");
    expect(compiled.tokenScopes).toContain("fs:read");
    expect(compiled.tokenScopes).toContain("sync:read");
  });

  it("includes ops:read and sync:trigger when the agent has write access", () => {
    const compiled = compileJoinAccess(
      "relayfile-cli",
      ["relayfile:fs:write:*"],
      NO_PERMISSIONS,
    );

    expect(compiled.tokenScopes).toContain("ops:read");
    expect(compiled.tokenScopes).toContain("sync:trigger");
    expect(compiled.tokenScopes).toContain("fs:write");
  });

  it("includes both introspection scopes for the default read+write agent", () => {
    const compiled = compileJoinAccess(
      "relayfile-cli",
      ["relayfile:fs:read:*", "relayfile:fs:write:*"],
      NO_PERMISSIONS,
    );

    expect(compiled.tokenScopes).toEqual(
      expect.arrayContaining([
        "fs:read",
        "fs:write",
        "sync:read",
        "sync:trigger",
        "ops:read",
      ]),
    );
  });

  it("does NOT add introspection scopes when the agent ends up fully denied", () => {
    // When every requested scope is overridden by an `ignored` pattern,
    // effectiveScopes is empty and the token gets only the
    // `__denied__` ACL placeholder. Granting ops:read here would let a
    // denied agent still poll the ops log — wider than intended.
    const compiled = compileJoinAccess(
      "relayfile-cli",
      ["relayfile:fs:read:/secret"],
      { ignored: ["/secret"], readonly: [] },
    );

    expect(compiled.tokenScopes).not.toContain("ops:read");
    expect(compiled.tokenScopes).not.toContain("sync:trigger");
  });

  it("emits readonly override deny rules in relayfile scope form", () => {
    const compiled = compileJoinAccess(
      "relayfile-cli",
      ["relayfile:fs:read:*", "relayfile:fs:write:*"],
      { ignored: [], readonly: ["/protected/**"] },
    );

    expect(compiled.hasDenyOverrides).toBe(true);
    expect(compiled.aclPermissions).toContain(
      "deny:scope:relayfile:fs:write:/protected/*",
    );
    expect(compiled.tokenScopes).not.toContain("relayfile:fs:write:/protected/*");
    expect(JSON.stringify(compiled.aclPermissions)).not.toContain(
      "deny:scope:workspace:",
    );
  });

  it("treats requested root wildcard scopes as covering nested readonly paths", () => {
    const compiled = compileJoinAccess(
      "relayfile-cli",
      ["relayfile:fs:read:/**", "relayfile:fs:write:/**"],
      { ignored: [], readonly: ["/protected/**"] },
    );

    expect(compiled.publicScopes).toEqual([
      "relayfile:fs:read:/**",
      "relayfile:fs:write:/**",
    ]);
    expect(compiled.aclPermissions).toContain(
      "deny:scope:relayfile:fs:write:/protected/*",
    );
  });
});
