import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The engine's SQL migrations: file names, their contents, and the supersession manifest. */
export interface MigrationSource {
  /** Migration file names (`NNNN_name.sql`). Order is not significant; the planner sorts. */
  files: string[];
  /** Read one migration file's SQL. */
  read(file: string): string;
  /** Parsed `supersessions.json`. */
  supersessions: unknown;
}

function migrationsDir(): string {
  // dist/adapters/node/migration-source.js -> dist/db/migrations
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../db/migrations'),
    join(here, '../../../src/db/migrations'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

/**
 * Load migrations from the package's `db/migrations` directory on disk.
 *
 * The standalone single-file build replaces this module at bundle time with one
 * that serves the same files embedded in the binary.
 */
export function loadMigrationSource(): MigrationSource {
  const dir = migrationsDir();
  return {
    files: readdirSync(dir).filter((f) => f.endsWith('.sql')),
    read: (file) => readFileSync(join(dir, file), 'utf8'),
    supersessions: JSON.parse(readFileSync(join(dir, 'supersessions.json'), 'utf8')),
  };
}
