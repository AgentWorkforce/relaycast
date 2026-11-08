#!/usr/bin/env node
/**
 * Generate PostgreSQL migrations from src/db/schema.pg.ts with drizzle-kit,
 * then post-process the files drizzle-kit wrote:
 *
 * - remove `CREATE SCHEMA "relaycast"`: the platform pre-creates the schema
 *   (owned by relaycast_owner), and the owner role cannot create schemas;
 * - fail if any migration contains CREATE/ALTER/DROP SCHEMA, CREATE/ALTER/DROP
 *   ROLE or USER, or GRANT/REVOKE: those belong to the platform bootstrap.
 *
 * Usage:
 *   node scripts/generate-pg-migrations.mjs [--name <name>] # schema diff -> next migration
 *   node scripts/generate-pg-migrations.mjs --custom <name> # empty hand-written migration
 *   node scripts/generate-pg-migrations.mjs --check         # only run the forbidden-statement check
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(engineRoot, 'src/db/migrations-pg');

const CREATE_SCHEMA = /^CREATE SCHEMA(?: IF NOT EXISTS)? "?relaycast"?;\s*(?:--> statement-breakpoint\s*)?/gim;
const FORBIDDEN = [
  /\b(?:CREATE|ALTER|DROP)\s+SCHEMA\b/i,
  /\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|GROUP)\b/i,
  /^\s*(?:GRANT|REVOKE)\b/im,
  /\bDROP\s+OWNED\b/i,
  /\bREASSIGN\s+OWNED\b/i,
];

export function postprocess(sql) {
  return sql.replace(CREATE_SCHEMA, '');
}

export function forbiddenStatements(sql) {
  // Ignore comments; trigger bodies may mention words like "grant" in prose.
  const code = sql.replace(/--[^\n]*/g, '');
  return FORBIDDEN.filter((re) => re.test(code)).map((re) => re.source);
}

function sqlFiles() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function runDrizzleKit(args) {
  const require = createRequire(import.meta.url);
  const bin = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
  const result = spawnSync(process.execPath, [bin, 'generate', '--config', 'drizzle.pg.config.ts', ...args], {
    cwd: engineRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--check')) {
    const custom = argv.indexOf('--custom');
    const named = argv.indexOf('--name');
    if (custom >= 0) runDrizzleKit(['--custom', '--name', argv[custom + 1] ?? 'custom']);
    else runDrizzleKit(named >= 0 ? ['--name', argv[named + 1]] : []);
  }
  let failed = false;
  for (const file of sqlFiles()) {
    const path = join(migrationsDir, file);
    const before = readFileSync(path, 'utf8');
    const after = argv.includes('--check') ? before : postprocess(before);
    if (after !== before) writeFileSync(path, after);
    const bad = forbiddenStatements(after);
    if (bad.length > 0) {
      failed = true;
      console.error(`${file}: forbidden platform DDL (${bad.join(', ')})`);
    }
  }
  if (failed) process.exit(1);
}
