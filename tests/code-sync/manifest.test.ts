import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { hashFiles, serializeManifest, deserializeManifest } from "../../packages/core/src/code-sync/manifest.js";
import { tmpDir, writeFileAt, sha256 } from "./helpers.js";

describe("hashFiles / manifest serialization", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("computes known SHA-256 hash", async () => {
    const content = "hello world";
    await writeFileAt(root, "test.txt", content);

    const manifest = await hashFiles(root, ["test.txt"]);
    const entry = manifest.get("test.txt")!;

    assert.equal(entry.hash, sha256(content));
  });

  it("different content produces different hash", async () => {
    await writeFileAt(root, "a.txt", "content-a");
    await writeFileAt(root, "b.txt", "content-b");

    const manifest = await hashFiles(root, ["a.txt", "b.txt"]);
    assert.notEqual(manifest.get("a.txt")!.hash, manifest.get("b.txt")!.hash);
  });

  it("same content produces same hash", async () => {
    await writeFileAt(root, "a.txt", "same");
    await writeFileAt(root, "b.txt", "same");

    const manifest = await hashFiles(root, ["a.txt", "b.txt"]);
    assert.equal(manifest.get("a.txt")!.hash, manifest.get("b.txt")!.hash);
  });

  it("captures correct file size", async () => {
    const content = "hello";
    await writeFileAt(root, "test.txt", content);

    const manifest = await hashFiles(root, ["test.txt"]);
    assert.equal(manifest.get("test.txt")!.size, Buffer.byteLength(content));
  });

  it("serialization round-trips correctly", async () => {
    await writeFileAt(root, "a.txt", "aaa");
    await writeFileAt(root, "b.txt", "bbb");

    const manifest = await hashFiles(root, ["a.txt", "b.txt"]);
    const serialized = serializeManifest(manifest, root);
    const deserialized = deserializeManifest(serialized);

    assert.equal(deserialized.size, manifest.size);
    for (const [key, entry] of manifest) {
      const restored = deserialized.get(key)!;
      assert.equal(restored.hash, entry.hash);
      assert.equal(restored.size, entry.size);
      assert.equal(restored.relativePath, entry.relativePath);
    }
  });

  it("handles binary files", async () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
    const full = path.join(root, "binary.bin");
    await writeFile(full, binaryContent);

    const manifest = await hashFiles(root, ["binary.bin"]);
    const entry = manifest.get("binary.bin")!;
    assert.equal(entry.hash, sha256(binaryContent));
    assert.equal(entry.size, 5);
  });
});
