import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LINEAR_LAYOUT_MD, buildLinearConventionFragment } from "../src/conventions.js";
import packageJson from "../package.json" with { type: "json" };

describe("buildLinearConventionFragment", () => {
  it("declares provider 'linear'", () => {
    assert.equal(buildLinearConventionFragment().provider, "linear");
  });

  it("emits at least the four baseline path patterns", () => {
    const fragment = buildLinearConventionFragment();
    const patterns = fragment.paths.map((p) => p.pattern);

    for (const pattern of [
      "/linear/issues/{id}.json",
      "/linear/issues/{slug}__{id}.json",
      "/linear/issues/by-title/{slug}.json",
      "/linear/issues/by-id/{id}.json",
      "/linear/comments/{id}.json",
      "/linear/comments/{slug}__{id}.json",
      "/linear/projects/{id}.json",
      "/linear/cycles/{id}.json",
      "/linear/teams/by-name/{slug}.json",
    ]) {
      assert.ok(patterns.includes(pattern), `expected ${pattern} in convention paths`);
    }
    assert.ok(patterns.length >= 4);
  });

  it("tags each path with an object type", () => {
    const fragment = buildLinearConventionFragment();
    for (const path of fragment.paths) {
      assert.ok(path.objectType);
      assert.ok(path.description.trim().length > 0);
    }
  });

  it("pulls the adapter version dynamically from the cataloging package's declared dependency", () => {
    const fragment = buildLinearConventionFragment();
    const declared = packageJson.dependencies["@relayfile/adapter-linear"];
    const expected = declared.replace(/^[\^~>=<]+/, "").trim();
    assert.equal(fragment.version, expected);
    assert.match(fragment.version, /^\d+\.\d+\.\d+/);
  });

  it("includes the 'open issues for an assignee' typical query", () => {
    const fragment = buildLinearConventionFragment();
    const query = fragment.typicalQueries?.find((q) =>
      q.intent.toLowerCase().includes("open issues"),
    );
    assert.ok(query);
    const joined = query?.steps.join("\n") ?? "";
    assert.match(joined, /workspace_list/);
    assert.match(joined, /workspace_read_json/);
    assert.match(joined, /\/linear\/issues/);
    assert.match(joined, /<slug>__<id>/);
  });

  it("includes find-by-id and slug-prefixed lookup queries", () => {
    const fragment = buildLinearConventionFragment();
    const byId = fragment.typicalQueries?.find((q) =>
      q.intent.toLowerCase().includes("find issue by id"),
    );
    const bySlug = fragment.typicalQueries?.find((q) =>
      q.intent.toLowerCase().includes("slug-prefixed"),
    );

    assert.ok(byId);
    assert.ok(bySlug);
    assert.match(byId.steps.join("\n"), /\/linear\/issues\/<id>\.json/);
    assert.match(byId.steps.join("\n"), /__<id>\.json/);
    const slugSteps = bySlug.steps.join("\n");
    assert.match(slugSteps, /\/linear\/issues\/<slug>__<id>\.json/);
    assert.match(slugSteps, /255 bytes/);
    assert.doesNotMatch(slugSteps, /80 chars/);
  });

  it("includes a find-by-title query that references the title and id alias trees", () => {
    const fragment = buildLinearConventionFragment();
    const query = fragment.typicalQueries?.find((q) =>
      q.intent.toLowerCase().includes("find issue by title"),
    );
    assert.ok(query);
    const joined = query?.steps.join("\n") ?? "";
    assert.match(joined, /\/linear\/issues\/by-title/);
    assert.match(joined, /\/linear\/issues\/by-id/);
    assert.match(joined, /workspace_read_json/);
  });

  it("includes by-state issue and project paths with a literal {state} placeholder", () => {
    const fragment = buildLinearConventionFragment();
    const patterns = fragment.paths.map((p) => p.pattern);

    assert.ok(patterns.includes("/linear/issues/by-state/{state}/{id}.json"));
    assert.ok(patterns.includes("/linear/projects/by-state/{state}/{id}.json"));
    assert.ok(patterns.every((pattern) => !pattern.includes("%7Bstate%7D")));
  });

  it("includes a state-scoped listing query that points at the by-state subtree", () => {
    const fragment = buildLinearConventionFragment();
    const query = fragment.typicalQueries?.find((q) =>
      q.intent.toLowerCase().includes("given state"),
    );
    assert.ok(query);
    const joined = query?.steps.join("\n") ?? "";
    assert.match(joined, /\/linear\/issues\/by-state\/<state>/);
    assert.match(joined, /workspace_list/);
  });

  it("documents bare-id and slug-prefixed canonical file forms in LAYOUT.md", () => {
    assert.match(LINEAR_LAYOUT_MD, /<id>\.json/);
    assert.match(LINEAR_LAYOUT_MD, /<slug>__<id>\.json/);
    assert.match(LINEAR_LAYOUT_MD, /Issue and comment files/);
  });
});
