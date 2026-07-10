import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import * as tar from "tar";
import * as artifactModule from "../../packages/web/lib/ricky/artifact-store.ts";

const {
  createRepairedSourceArchive,
  uploadIsolatedRepairedSourceArchive,
} = artifactModule as {
  createRepairedSourceArchive: typeof import("../../packages/web/lib/ricky/artifact-store.ts").createRepairedSourceArchive;
  uploadIsolatedRepairedSourceArchive: typeof import("../../packages/web/lib/ricky/artifact-store.ts").uploadIsolatedRepairedSourceArchive;
};

async function makeArchive(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "ricky-archive-test-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const filePath = path.join(dir, relative);
      await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(filePath), { recursive: true }));
      await writeFile(filePath, content);
    }
    const archivePath = path.join(dir, "code.tar.gz");
    await tar.create({ gzip: true, file: archivePath, cwd: dir }, Object.keys(files));
    return readFile(archivePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readArchiveFile(archive: Buffer, relativePath: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ricky-archive-read-"));
  try {
    const archivePath = path.join(dir, "code.tar.gz");
    await writeFile(archivePath, archive);
    await tar.extract({ file: archivePath, cwd: dir });
    return readFile(path.join(dir, relativePath), "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Ricky isolated source artifacts", () => {
  it("rewrites only the workflow file inside a repaired source archive", async () => {
    const source = await makeArchive({
      "workflows/fix.ts": "export const workflow = 'broken';\n",
      "src/helper.ts": "export const helper = true;\n",
    });

    const repaired = await createRepairedSourceArchive({
      archive: source,
      workflowPath: "workflows/fix.ts",
      repairedWorkflow: "export const workflow = 'fixed';\n",
    });

    assert.match(repaired.digest, /^[a-f0-9]{64}$/);
    assert.equal(
      await readArchiveFile(repaired.archive, "workflows/fix.ts"),
      "export const workflow = 'fixed';\n",
    );
    assert.equal(
      await readArchiveFile(repaired.archive, "src/helper.ts"),
      "export const helper = true;\n",
    );
  });

  it("rejects archive symlinks before writing repaired workflow files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ricky-archive-symlink-"));
    try {
      await symlink("other-workflows", path.join(dir, "workflows"), "dir");
      const archivePath = path.join(dir, "code.tar.gz");
      await tar.create({ gzip: true, file: archivePath, cwd: dir }, ["workflows"]);
      const archive = await readFile(archivePath);

      await assert.rejects(
        createRepairedSourceArchive({
          archive,
          workflowPath: "workflows/fix.ts",
          repairedWorkflow: "fixed\n",
        }),
        /archive symlink/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("copies source archives from the failed run prefix to the next run prefix", async () => {
    const objects = new Map<string, Buffer>();
    objects.set(
      "user-1/run-root/code.tar.gz",
      await makeArchive({ "workflow.ts": "broken\n" }),
    );

    const result = await uploadIsolatedRepairedSourceArchive({
      userId: "user-1",
      sourceRunId: "run-root",
      sourceS3CodeKey: "code.tar.gz",
      targetRunId: "run-rerun",
      workflowPath: "workflow.ts",
      repairedWorkflow: "fixed\n",
      targetS3CodeKey: "ricky/attempt-2/code.tar.gz",
      archiveIO: {
        async readObject(key) {
          const value = objects.get(key);
          if (!value) throw new Error(`missing object ${key}`);
          return value;
        },
        async writeObject(key, body) {
          objects.set(key, body);
        },
      },
    });

    assert.equal(result.s3CodeKey, "ricky/attempt-2/code.tar.gz");
    assert.equal(result.objectKey, "user-1/run-rerun/ricky/attempt-2/code.tar.gz");
    assert.equal(
      await readArchiveFile(objects.get(result.objectKey)!, "workflow.ts"),
      "fixed\n",
    );
  });
});
