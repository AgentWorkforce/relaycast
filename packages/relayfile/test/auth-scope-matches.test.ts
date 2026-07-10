import { describe, expect, test } from "vitest";
import { hasAnyScope, scopeMatchesPath } from "../src/middleware/auth.js";
import type { TokenClaims } from "../src/middleware/auth.js";

// Coverage for the path-scoped grant ↔ bare capability matching that
// `authorizeBearer` + `hasAnyScope` perform via the internal
// `scopeMatches` helper. Pre-fix, the cloud-side `requireBearerScope`
// did a literal `Set.has(required)` lookup — relayauth-minted
// path-scoped tokens (`/v1/tokens/path` returns scopes like
// `relayfile:fs:read:/github/*`) NEVER satisfied a `fs:read`
// requirement, returning 403 `missing required scope: fs:read` on
// every relayfile-mount poll cycle. This was the secondary bug behind
// cloud#984's prefix-strip fix — invisible until the prefix bug was
// fixed and the JWT actually parsed.
//
// `hasAnyScope` is exported, so we exercise the underlying matcher
// through it rather than calling the private `scopeMatches` directly.

function claimsWith(scopes: string[]): TokenClaims {
  return {
    workspaceId: "ws_test",
    agentName: "agent_test",
    scopes: new Set(scopes),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("scope matching (via hasAnyScope)", () => {
  test("bare exact match wins (legacy behaviour preserved)", () => {
    const claims = claimsWith(["fs:read", "fs:write"]);
    expect(hasAnyScope(claims, "fs:read")).toBe(true);
    expect(hasAnyScope(claims, "fs:write")).toBe(true);
  });

  test("path-scoped grant satisfies bare capability (the production-blocking fix)", () => {
    // `relayauth:/v1/tokens/path` mints scopes shaped as
    // `relayfile:fs:read:/<persona-path>/*`. The endpoint
    // `requireBearerScope("fs:read")` should accept it.
    const claims = claimsWith([
      "relayfile:fs:read:/github/*",
      "relayfile:fs:write:/github/*",
    ]);
    expect(hasAnyScope(claims, "fs:read")).toBe(true);
    expect(hasAnyScope(claims, "fs:write")).toBe(true);
  });

  test("manage action satisfies both read and write requirements", () => {
    // Convention shared with the Go-side `scopeMatches`: a granted
    // `:manage` action implies both `:read` and `:write` on the
    // same resource.
    const claims = claimsWith(["relayfile:fs:manage:/github/*"]);
    expect(hasAnyScope(claims, "fs:read")).toBe(true);
    expect(hasAnyScope(claims, "fs:write")).toBe(true);
  });

  test("wildcard plane (`*`) and resource (`*`) match", () => {
    const claims = claimsWith(["*:fs:read:/anywhere/*"]);
    expect(hasAnyScope(claims, "fs:read")).toBe(true);

    const wildRes = claimsWith(["relayfile:*:read:/anywhere/*"]);
    expect(hasAnyScope(wildRes, "fs:read")).toBe(true);
  });

  test("wildcard action (`*`) matches any required action", () => {
    const claims = claimsWith(["relayfile:fs:*:/github/*"]);
    expect(hasAnyScope(claims, "fs:read")).toBe(true);
    expect(hasAnyScope(claims, "fs:write")).toBe(true);
  });

  test("rejects when required resource doesn't match grant", () => {
    // Granted `fs` resource doesn't satisfy a required `admin`
    // resource even if action matches.
    const claims = claimsWith(["relayfile:fs:read:/github/*"]);
    expect(hasAnyScope(claims, "admin:read")).toBe(false);
  });

  test("rejects when required action doesn't match grant", () => {
    // Granted `read` doesn't satisfy required `delete`.
    const claims = claimsWith(["relayfile:fs:read:/github/*"]);
    expect(hasAnyScope(claims, "fs:delete")).toBe(false);
  });

  test("rejects when plane is not `relayfile` or `*`", () => {
    // A scope claiming a different plane (e.g. an identity-token
    // scope) must not authorize relayfile fs operations.
    const claims = claimsWith(["identity:fs:read:/github/*"]);
    expect(hasAnyScope(claims, "fs:read")).toBe(false);
  });

  test("rejects malformed required scope (no colon)", () => {
    const claims = claimsWith(["relayfile:fs:read:/github/*"]);
    expect(hasAnyScope(claims, "noColonHere")).toBe(false);
  });

  test("rejects malformed granted scope (too few segments)", () => {
    // A grant like `read` (no plane / resource / action split) is
    // skipped during matching.
    const claims = claimsWith(["read"]);
    expect(hasAnyScope(claims, "fs:read")).toBe(false);
  });

  test("multi-scope: any matching grant is sufficient", () => {
    // hasAnyScope returns true if ANY of the required scopes
    // matches; we still want path-scoped grants to participate.
    const claims = claimsWith(["relayfile:fs:read:/github/*"]);
    expect(hasAnyScope(claims, "fs:delete", "fs:read")).toBe(true);
  });
});

describe("path-aware filesystem scope matching", () => {
  test("workspace mount grant constrains bare read to the granted subtree", () => {
    const claims = claimsWith([
      "fs:read",
      "workspace:mount-sponsor:read:/slack/messages/**",
    ]);

    expect(scopeMatchesPath(claims, "fs:read", "/slack/messages/1.json")).toBe(
      true,
    );
    expect(scopeMatchesPath(claims, "fs:read", "/slack/threads/1.json")).toBe(
      false,
    );
    expect(scopeMatchesPath(claims, "fs:read", "")).toBe(false);
  });

  test("GitHub repo metadata grants match owner/repo segments without exposing contents", () => {
    const claims = claimsWith([
      "relayfile:fs:read:/github/repos/*/*/issues/**",
      "relayfile:fs:read:/github/repos/*/*/pulls/**",
      "relayfile:fs:read:/github/repos/*/*/checks/**",
    ]);

    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/github/repos/acme/cloud/issues/1.json",
      ),
    ).toBe(true);
    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/github/repos/acme/cloud/pulls/2.json",
      ),
    ).toBe(true);
    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/github/repos/acme/cloud/checks/main.json",
      ),
    ).toBe(true);
    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/github/repos/acme/cloud/contents/issues/1.json",
      ),
    ).toBe(false);
    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/github/repos/acme/cloud/branches/main.json",
      ),
    ).toBe(false);
    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/github/repos/acme/issues/1.json",
      ),
    ).toBe(false);
  });

  test("workspace sponsor segment is not treated as the filesystem resource", () => {
    const claims = claimsWith([
      "workspace:pear-integrations-slack-channels-c123-messages:read:/slack/channels/c123/messages/**",
    ]);

    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/slack/channels/c123/messages/1780847052.json",
      ),
    ).toBe(true);
  });

  test("Slack raw channel ids match same-channel mounted alias grants", () => {
    const claims = claimsWith([
      "fs:read",
      "workspace:pear-integrations-slack-channels-C0B8ZL2L9GC__pear-pty-investigation-messages:read:/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/messages/**",
    ]);

    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/slack/channels/C0B8ZL2L9GC/messages/1780847052.json",
      ),
    ).toBe(true);
    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/slack/channels/C0B8ZL2L9GC/threads/1780847052.json",
      ),
    ).toBe(false);
    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/slack/channels/COTHER/messages/1780847052.json",
      ),
    ).toBe(false);
  });

  test("Slack DM user-message grants authorize only the selected user path", () => {
    const claims = claimsWith([
      "fs:read",
      "fs:write",
      "workspace:pear-integrations-slack-users-U123-messages:read:/slack/users/U123/messages/**",
      "workspace:pear-integrations-slack-users-U123-messages:write:/slack/users/U123/messages/**",
    ]);

    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/slack/users/U123/messages/1780893132_131989/meta.json",
      ),
    ).toBe(true);
    expect(
      scopeMatchesPath(
        claims,
        "fs:write",
        "/slack/users/U123/messages/create.json",
      ),
    ).toBe(true);
    expect(
      scopeMatchesPath(
        claims,
        "fs:read",
        "/slack/users/U999/messages/1780893132_131989/meta.json",
      ),
    ).toBe(false);
    expect(
      scopeMatchesPath(
        claims,
        "fs:write",
        "/slack/channels/D123/messages/create.json",
      ),
    ).toBe(false);
  });

  test("pure bare read remains full workspace access", () => {
    const claims = claimsWith(["fs:read"]);

    expect(scopeMatchesPath(claims, "fs:read", "/anywhere/file.json")).toBe(
      true,
    );
    expect(scopeMatchesPath(claims, "fs:read", "")).toBe(true);
  });

  test("workspace mount grant constrains bare write to the granted subtree", () => {
    const claims = claimsWith([
      "fs:write",
      "workspace:mount-sponsor:write:/slack/messages/**",
    ]);

    expect(scopeMatchesPath(claims, "fs:write", "/slack/messages/1.json")).toBe(
      true,
    );
    expect(scopeMatchesPath(claims, "fs:write", "/slack/threads/1.json")).toBe(
      false,
    );
  });
});
