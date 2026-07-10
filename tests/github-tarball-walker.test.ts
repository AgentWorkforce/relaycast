import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import * as tar from "tar";
import * as walkerModule from "../packages/web/lib/integrations/github-tarball-walker.ts";

const { GITHUB_CLONE_MAX_FILE_BYTES, walkGithubTarball } = walkerModule;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function collectStream(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function createGithubTarball(
  files: Record<string, string | Buffer>,
  prefix = "acme-demo-abc123",
): Promise<Buffer> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "github-tarball-walker-"));
  tempDirs.push(tempDir);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(tempDir, prefix, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }

  return await collectStream(
    tar.c(
      {
        cwd: tempDir,
        gzip: true,
      },
      [prefix],
    ),
  );
}

async function walkSingleEntry(
  files: Record<string, string | Buffer>,
  targetPath: string,
  prefix?: string,
) {
  const tarball = await createGithubTarball(files, prefix);
  const entries = [];

  for await (const entry of walkGithubTarball(Readable.from(tarball))) {
    entries.push(entry);
  }

  const match = entries.find((entry) => entry.repoPath === targetPath);
  assert.ok(match, `expected ${targetPath} to be yielded`);
  return match;
}

describe("github tarball walker", () => {
  it("strips leading owner-repo-sha/ directory from entries", async () => {
    const entry = await walkSingleEntry(
      {
        "src/index.ts": "export const value = 1;\n",
      },
      "src/index.ts",
      "octo-demo-deadbeef",
    );

    assert.equal(entry.repoPath, "src/index.ts");
  });

  it("text file is decoded as utf-8", async () => {
    const entry = await walkSingleEntry(
      {
        "README.md": "Hello from tarball walker\n",
      },
      "README.md",
    );

    assert.equal(entry.isBinary, false);
    assert.equal(entry.skipped, undefined);
    assert.equal(entry.content.toString("utf8"), "Hello from tarball walker\n");
  });

  it("png file is detected as binary by extension", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const entry = await walkSingleEntry(
      {
        "assets/logo.png": pngBytes,
      },
      "assets/logo.png",
    );

    assert.equal(entry.isBinary, true);
    assert.equal(entry.skipped, undefined);
    assert.deepEqual(entry.content, pngBytes);
  });

  it("file with NUL byte in first 8KB is detected as binary by content sniff", async () => {
    const entry = await walkSingleEntry(
      {
        "src/null-sniffed.dat": Buffer.from([0x48, 0x69, 0x00, 0x21]),
      },
      "src/null-sniffed.dat",
    );

    assert.equal(entry.isBinary, true);
    assert.equal(entry.skipped, undefined);
  });

  it(".git entries are yielded with skipped=ignored", async () => {
    const entry = await walkSingleEntry(
      {
        ".git/HEAD": "ref: refs/heads/main\n",
      },
      ".git/HEAD",
    );

    assert.equal(entry.skipped, "ignored");
    assert.equal(entry.content.byteLength, 0);
  });

  it("node_modules entries are yielded with skipped=ignored", async () => {
    const entry = await walkSingleEntry(
      {
        "node_modules/react/index.js": "module.exports = {};\n",
      },
      "node_modules/react/index.js",
    );

    assert.equal(entry.skipped, "ignored");
    assert.equal(entry.content.byteLength, 0);
  });

  it("package-lock.json is yielded with skipped=ignored", async () => {
    const entry = await walkSingleEntry(
      {
        "package-lock.json": "{\"lockfileVersion\": 3}\n",
      },
      "package-lock.json",
    );

    assert.equal(entry.skipped, "ignored");
    assert.equal(entry.content.byteLength, 0);
  });

  it("file over 1 MiB is yielded with skipped=too-large and empty content buffer", async () => {
    const oversized = Buffer.alloc(GITHUB_CLONE_MAX_FILE_BYTES + 1, 0x61);
    const entry = await walkSingleEntry(
      {
        "big.txt": oversized,
      },
      "big.txt",
    );

    assert.equal(entry.skipped, "too-large");
    assert.equal(entry.content.byteLength, 0);
    assert.equal(entry.size, oversized.byteLength);
  });

  it(".min.js is yielded with skipped=ignored", async () => {
    const entry = await walkSingleEntry(
      {
        "assets/app.min.js": "minified();",
      },
      "assets/app.min.js",
    );

    assert.equal(entry.skipped, "ignored");
    assert.equal(entry.content.byteLength, 0);
  });

  it("invalid UTF-8 text file falls back to binary", async () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28, 0x61]);
    const entry = await walkSingleEntry(
      {
        "notes.txt": invalidUtf8,
      },
      "notes.txt",
    );

    assert.equal(entry.isBinary, true);
    assert.equal(entry.skipped, undefined);
    assert.deepEqual(entry.content, invalidUtf8);
  });
});
