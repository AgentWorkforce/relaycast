import { describe, expect, it } from "vitest";
import {
  scopePathMatchesPath,
  scopeRuleMatches,
} from "../src/durable-objects/handlers/fs.js";
import type { TokenClaims } from "../src/middleware/auth.js";

function claimsWith(scopes: string[]): TokenClaims {
  return {
    workspaceId: "ws_test",
    agentName: "agent_test",
    scopes: new Set(scopes),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("relayfile permission scope matching", () => {
  it("matches recursive and suffix glob patterns used by workspace ACLs", () => {
    expect(scopePathMatchesPath("/.env.*", "/.env.local")).toBe(true);
    expect(scopePathMatchesPath("/.env.*", "/README.md")).toBe(false);

    expect(scopePathMatchesPath("/**/*.pem", "/id.pem")).toBe(true);
    expect(scopePathMatchesPath("/**/*.pem", "/secrets/id.pem")).toBe(true);
    expect(scopePathMatchesPath("/**/*.pem", "/secrets/id.key")).toBe(false);

    expect(scopePathMatchesPath("/**/credentials*", "/credentials.json")).toBe(
      true,
    );
    expect(
      scopePathMatchesPath("/**/credentials*", "/config/credentials.backup"),
    ).toBe(true);
    expect(
      scopePathMatchesPath("/**/credentials*", "/config/secrets.json"),
    ).toBe(false);
  });

  it("preserves recursive directory-style matching for prefix scopes", () => {
    expect(scopePathMatchesPath("/docs/*", "/docs/readme.md")).toBe(true);
    expect(scopePathMatchesPath("/docs/*", "/docs/guides/setup.md")).toBe(true);
    expect(scopePathMatchesPath("/docs/*", "/src/index.ts")).toBe(false);
  });

  it("allows a broader relayfile token scope to satisfy a narrower ACL path rule", () => {
    const claims = claimsWith(["relayfile:fs:write:/github/*"]);

    expect(
      scopeRuleMatches(
        "relayfile:fs:write:/github/_agents/cloud-small-issue-codex/dispatch-claims/**",
        claims,
        "write",
        "/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1315.json",
      ),
    ).toBe(true);
  });

  it("allows a bare fs write token scope to satisfy a narrower ACL path rule", () => {
    const claims = claimsWith(["fs:write"]);

    expect(
      scopeRuleMatches(
        "relayfile:fs:write:/github/_agents/cloud-small-issue-codex/dispatch-claims/**",
        claims,
        "write",
        "/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1315.json",
      ),
    ).toBe(true);
  });

  it("allows a path-scoped relayfile token scope to satisfy a bare ACL fs write rule", () => {
    const claims = claimsWith(["relayfile:fs:write:/github/*"]);

    expect(
      scopeRuleMatches(
        "fs:write",
        claims,
        "write",
        "/github/repos/AgentWorkforce/cloud/issues/1381/comments/create comment 684998df.json",
      ),
    ).toBe(true);
  });

  it("allows a path-scoped relayfile token scope to satisfy a bare ACL fs read rule", () => {
    const claims = claimsWith(["relayfile:fs:read:/github/*"]);

    expect(
      scopeRuleMatches(
        "fs:read",
        claims,
        "read",
        "/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1381.json",
      ),
    ).toBe(true);
  });

  it("does not allow a path-scoped relayfile token scope outside a bare ACL fs write rule's requested path", () => {
    const claims = claimsWith(["relayfile:fs:write:/slack/*"]);

    expect(
      scopeRuleMatches(
        "fs:write",
        claims,
        "write",
        "/github/repos/AgentWorkforce/cloud/issues/1381/comments/create comment 684998df.json",
      ),
    ).toBe(false);
  });

  it("allows pr-reviewer provider-root tokens through managed root ACL write rules", () => {
    const claims = claimsWith([
      "relayfile:fs:write:/github/*",
      "relayfile:fs:write:/slack/*",
    ]);

    for (const path of [
      // Dispatch claim writes.
      "/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1381.json",
      // GitHub issue and PR comment writebacks.
      "/github/repos/AgentWorkforce/cloud/issues/1381/comments/create comment 684998df.json",
      "/github/repos/AgentWorkforce/cloud/pulls/1381/comments/create comment 684998df.json",
      // ctx.sandbox.cwd repo materialization push-back.
      "/github/repos/AgentWorkforce/cloud/contents/packages/web/app/page.tsx",
      // ctx.github.mergePullRequest.
      "/github/repos/AgentWorkforce/cloud/pulls/123/merge.json",
      // ctx.slack.post.
      "/slack/channels/proj-cloud/messages/create message 684998df.json",
    ]) {
      expect(scopeRuleMatches("fs:write", claims, "write", path)).toBe(true);
    }
  });

  it("allows manage token scopes to satisfy read and write ACL path rules", () => {
    const claims = claimsWith(["relayfile:fs:manage:/github/*"]);

    expect(
      scopeRuleMatches(
        "relayfile:fs:read:/github/_agents/cloud-small-issue-codex/dispatch-claims/**",
        claims,
        "read",
        "/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1315.json",
      ),
    ).toBe(true);
    expect(
      scopeRuleMatches(
        "relayfile:fs:write:/github/_agents/cloud-small-issue-codex/dispatch-claims/**",
        claims,
        "write",
        "/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1315.json",
      ),
    ).toBe(true);
  });

  it("does not allow a relayfile token scope outside the requested ACL path", () => {
    const claims = claimsWith(["relayfile:fs:write:/slack/*"]);

    expect(
      scopeRuleMatches(
        "relayfile:fs:write:/github/_agents/cloud-small-issue-codex/dispatch-claims/**",
        claims,
        "write",
        "/github/_agents/cloud-small-issue-codex/dispatch-claims/issues/AgentWorkforce__cloud__1315.json",
      ),
    ).toBe(false);
  });
});
