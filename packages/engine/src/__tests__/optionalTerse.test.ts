import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const srcRoot = fileURLToPath(new URL('..', import.meta.url));
const IMPORTS_TERSE = /from\s+['"](durable-actors|terse-sdk)(\/[^'"]*)?['"]|import\(\s*['"](durable-actors|terse-sdk)|require\(\s*['"](durable-actors|terse-sdk)/;

// Importing either package throws in this module graph, whatever a sibling
// workspace hoisted into node_modules: an entry point that reached either
// package, directly or through a dependency, could not load below. The mock
// only covers imports vitest resolves; a native `require()` would bypass it,
// which the source scan below covers instead.
for (const name of ['durable-actors', 'terse-sdk']) {
  vi.doMock(name, () => { throw new Error(`${name} must not be loaded by the engine`); });
}

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

  it('loads every entry point while durable-actors and terse-sdk throw on import', async () => {
    // (vitest reports a throwing factory with its own wording.)
    await expect(import('durable-actors')).rejects.toThrow();
    for (const entry of ['../index.js', '../ports/index.js', '../adapters/node/index.js', '../gateway.js', '../adapters/actor/index.js']) {
      await expect(import(entry)).resolves.toBeDefined();
    }
  });
});
