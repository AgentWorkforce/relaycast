/**
 * Standalone replacement for `src/adapters/node/migration-source.ts`: serves the
 * migrations embedded in the binary at bundle time instead of reading the disk.
 */
import { embeddedMigrations } from './embed-migrations.js' with { type: 'macro' };
import type { MigrationSource } from '../src/adapters/node/migration-source.js';

const bundle = embeddedMigrations();

export function loadMigrationSource(): MigrationSource {
  return {
    files: Object.keys(bundle.files),
    read: (file) => {
      const sql = bundle.files[file];
      if (sql === undefined) throw new Error(`Unknown embedded migration: ${file}`);
      return sql;
    },
    supersessions: bundle.supersessions,
  };
}
