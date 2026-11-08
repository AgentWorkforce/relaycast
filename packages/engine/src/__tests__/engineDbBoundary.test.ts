import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Engine code reaches the database only through the neutral EngineDb and the
// table binding in db/tables.ts. SQLite-specific types and casts that hide a
// handle's dialect are allowed only in the SQLite schema, the binding, and
// the adapters.
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SELF = relative(SRC, fileURLToPath(import.meta.url)).split(sep).join('/');
const ALLOWED = (path: string) =>
  path === 'db/schema.ts' || path === 'db/tables.ts' || path.startsWith('adapters/') || path === SELF;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function violations(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const path = relative(SRC, file).split(sep).join('/');
    if (ALLOWED(path)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (pattern.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe('EngineDb boundary', () => {
  it('has no cast to EngineDb outside the adapters', () => {
    expect(violations(/\bas\s+(?:unknown\s+as\s+)?EngineDb\b/)).toEqual([]);
  });

  it('has no drizzle-orm/sqlite-core import outside the schema, binding and adapters', () => {
    expect(violations(/['"]drizzle-orm\/sqlite-core['"]/)).toEqual([]);
  });

  it('scans the engine sources', () => {
    expect(sources(SRC).length).toBeGreaterThan(100);
  });
});
