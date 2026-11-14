#!/usr/bin/env node
/**
 * Generate PostgreSQL migrations from src/db/schema.pg.ts with drizzle-kit,
 * then post-process the files drizzle-kit wrote:
 *
 * - remove any `CREATE SCHEMA` drizzle-kit emits: tables live in `public`, the
 *   default schema the platform hands to relaycast_owner;
 * - fail if any migration contains a forbidden statement (FORBIDDEN below):
 *   schema/role DDL, GRANT/REVOKE and DROP/REASSIGN OWNED belong to the
 *   platform bootstrap; transaction control breaks the migrator's
 *   one-transaction-per-file boundary; SECURITY DEFINER, SET ROLE,
 *   SET SESSION AUTHORIZATION and search_path changes (other than the trigger
 *   function guard) would run migrated code with other privileges or names.
 *
 * `--check` changes nothing and fails (exit 1) on any of:
 * - schema drift: drizzle-kit, run against a scratch copy of the committed
 *   migrations, would generate a new migration from schema.pg.ts;
 * - SQL/snapshot drift: a committed generated migration's SQL differs from
 *   what drizzle-kit derives from the committed snapshots (a hand edit);
 * - a forbidden statement in any committed migration.
 *
 * src/adapters/postgres/migrate.ts carries the same forbidden list and applies
 * it again when an image loads its bundle; migrate.test.ts keeps them in step.
 * (This file stays plain JavaScript so CI's Node can run it without a
 * TypeScript loader.)
 *
 * Usage:
 *   node scripts/generate-pg-migrations.mjs [--name <name>] # schema diff -> next migration
 *   node scripts/generate-pg-migrations.mjs --custom <name> # empty hand-written migration
 *   node scripts/generate-pg-migrations.mjs --check         # drift + forbidden-statement check
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(engineRoot, 'src/db/migrations-pg');
const require = createRequire(import.meta.url);

const CREATE_SCHEMA = /^CREATE SCHEMA(?: IF NOT EXISTS)? "?public"?;\s*(?:--> statement-breakpoint\s*)?/gim;

/** Same list as FORBIDDEN_MIGRATION_PATTERNS in src/adapters/postgres/migrate.ts. */
export const FORBIDDEN = [
  { name: 'schema DDL', re: /\b(?:CREATE|ALTER|DROP)\s+SCHEMA\b/i, scope: 'code' },
  { name: 'role DDL', re: /\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|GROUP)\b/i, scope: 'code' },
  { name: 'GRANT/REVOKE', re: /^\s*(?:GRANT|REVOKE)\b/im, scope: 'code' },
  { name: 'DROP OWNED', re: /\bDROP\s+OWNED\b/i, scope: 'code' },
  { name: 'REASSIGN OWNED', re: /\bREASSIGN\s+OWNED\b/i, scope: 'code' },
  { name: 'SECURITY DEFINER', re: /\bSECURITY\s+DEFINER\b/i, scope: 'code' },
  { name: 'SET ROLE', re: /\b(?:SET|RESET)\s+(?:(?:SESSION|LOCAL)\s+)?ROLE\b/i, scope: 'code' },
  { name: 'SET SESSION AUTHORIZATION', re: /\bSESSION\s+AUTHORIZATION\b/i, scope: 'code' },
  { name: 'search_path', re: /\bsearch_path\b/i, scope: 'code' },
  {
    name: 'transaction control',
    re: /^(?:BEGIN|COMMIT|ROLLBACK|ABORT|END|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i,
    scope: 'statement',
  },
];

/** The trigger-function header that pins search_path; the only one allowed. */
const SEARCH_PATH_GUARD = /\bLANGUAGE\s+plpgsql\s+SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp\s+AS\s+(?=\$)/gi;

export function postprocess(sql) {
  return sql.replace(CREATE_SCHEMA, '');
}

/** Names of the forbidden patterns `sql` contains (comments ignored). */
export function forbiddenStatements(sql) {
  // Ignore comments; trigger bodies may mention words like "grant" in prose.
  const code = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(SEARCH_PATH_GUARD, ' ');
  // plpgsql bodies contain BEGIN ... END: test transaction control only at
  // statement starts outside dollar-quoted bodies.
  const statements = code
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, '$$$$')
    .split(';')
    .map((s) => s.trim());
  return FORBIDDEN.filter(({ re, scope }) =>
    scope === 'code' ? re.test(code) : statements.some((s) => re.test(s)),
  ).map(({ name }) => name);
}

/** Generated SQL as a list of statements: breakpoints split, CREATE SCHEMA dropped. */
export function normaliseStatements(sql) {
  return postprocess(sql)
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^CREATE SCHEMA\b/i.test(s));
}

function drizzleKitBin() {
  return join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
}

function runDrizzleKit(args) {
  const result = spawnSync(process.execPath, [drizzleKitBin(), 'generate', '--config', 'drizzle.pg.config.ts', ...args], {
    cwd: engineRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readJournal(dir) {
  return JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
}

/**
 * Schema drift: would drizzle-kit generate a new migration from schema.pg.ts
 * on top of the committed snapshots? Runs against a scratch copy, so the
 * committed tree is never touched. Returns problems (empty when in sync).
 */
function schemaDrift() {
  // drizzle-kit mangles absolute --out paths; keep the scratch dir under the
  // engine root and pass it relatively.
  const scratch = mkdtempSync(join(engineRoot, '.pg-migrations-check-'));
  try {
    const out = join(scratch, 'migrations-pg');
    cpSync(migrationsDir, out, { recursive: true });
    const before = readJournal(out).entries.length;
    const result = spawnSync(
      process.execPath,
      [
        drizzleKitBin(),
        'generate',
        '--dialect',
        'postgresql',
        '--schema',
        './src/db/schema.pg.ts',
        '--out',
        `./${relative(engineRoot, out)}`,
        '--name',
        'drift',
      ],
      // stdin ignored: an interactive rename prompt is itself drift and
      // must fail rather than hang CI.
      { cwd: engineRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status !== 0)
      return [`drizzle-kit generate failed (exit ${result.status}):\n${result.stdout}${result.stderr}`];
    const after = readJournal(out).entries;
    if (after.length === before) return [];
    const added = after.slice(before).map((e) => {
      const file = join(out, `${e.tag}.sql`);
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    });
    return [
      'src/db/schema.pg.ts differs from the committed migrations; run `npm run generate:pg-migrations` and commit the result. Pending SQL:\n' +
        added.join('\n'),
    ];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const EMPTY_SNAPSHOT = {
  id: '00000000-0000-0000-0000-000000000000',
  prevId: '',
  version: '7',
  dialect: 'postgresql',
  tables: {},
  enums: {},
  schemas: {},
  sequences: {},
  roles: {},
  policies: {},
  views: {},
  _meta: { schemas: {}, tables: {}, columns: {} },
};

/**
 * SQL/snapshot drift: for each journal entry, the SQL drizzle-kit derives from
 * (previous snapshot -> this snapshot) must equal the committed SQL. An empty
 * derivation is a custom (hand-written) migration and is not compared.
 */
async function sqlSnapshotDrift() {
  const { generateMigration } = require('drizzle-kit/api');
  const problems = [];
  let prev = EMPTY_SNAPSHOT;
  for (const entry of readJournal(migrationsDir).entries) {
    const snapshotPath = join(migrationsDir, 'meta', `${entry.tag.slice(0, 4)}_snapshot.json`);
    if (!existsSync(snapshotPath)) {
      problems.push(`${entry.tag}: missing snapshot ${relative(engineRoot, snapshotPath)}`);
      continue;
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const derived = normaliseStatements((await generateMigration(prev, snapshot)).join('\n--> statement-breakpoint\n'));
    if (derived.length > 0) {
      const committed = normaliseStatements(readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8'));
      if (JSON.stringify(committed) !== JSON.stringify(derived)) {
        const i = derived.findIndex((s, n) => s !== committed[n]);
        const at = i < 0 ? committed.length : i;
        problems.push(
          `${entry.tag}.sql differs from its snapshot (hand-edited generated SQL?) at statement ${at + 1}:\n` +
            `  expected: ${derived[at] ?? '<end>'}\n  found:    ${committed[at] ?? '<end>'}`,
        );
      }
    }
    prev = snapshot;
  }
  return problems;
}

function sqlFiles() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function forbiddenProblems(rewrite) {
  const problems = [];
  for (const file of sqlFiles()) {
    const path = join(migrationsDir, file);
    const before = readFileSync(path, 'utf8');
    const after = rewrite ? postprocess(before) : before;
    if (after !== before) writeFileSync(path, after);
    const bad = forbiddenStatements(after);
    if (bad.length > 0) problems.push(`${file}: forbidden statement(s) (${bad.join(', ')})`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--check')) {
    const problems = [...forbiddenProblems(false), ...(await sqlSnapshotDrift()), ...schemaDrift()];
    for (const p of problems) console.error(p);
    if (problems.length > 0) process.exit(1);
    console.log(`PostgreSQL migrations are in sync with src/db/schema.pg.ts (${sqlFiles().length} files checked)`);
  } else {
    const custom = argv.indexOf('--custom');
    const named = argv.indexOf('--name');
    if (custom >= 0) runDrizzleKit(['--custom', '--name', argv[custom + 1] ?? 'custom']);
    else runDrizzleKit(named >= 0 ? ['--name', argv[named + 1]] : []);
    const problems = forbiddenProblems(true);
    for (const p of problems) console.error(p);
    if (problems.length > 0) process.exit(1);
  }
}
