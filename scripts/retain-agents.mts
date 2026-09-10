#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { agentRetentionSchema, retainAgents, type AgentRetentionDb } from '../packages/engine/src/engine/agentRetention.js';
import type { EngineDb } from '../packages/engine/src/ports/database.js';

async function main() {
  const { values } = parseArgs({ options: {
    'base-url': { type: 'string' },
    sqlite: { type: 'string' },
    'd1-database-id': { type: 'string' },
    'workspace-id': { type: 'string' },
    'retention-days': { type: 'string', default: '30' },
    limit: { type: 'string' },
    'max-pages': { type: 'string', default: '50' },
    'state-file': { type: 'string' },
    delete: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  }, strict: true });

  if (values.help) {
    console.log(`Usage: npx tsx scripts/retain-agents.mts
    --base-url <engine-url>                       (RELAYCAST_API_KEY from environment)
    OR --sqlite <existing-file> --workspace-id <id>
    OR --d1-database-id <id> --workspace-id <id>  (read-only D1 preview)
    [--retention-days 30] [--limit 100] [--max-pages 50] [--state-file <path>] [--delete]

  Defaults to dry-run. Prints one JSON report per page, followed by totals.
  --limit bounds registry rows per page (integer 1-100; default 100).
  Save --state-file to resume a bounded traversal after interruption. Use a new
  state file to start a fresh traversal or switch from preview to deletion.
  SQLite mode never migrates the database; apply engine migrations separately.`);
    process.exit(0);
  }

  const options = agentRetentionSchema.parse({
    retention_days: Number(values['retention-days']), delete: values.delete,
    limit: values.limit === undefined ? undefined : Number(values.limit),
  });
  const maxPages = z.number().int().min(1).max(10000).parse(Number(values['max-pages']));
  if ([values.sqlite, values['base-url'], values['d1-database-id']].filter(Boolean).length !== 1) {
    throw new Error('Choose exactly one of --base-url, --sqlite, or --d1-database-id');
  }
  if ((values.sqlite || values['d1-database-id']) && !values['workspace-id']) throw new Error('--workspace-id is required for database access');
  if (values['d1-database-id'] && options.delete) throw new Error('D1 database access supports dry-run only; use the admin endpoint for deletion');
  if (values['d1-database-id'] && (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required for D1 preview');
  }
  const baseUrl = values['base-url']?.replace(/\/$/, '');
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Base URL must not contain credentials, query, or fragment');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Remote engine URL must use HTTPS');
    }
    if (!process.env.RELAYCAST_API_KEY) throw new Error('RELAYCAST_API_KEY is required');
  }

  const source = baseUrl ?? (values.sqlite
    ? `${resolve(values.sqlite)}#${values['workspace-id']}`
    : `d1:${process.env.CLOUDFLARE_ACCOUNT_ID}/${values['d1-database-id']}#${values['workspace-id']}`);
  const stateSchema = z.object({
    source: z.string(), retention_days: z.number(), delete: z.boolean(),
    cursor: agentRetentionSchema.shape.cursor,
    complete: z.boolean(),
  }).strict();
  let cursor: z.infer<typeof agentRetentionSchema>['cursor'];
  if (values['state-file']) {
    let saved: string | undefined;
    try { saved = await readFile(values['state-file'], 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (saved) {
      const state = stateSchema.parse(JSON.parse(saved));
      if (state.source !== source || state.retention_days !== options.retention_days || state.delete !== options.delete) {
        throw new Error('State file belongs to a different source, policy, or mode');
      }
      if (state.complete) throw new Error('Traversal already complete; use a new state file for a new run');
      cursor = state.cursor;
    }
  }

  // A preview opens SQLite read-only and enables query_only. A typo cannot create
  // an empty database or accidentally run migrations against the selected file.
  const sqlite = values.sqlite ? new Database(values.sqlite, { readonly: !options.delete, fileMustExist: true }) : undefined;
  if (sqlite) {
    sqlite.pragma('foreign_keys = ON');
    if (!options.delete) sqlite.pragma('query_only = ON');
  }
  let db: AgentRetentionDb | undefined = sqlite ? drizzle(sqlite) as unknown as EngineDb : undefined;
  if (values['d1-database-id']) {
    const dialect = new SQLiteSyncDialect();
    db = {
      all: async <T,>(query: SQL | string): Promise<T[]> => {
        const compiled = typeof query === 'string' ? { sql: query, params: [] } : dialect.sqlToQuery(query);
        if (!/^\s*(SELECT|WITH)\b/i.test(compiled.sql)) throw new Error('D1 preview refused a non-read query');
        const account = encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID!);
        const database = encodeURIComponent(values['d1-database-id']!);
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
          method: 'POST', headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify(compiled), redirect: 'error', signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`D1 preview query failed (${response.status})`);
        const body = await response.json() as { success: boolean; result: { success: boolean; results: T[] }[] };
        if (body.success !== true || body.result?.[0]?.success !== true) throw new Error('D1 preview query was not successful');
        return body.result[0].results;
      },
    };
  }
  const totals = { pages: 0, scanned: 0, eligible: 0, deleted: 0, skipped_changed: 0,
    not_offline: 0, recent_or_unknown: 0, ownership_protected: 0, history_unverified: 0, history_referenced: 0 };
  let complete = false;
  try {
    do {
      const body = { ...options, cursor };
      let report: Awaited<ReturnType<typeof retainAgents>>;
      if (db) {
        report = await retainAgents(db, values['workspace-id']!, body);
      } else {
        const response = await fetch(`${baseUrl}/v1/agents/retention`, {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env.RELAYCAST_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`Retention request failed (${response.status}); saved cursor has not advanced`);
        const envelope = await response.json() as { ok: boolean; data: typeof report };
        if (envelope.ok !== true || !envelope.data) throw new Error('Invalid retention response');
        report = envelope.data;
      }
      console.log(JSON.stringify({ type: 'page', ...report }));
      totals.pages++;
      totals.scanned += report.scanned;
      totals.deleted += report.deleted;
      totals.skipped_changed += report.skipped_changed;
      for (const key of Object.keys(report.counts) as (keyof typeof report.counts)[]) totals[key] += report.counts[key];
      cursor = report.next_cursor ?? undefined;
      complete = !cursor;
      if (values['state-file']) {
        const path = values['state-file'];
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify({ source, retention_days: options.retention_days, delete: options.delete, cursor, complete }) + '\n', { mode: 0o600 });
        await rename(temporary, path);
      }
    } while (!complete && totals.pages < maxPages);
    console.log(JSON.stringify({ type: 'summary', dry_run: !options.delete, complete, ...totals, next_cursor: cursor ?? null }));
  } finally {
    sqlite?.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
