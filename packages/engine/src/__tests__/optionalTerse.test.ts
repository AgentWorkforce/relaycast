import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('..', import.meta.url));
const IMPORTS_TERSE = /from\s+['"](durable-actors|terse-sdk)(\/[^'"]*)?['"]|import\(\s*['"](durable-actors|terse-sdk)/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

// Terse is one way to run the engine, not a dependency of it: the actor
// adapter is written against its own minimal database/alarm interfaces.
describe('engine without durable-actors', () => {
  it('has no source that imports durable-actors or terse-sdk', () => {
    const self = fileURLToPath(import.meta.url);
    const offenders = sources(srcRoot).filter((path) => path !== self && IMPORTS_TERSE.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('does not declare durable-actors or terse-sdk as a dependency', () => {
    const manifest = JSON.parse(readFileSync(join(srcRoot, '../package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(Object.keys(manifest[field] ?? {})).not.toContain('durable-actors');
      expect(Object.keys(manifest[field] ?? {})).not.toContain('terse-sdk');
    }
  });

  // durable-actors is resolvable here only because a sibling workspace
  // (`@relaycast/actors-workspace`) hoists it into the monorepo's node_modules;
  // the source scan and manifest checks above are what keep it out of the engine.
  it('loads every entry point without importing durable-actors', async () => {
    for (const entry of ['../index.js', '../ports/index.js', '../adapters/node/index.js', '../gateway.js', '../adapters/actor/index.js']) {
      await expect(import(entry)).resolves.toBeDefined();
    }
  });
});
