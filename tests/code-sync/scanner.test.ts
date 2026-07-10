import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { scanDirectory } from "../../packages/core/src/code-sync/scanner.js";
import { tmpDir, writeFileAt } from "./helpers.js";

describe("scanDirectory", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scans a flat directory", async () => {
    await writeFileAt(root, "a.txt", "aaa");
    await writeFileAt(root, "b.txt", "bbb");

    const result = await scanDirectory(root);
    assert.deepEqual(result.files, ["a.txt", "b.txt"]);
  });

  it("scans nested directories", async () => {
    await writeFileAt(root, "src/index.ts", "code");
    await writeFileAt(root, "src/lib/utils.ts", "utils");
    await writeFileAt(root, "README.md", "readme");

    const result = await scanDirectory(root);
    assert.deepEqual(result.files, ["README.md", "src/index.ts", "src/lib/utils.ts"]);
  });

  it("excludes .git directory", async () => {
    await writeFileAt(root, "a.txt", "aaa");
    await writeFileAt(root, ".git/config", "git config");
    await writeFileAt(root, ".git/objects/abc", "obj");

    const result = await scanDirectory(root);
    assert.deepEqual(result.files, ["a.txt"]);
  });

  it("excludes node_modules directory", async () => {
    await writeFileAt(root, "index.js", "code");
    await writeFileAt(root, "node_modules/foo/index.js", "dep");

    const result = await scanDirectory(root);
    assert.deepEqual(result.files, ["index.js"]);
  });

  it("respects .gitignore patterns", async () => {
    await writeFileAt(root, ".gitignore", "*.log\nbuild/\n");
    await writeFileAt(root, "app.ts", "code");
    await writeFileAt(root, "debug.log", "log");
    await writeFileAt(root, "build/output.js", "built");

    const result = await scanDirectory(root);
    assert.deepEqual(result.files, [".gitignore", "app.ts"]);
  });

  it("handles negation in .gitignore", async () => {
    await writeFileAt(root, ".gitignore", "*.log\n!important.log\n");
    await writeFileAt(root, "debug.log", "log");
    await writeFileAt(root, "important.log", "keep");
    await writeFileAt(root, "app.ts", "code");

    const result = await scanDirectory(root);
    assert.ok(result.files.includes("important.log"), "negated file should be included");
    assert.ok(!result.files.includes("debug.log"), "non-negated file should be excluded");
  });

  it("returns empty array for empty directory", async () => {
    const result = await scanDirectory(root);
    assert.deepEqual(result.files, []);
  });
});
