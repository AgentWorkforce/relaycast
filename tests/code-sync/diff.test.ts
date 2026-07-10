import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileManifest } from "../../packages/core/src/code-sync/types.js";
import { diffManifests } from "../../packages/core/src/code-sync/diff.js";
import { makeManifest } from "./helpers.js";

describe("diffManifests", () => {
  it("detects new files", () => {
    const local = makeManifest([["new.txt", "abc"]]);
    const remote: FileManifest = new Map();

    const plan = diffManifests(local, remote);
    assert.deepEqual(plan.added, ["new.txt"]);
    assert.equal(plan.stats.toUpload, 1);
  });

  it("detects modified files", () => {
    const local = makeManifest([["a.txt", "hash-new"]]);
    const remote = makeManifest([["a.txt", "hash-old"]]);

    const plan = diffManifests(local, remote);
    assert.deepEqual(plan.modified, ["a.txt"]);
    assert.equal(plan.stats.toUpload, 1);
  });

  it("detects deleted files", () => {
    const local: FileManifest = new Map();
    const remote = makeManifest([["old.txt", "abc"]]);

    const plan = diffManifests(local, remote);
    assert.deepEqual(plan.deleted, ["old.txt"]);
    assert.equal(plan.stats.toDelete, 1);
  });

  it("detects unchanged files", () => {
    const local = makeManifest([["same.txt", "abc"]]);
    const remote = makeManifest([["same.txt", "abc"]]);

    const plan = diffManifests(local, remote);
    assert.deepEqual(plan.unchanged, ["same.txt"]);
    assert.equal(plan.stats.unchanged, 1);
    assert.equal(plan.stats.toUpload, 0);
  });

  it("handles mixed scenario", () => {
    const local = makeManifest([
      ["new.txt", "n"],
      ["modified.txt", "m2"],
      ["same.txt", "s"],
    ]);
    const remote = makeManifest([
      ["modified.txt", "m1"],
      ["same.txt", "s"],
      ["deleted.txt", "d"],
    ]);

    const plan = diffManifests(local, remote);
    assert.deepEqual(plan.added, ["new.txt"]);
    assert.deepEqual(plan.modified, ["modified.txt"]);
    assert.deepEqual(plan.deleted, ["deleted.txt"]);
    assert.deepEqual(plan.unchanged, ["same.txt"]);
    assert.equal(plan.stats.toUpload, 2);
    assert.equal(plan.stats.toDelete, 1);
  });

  it("both empty returns empty plan", () => {
    const plan = diffManifests(new Map(), new Map());
    assert.equal(plan.added.length, 0);
    assert.equal(plan.modified.length, 0);
    assert.equal(plan.deleted.length, 0);
    assert.equal(plan.unchanged.length, 0);
  });

  it("first sync (empty remote) marks all as added", () => {
    const local = makeManifest([
      ["a.txt", "a"],
      ["b.txt", "b"],
      ["c.txt", "c"],
    ]);
    const remote: FileManifest = new Map();

    const plan = diffManifests(local, remote);
    assert.equal(plan.added.length, 3);
    assert.equal(plan.stats.toUpload, 3);
    assert.equal(plan.deleted.length, 0);
  });
});
