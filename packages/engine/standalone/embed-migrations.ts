/**
 * Bundle-time macro: read the engine's SQL migrations so the standalone binary
 * carries them inline. Imported only with `{ type: 'macro' }`, so it runs inside
 * `bun build` and never ships in the binary.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EmbeddedMigrations {
  files: Record<string, string>;
  supersessions: unknown;
}

export function embeddedMigrations(): EmbeddedMigrations {
  const dir = join(import.meta.dir, '../src/db/migrations');
  const files: Record<string, string> = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    files[file] = readFileSync(join(dir, file), 'utf8');
  }
  return {
    files,
    supersessions: JSON.parse(readFileSync(join(dir, 'supersessions.json'), 'utf8')),
  };
}
