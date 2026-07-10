import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dynamicSlugName,
  findSlugConflicts,
} from "../scripts/check-route-slug-conflicts.mjs";

function makeTree(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slug-guard-"));
  for (const rel of dirs) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  }
  return root;
}

function withTree(dirs, fn) {
  const root = makeTree(dirs);
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("dynamicSlugName parses dynamic variants, ignores groups/slots/static", () => {
  assert.equal(dynamicSlugName("[agentId]"), "agentId");
  assert.equal(dynamicSlugName("[...slug]"), "slug");
  assert.equal(dynamicSlugName("[[...slug]]"), "slug");
  assert.equal(dynamicSlugName("(group)"), null);
  assert.equal(dynamicSlugName("@modal"), null);
  assert.equal(dynamicSlugName("team"), null);
});

test("flags differently-named dynamic siblings at one position (the #1688 conflict)", () => {
  withTree(
    ["api/v1/agents/[agentId]/deploy", "api/v1/agents/[parentAgentId]/team"],
    (root) => {
      const { conflicts } = findSlugConflicts(root);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].parent, "api/v1/agents");
      assert.deepEqual(conflicts[0].segments, ["[agentId]", "[parentAgentId]"]);
    },
  );
});

test("flags a catch-all vs dynamic of the SAME name at one position ([id] vs [...id])", () => {
  withTree(["api/x/[id]/page", "api/x/[...id]/page"], (root) => {
    const { conflicts } = findSlugConflicts(root);
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0].segments, ["[...id]", "[id]"]);
  });
});

test("treats route groups as URL-transparent — a conflict can span two groups", () => {
  withTree(["app/(marketing)/[slug]", "app/(shop)/[id]"], (root) => {
    const { conflicts } = findSlugConflicts(root);
    assert.equal(conflicts.length, 1, "[slug] and [id] collapse to the same URL position");
    assert.deepEqual(conflicts[0].segments, ["[id]", "[slug]"]);
  });
});

test("does NOT false-positive on route groups with non-dynamic children", () => {
  withTree(["app/(marketing)/about", "app/(shop)/cart"], (root) => {
    const { conflicts } = findSlugConflicts(root);
    assert.equal(conflicts.length, 0);
  });
});

test("passes a clean tree with one dynamic segment per position", () => {
  withTree(
    [
      "api/v1/agents/[agentId]/deploy",
      "api/v1/agents/[agentId]/team",
      "api/v1/workspaces/[workspaceId]/teams/[teamId]",
      "api/v1/workflows/runs/[runId]/storage/[...objectKey]",
    ],
    (root) => {
      const { conflicts, positionsScanned } = findSlugConflicts(root);
      assert.equal(conflicts.length, 0);
      assert.ok(positionsScanned >= 4);
    },
  );
});

test("allows the same slug name reused at DIFFERENT positions", () => {
  withTree(["api/users/[id]", "api/posts/[id]"], (root) => {
    const { conflicts } = findSlugConflicts(root);
    assert.equal(conflicts.length, 0);
  });
});
