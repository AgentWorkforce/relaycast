import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildGitHubConventionFragment } from "../src/conventions.js";
import packageJson from "../package.json" with { type: "json" };

describe("buildGitHubConventionFragment", () => {
  it("declares provider 'github'", () => {
    assert.equal(buildGitHubConventionFragment().provider, "github");
  });

  it("emits the four baseline path patterns", () => {
    const fragment = buildGitHubConventionFragment();
    const patterns = fragment.paths.map((p) => p.pattern);

    for (const pattern of [
      "/github/repos/{owner}/{repo}/metadata.json",
      "/github/repos/by-name/{owner}__{repo}/metadata.json",
      "/github/repos/{owner}/{repo}/pulls/{n}/metadata.json",
      "/github/repos/{owner}/{repo}/pulls/by-title/{slug}.json",
      "/github/repos/{owner}/{repo}/pulls/by-id/{n}.json",
      "/github/repos/{owner}/{repo}/pulls/by-state/{state}/{n}.json",
      "/github/repos/{owner}/{repo}/issues/{n}/metadata.json",
      "/github/repos/{owner}/{repo}/issues/by-state/{state}/{n}.json",
      "/github/repos/{owner}/{repo}/commits/{sha}/metadata.json",
    ]) {
      assert.ok(patterns.includes(pattern), `expected ${pattern} in convention paths`);
    }
    assert.ok(patterns.length >= 4);
  });

  it("tags each path with an object type", () => {
    const fragment = buildGitHubConventionFragment();
    for (const path of fragment.paths) {
      assert.ok(path.objectType);
      assert.ok(path.description.trim().length > 0);
    }
  });

  it("pulls the adapter version dynamically from the cataloging package's declared dependency", () => {
    const fragment = buildGitHubConventionFragment();
    const declared = packageJson.dependencies["@relayfile/adapter-github"];
    const expected = declared.replace(/^[\^~>=<]+/, "").trim();
    assert.equal(fragment.version, expected);
    assert.match(fragment.version, /^\d+\.\d+\.\d+/);
  });

  it("includes the 'list open PRs' typical query with workspace_list + workspace_read_json steps", () => {
    const fragment = buildGitHubConventionFragment();
    const query = fragment.typicalQueries?.find((q) =>
      q.intent.toLowerCase().includes("open prs"),
    );
    assert.ok(query);
    const joined = query?.steps.join("\n") ?? "";
    assert.match(joined, /workspace_list/);
    assert.match(joined, /workspace_read_json/);
    assert.match(joined, /\/github\/repos\/\{owner\}\/\{repo\}\/pulls\/by-state\/open/);
    assert.match(joined.toLowerCase(), /state/);
  });

  it("includes a find-PR-by-title query that references the title and id alias trees", () => {
    const fragment = buildGitHubConventionFragment();
    const query = fragment.typicalQueries?.find((q) =>
      q.intent.toLowerCase().includes("find pr by title"),
    );
    assert.ok(query);
    const joined = query?.steps.join("\n") ?? "";
    assert.match(joined, /\/github\/repos\/\{owner\}\/\{repo\}\/pulls\/by-title/);
    assert.match(joined, /\/github\/repos\/\{owner\}\/\{repo\}\/pulls\/by-id/);
    assert.match(joined, /workspace_read_json/);
  });

  it("sets generatedAt to a fresh ISO timestamp on each call", () => {
    const a = buildGitHubConventionFragment().generatedAt;
    const b = new Date().toISOString();
    // Both should be valid ISO timestamps and within ~1s of each other.
    assert.ok(!Number.isNaN(Date.parse(a)));
    assert.ok(Math.abs(Date.parse(b) - Date.parse(a)) < 2000);
  });

  it("keeps literal by-state placeholders readable and does not re-export removed materializeRepo helper", () => {
    const fragment = buildGitHubConventionFragment();
    const patterns = fragment.paths.map((path) => path.pattern);
    const entrypoint = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

    assert.ok(patterns.every((pattern) => !pattern.includes("%7Bstate%7D")));
    assert.match(entrypoint, /export \{ BY_STATE_SEGMENT \};/);
    // materializeRepo was a third-party-API rule violation (see
    // .claude/rules/cataloging-agent-no-third-party-apis.md); ensure the
    // removed import/export stays gone.
    assert.doesNotMatch(entrypoint, /materializeRepo/);
    assert.doesNotMatch(entrypoint, /from "\.\/materialize\.js"/);
  });
});
