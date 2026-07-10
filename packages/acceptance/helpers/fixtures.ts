import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(helpersDir, "../fixtures");

const SECRET_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/,
  /\b(?:ya29\.[A-Za-z0-9._-]+|eyJ[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)\b/,
  /\bBearer\s+[A-Za-z0-9._-]+\b/i,
];

function resolveFixturePath(relPath: string): string {
  const resolved = path.resolve(fixturesRoot, relPath);
  const relative = path.relative(fixturesRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Fixture path escapes fixture root: ${relPath}`);
  }

  return resolved;
}

function assertRedacted(raw: string, relPath: string): void {
  for (const pattern of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(raw)) !== null) {
      const token = match[0];
      if (token.startsWith("[REDACTED:")) continue;
      throw new Error(`Fixture contains unredacted secret material: ${relPath}`);
    }
  }
}

export function loadFixtureText(relPath: string): string {
  const fixturePath = resolveFixturePath(relPath);
  const raw = fs.readFileSync(fixturePath, "utf8");
  assertRedacted(raw, relPath);
  return raw;
}

export function loadFixture<T = unknown>(relPath: string): T {
  const raw = loadFixtureText(relPath);
  return JSON.parse(raw) as T;
}
