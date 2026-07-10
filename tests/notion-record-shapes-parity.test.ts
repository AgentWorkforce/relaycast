import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CLOUD_FILE = path.join(
  rootDir,
  "packages/core/src/sync/notion-record-shapes.ts",
);
const NANGO_FILE = path.join(
  rootDir,
  "nango-integrations/notion-relay/shared/notion-record-shapes.ts",
);

const BEGIN_MARKER = "// === BEGIN MIRRORED BODY ===";
const END_MARKER = "// === END MIRRORED BODY ===";

function extractMirroredBody(source: string, label: string): string {
  const beginIndex = source.indexOf(BEGIN_MARKER);
  const endIndex = source.indexOf(END_MARKER);
  if (beginIndex === -1 || endIndex === -1) {
    throw new Error(`${label}: missing BEGIN/END mirror markers`);
  }
  // Skip the BEGIN line itself and any directly-adjacent header comments so
  // each file can document the mirror differently while still asserting the
  // helper function bodies match byte-for-byte.
  const slice = source.slice(beginIndex + BEGIN_MARKER.length, endIndex);
  // Strip the leading mirror-header comment block (lines beginning with `//`
  // immediately after the BEGIN marker), but keep all functional code.
  const lines = slice.split("\n");
  let cursor = 0;
  // Skip blank line right after marker.
  while (cursor < lines.length && lines[cursor]?.trim() === "") cursor += 1;
  // Skip leading comment block.
  while (cursor < lines.length && lines[cursor]?.trimStart().startsWith("//")) {
    cursor += 1;
  }
  return lines.slice(cursor).join("\n").trim();
}

describe("notion-record-shapes parity", () => {
  it("cloud and Nango-sandbox copies share a byte-equal helper body", () => {
    const cloudSource = readFileSync(CLOUD_FILE, "utf8");
    const nangoSource = readFileSync(NANGO_FILE, "utf8");

    const cloudBody = extractMirroredBody(cloudSource, CLOUD_FILE);
    const nangoBody = extractMirroredBody(nangoSource, NANGO_FILE);

    // If this fails, you changed one of the files without mirroring the
    // change to the other. Update both files together — the Nango sandbox
    // cannot import from `@cloud/core`, so this is the cheapest way to
    // guarantee the two copies stay in lockstep.
    expect(cloudBody).toBe(nangoBody);
  });

  it("both files declare the same record-model constants", () => {
    const cloudSource = readFileSync(CLOUD_FILE, "utf8");
    const nangoSource = readFileSync(NANGO_FILE, "utf8");

    for (const constant of [
      'NOTION_PAGE_MODEL = "NotionPage"',
      'NOTION_PAGE_CONTENT_MODEL = "NotionPageContent"',
      "NOTION_PREVIEW_CHAR_LIMIT = 500",
    ]) {
      expect(cloudSource).toContain(constant);
      expect(nangoSource).toContain(constant);
    }
  });
});
