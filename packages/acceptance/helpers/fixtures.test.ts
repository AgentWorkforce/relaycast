import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureText } from "./fixtures";

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(helpersDir, "../fixtures");

describe("fixture redaction guard", () => {
  it("rejects files that mix redacted and unredacted secrets", () => {
    const tempDir = mkdtempSync(path.join(fixturesDir, "tmp-redaction-"));
    const relPath = `${path.basename(tempDir)}/mixed-secret.json`;
    const absPath = path.join(tempDir, "mixed-secret.json");

    try {
      writeFileSync(
        absPath,
        JSON.stringify(
          {
            safe: "[REDACTED:12]",
            unsafe: "ghp_actualTokenHere123456",
          },
          null,
          2,
        ),
        "utf8",
      );

      expect(() => loadFixtureText(relPath)).toThrow(
        /Fixture contains unredacted secret material/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows properly redacted fixtures", () => {
    const tempDir = mkdtempSync(path.join(fixturesDir, "tmp-redaction-"));
    const relPath = `${path.basename(tempDir)}/safe.json`;
    const absPath = path.join(tempDir, "safe.json");

    try {
      writeFileSync(
        absPath,
        JSON.stringify(
          {
            token: "[REDACTED:24]",
            note: "fixture payload",
          },
          null,
          2,
        ),
        "utf8",
      );

      expect(loadFixtureText(relPath)).toContain("[REDACTED:24]");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
