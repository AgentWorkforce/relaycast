import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { countRelayfileConflicts, resolveRelayfileConflictsDir } from "./relayfile-conflicts";

describe("countRelayfileConflicts", () => {
  it("counts files in the mounted workspace conflict directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relayfile-conflicts-"));
    try {
      const conflictsDir = resolveRelayfileConflictsDir(dir);
      await mkdir(conflictsDir, { recursive: true });
      await writeFile(join(conflictsDir, "src-app.ts.1779192000001"), "conflict");
      await writeFile(join(conflictsDir, "README.md.1779192000002"), "conflict");

      await expect(countRelayfileConflicts(dir)).resolves.toMatchObject({
        conflictCount: 2,
        conflictsDir,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing conflict directory as a clean mount", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relayfile-conflicts-"));
    try {
      await expect(countRelayfileConflicts(dir)).resolves.toMatchObject({
        conflictCount: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
