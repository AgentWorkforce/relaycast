import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { compileSqliteQuery } from '../adapters/sqlite-handle.js';
import * as sqlx from '../db/sqlx.js';
import { pruneRowidPages } from '../engine/rowidRetention.js';
import { pruneExpired } from '../engine/retention.js';

// Each SQLite expectation is the exact text the call site emitted before the
// rewrite, taken from `git show db179582:packages/engine/src/<file>` (cited per
// case) with the site's interpolated columns written as raw identifiers.
// The PostgreSQL form is compiled with drizzle's PgDialect.

const pgDialect = new PgDialect();
const pick = ({ sql: text, params }: { sql: string; params: unknown[] }) => ({ sql: text, params });
const lite = (query: SQL) => pick(compileSqliteQuery(query));
const pg = (query: SQL) => pick(pgDialect.sqlToQuery(query));
const raw = (text: string) => sql.raw(text);

const UNBRANDED: ReadonlyArray<[string, unknown]> = [
  ['a plain object', {}],
  ['an unknown brand', { engineDialect: 'mysql' }],
  ['an unknown dialect name', 'mysql'],
];

type Case = {
  helper: string;
  site: string;
  build: (source: sqlx.DialectSource) => SQL;
  sqlite: string;
  sqliteParams?: unknown[];
  pg: string;
  pgParams?: unknown[];
};

const cases: Case[] = [
  {
    helper: 'now', site: 'engine/deliveryWrites.ts:135',
    build: (s) => sqlx.now(s),
    sqlite: 'unixepoch()',
    pg: 'floor(extract(epoch from statement_timestamp()))::bigint',
  },
  {
    helper: 'epochOf', site: 'engine/routing.ts:411',
    build: (s) => sqlx.epochOf(s, raw('a.last_seen')),
    sqlite: 'unixepoch(a.last_seen)',
    pg: '(a.last_seen)',
  },
  {
    helper: 'isoFromEpoch iso-ms', site: 'engine/dm.ts:836',
    build: (s) => sqlx.isoFromEpoch(s, raw('"deliveries"."expires_at"'), 'iso-ms'),
    sqlite: `strftime('%Y-%m-%dT%H:%M:%fZ', "deliveries"."expires_at", 'unixepoch')`,
    pg: `to_char(to_timestamp("deliveries"."expires_at") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  },
  {
    helper: 'isoFromEpoch datetime', site: 'engine/inbox.ts:367',
    build: (s) => sqlx.isoFromEpoch(s, raw('r.created_at'), 'datetime'),
    sqlite: `datetime(r.created_at, 'unixepoch')`,
    pg: `to_char(to_timestamp(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`,
  },
  {
    helper: 'jsonGet', site: 'engine/invocationCompletion.ts:268',
    build: (s) => sqlx.jsonGet(s, raw('we.payload'), '$.node_id'),
    sqlite: `json_extract(we.payload, '$.node_id')`,
    pg: `((we.payload)::jsonb #>> '{node_id}')`,
  },
  {
    helper: 'jsonGet (bound path)', site: 'engine/agent.ts:697',
    build: (s) => sqlx.jsonGet(s, raw(`COALESCE("agents"."metadata", '{}')`), { bind: '$.identity_key' }),
    sqlite: `json_extract(COALESCE("agents"."metadata", '{}'), ?)`,
    sqliteParams: ['$.identity_key'],
    pg: `((COALESCE("agents"."metadata", '{}'))::jsonb #>> $1::text[])`,
    pgParams: ['{identity_key}'],
  },
  {
    helper: 'jsonGetNum', site: 'engine/boundedRetention.ts:109',
    build: (s) => sqlx.jsonGetNum(s, raw('retention'), '$.delivery_ttl_days'),
    sqlite: `json_extract(retention, '$.delivery_ttl_days')`,
    pg: `((retention)::jsonb #>> '{delivery_ttl_days}')::numeric`,
  },
  {
    helper: 'jsonEach (text, AS alias)', site: 'engine/node.ts:3538',
    build: (s) => sqlx.jsonEach(s, '["a1"]', { alias: ' AS allowed', elements: 'text' }),
    sqlite: 'json_each(?) AS allowed',
    sqliteParams: ['["a1"]'],
    pg: 'jsonb_array_elements_text(($1)::jsonb) WITH ORDINALITY AS allowed(value, key)',
    pgParams: ['["a1"]'],
  },
  {
    helper: 'jsonEach (json, bare alias)', site: 'engine/nodeProvider.ts:424',
    build: (s) => sqlx.jsonEach(s, raw(`COALESCE(np.capabilities, '[]')`), { alias: ' je', elements: 'json' }),
    sqlite: `json_each(COALESCE(np.capabilities, '[]')) je`,
    pg: `jsonb_array_elements((COALESCE(np.capabilities, '[]'))::jsonb) WITH ORDINALITY AS je(value, key)`,
  },
  {
    helper: 'jsonEach (no alias)', site: 'engine/node.ts:271',
    build: (s) => sqlx.jsonEach(s, raw('"nodes"."tags"'), { elements: 'text' }),
    sqlite: 'json_each("nodes"."tags")',
    pg: 'jsonb_array_elements_text(("nodes"."tags")::jsonb) WITH ORDINALITY AS json_each(value, key)',
  },
  {
    helper: 'inJsonArray', site: 'engine/agentRetention.ts:114',
    build: (s) => sqlx.inJsonArray(s, raw('a.id'), ['x', 'y']),
    sqlite: 'a.id IN (SELECT value FROM json_each(?))',
    sqliteParams: ['["x","y"]'],
    pg: 'a.id = ANY($1::text[])',
    pgParams: [['x', 'y']],
  },
  {
    helper: 'jsonSet (json value)', site: 'engine/dm.ts:840',
    build: (s) => sqlx.jsonSet(s, raw('"direct_dm_idempotency"."response"'), '$._delivery', raw('r'), 'json'),
    sqlite: `json_set("direct_dm_idempotency"."response", '$._delivery', r)`,
    pg: `jsonb_set(("direct_dm_idempotency"."response")::jsonb, '{_delivery}', (r)::jsonb, true)`,
  },
  {
    helper: 'jsonSet (text value, bound path)', site: 'engine/agent.ts:762',
    build: (s) => sqlx.jsonSet(s, raw(`COALESCE("agents"."metadata", '{}')`), { bind: '$.identity_key' }, sql`${'h'}`, 'text'),
    sqlite: `json_set(COALESCE("agents"."metadata", '{}'), ?, ?)`,
    sqliteParams: ['$.identity_key', 'h'],
    pg: `jsonb_set((COALESCE("agents"."metadata", '{}'))::jsonb, $1::text[], to_jsonb(($2)::text), true)`,
    pgParams: ['{identity_key}', 'h'],
  },
  {
    helper: 'jsonAppend', site: 'engine/action.ts:2707',
    build: (s) => sqlx.jsonAppend(s, raw(`COALESCE("action_invocations"."attempted_node_ids", '[]')`), sql`${'n1'}`, 'text'),
    sqlite: `json_insert(COALESCE("action_invocations"."attempted_node_ids", '[]'), '$[#]', ?)`,
    sqliteParams: ['n1'],
    pg: `((COALESCE("action_invocations"."attempted_node_ids", '[]'))::jsonb || jsonb_build_array(to_jsonb(($1)::text)))`,
    pgParams: ['n1'],
  },
  {
    helper: 'jsonMerge', site: 'engine/agent.ts:836',
    build: (s) => sqlx.jsonMerge(s, raw(`COALESCE("agents"."metadata", '{}')`), sql`${'{"a":1}'}`),
    sqlite: `json_patch(COALESCE("agents"."metadata", '{}'), ?)`,
    sqliteParams: ['{"a":1}'],
    pg: `((COALESCE("agents"."metadata", '{}'))::jsonb || ($1)::jsonb)`,
    pgParams: ['{"a":1}'],
  },
  {
    helper: 'jsonObject', site: 'engine/node.ts:2822',
    build: (s) => sqlx.jsonObject(s, sql`
        'node_id', ${'n1'},
        'registered_at', ${'t'}
      `),
    sqlite: `json_object(
        'node_id', ?,
        'registered_at', ?
      )`,
    sqliteParams: ['n1', 't'],
    pg: `jsonb_build_object(
        'node_id', $1,
        'registered_at', $2
      )`,
    pgParams: ['n1', 't'],
  },
  {
    helper: 'json', site: 'engine/dm.ts:834',
    build: (s) => sqlx.json(s, raw('(SELECT 1)')),
    sqlite: 'json((SELECT 1))',
    pg: '((SELECT 1))::jsonb',
  },
  {
    helper: 'jsonAgg', site: 'engine/node.ts:270',
    build: (s) => sqlx.jsonAgg(s, raw('value')),
    sqlite: 'json_group_array(value)',
    pg: `COALESCE(jsonb_agg(value), '[]'::jsonb)`,
  },
  {
    helper: 'jsonValid', site: 'engine/agentRetention.ts:54',
    build: (s) => sqlx.jsonValid(s, raw('a.metadata')),
    sqlite: 'json_valid(a.metadata)',
    pg: `pg_input_is_valid((a.metadata)::text, 'jsonb')`,
  },
  {
    helper: 'jsonType', site: 'engine/agentRetention.ts:55',
    build: (s) => sqlx.jsonType(s, raw(`COALESCE(a.metadata, '{}')`)),
    sqlite: `json_type(COALESCE(a.metadata, '{}'))`,
    pg: `jsonb_typeof((COALESCE(a.metadata, '{}'))::jsonb)`,
  },
  {
    helper: 'jsonType (path)', site: 'engine/agentRetention.ts:56',
    build: (s) => sqlx.jsonType(s, raw('a.metadata'), '$.fleet'),
    sqlite: `json_type(a.metadata, '$.fleet')`,
    pg: `jsonb_typeof((a.metadata)::jsonb #> '{fleet}')`,
  },
  {
    helper: 'isInteger', site: '(no call site; inverse of agentRetention.ts:45)',
    build: (s) => sqlx.isInteger(s, raw('a.last_seen')),
    sqlite: `typeof(a.last_seen) = 'integer'`,
    pg: '(a.last_seen) IS NOT NULL',
  },
  {
    helper: 'isNotInteger', site: 'engine/agentRetention.ts:45',
    build: (s) => sqlx.isNotInteger(s, raw('a.last_seen')),
    sqlite: `typeof(a.last_seen) != 'integer'`,
    pg: '(a.last_seen) IS NULL',
  },
  {
    helper: 'castInt', site: 'engine/console.ts:442',
    build: (s) => sqlx.castInt(s, raw(`json_extract(ml.metadata, '$._cost.prompt_tokens')`)),
    sqlite: `CAST(json_extract(ml.metadata, '$._cost.prompt_tokens') AS INTEGER)`,
    pg: `(json_extract(ml.metadata, '$._cost.prompt_tokens'))::bigint`,
  },
  {
    helper: 'castReal', site: 'engine/console.ts:441',
    build: (s) => sqlx.castReal(s, raw(`json_extract(ml.metadata, '$._cost.total_usd')`)),
    sqlite: `CAST(json_extract(ml.metadata, '$._cost.total_usd') AS REAL)`,
    pg: `(json_extract(ml.metadata, '$._cost.total_usd'))::double precision`,
  },
  {
    helper: 'castNumeric', site: 'engine/receipt.ts:35',
    build: (s) => sqlx.castNumeric(s, raw('"dm_participants"."last_read_id"')),
    sqlite: 'CAST("dm_participants"."last_read_id" AS BIGINT)',
    pg: '("dm_participants"."last_read_id")::numeric',
  },
  {
    helper: 'greatest', site: 'engine/sessionMessages.ts:72',
    build: (s) => sqlx.greatest(s, raw('"message_sessions"."last_message_at"'), raw('excluded.last_message_at')),
    sqlite: 'MAX("message_sessions"."last_message_at", excluded.last_message_at)',
    pg: 'GREATEST("message_sessions"."last_message_at", excluded.last_message_at)',
  },
  {
    helper: 'least', site: 'engine/sessionMessages.ts:71',
    build: (s) => sqlx.least(s, raw('"message_sessions"."first_message_at"'), raw('excluded.first_message_at')),
    sqlite: 'MIN("message_sessions"."first_message_at", excluded.first_message_at)',
    pg: 'LEAST("message_sessions"."first_message_at", excluded.first_message_at)',
  },
  {
    helper: 'bool true', site: 'engine/deliveryWrites.ts:103',
    build: (s) => sqlx.bool(s, true),
    sqlite: '1',
    pg: 'true',
  },
  {
    helper: 'bool false', site: 'engine/node.ts:3535',
    build: (s) => sqlx.bool(s, false),
    sqlite: '0',
    pg: 'false',
  },
  {
    helper: 'isDistinct', site: 'engine/agentRetention.ts:49',
    build: (s) => sqlx.isDistinct(s, raw('a.location_type'), raw(`'self_connected'`)),
    sqlite: `a.location_type IS NOT 'self_connected'`,
    pg: `a.location_type IS DISTINCT FROM 'self_connected'`,
  },
  {
    helper: 'isNotDistinct', site: '(no call site)',
    build: (s) => sqlx.isNotDistinct(s, raw('a.x'), raw('b.x')),
    sqlite: 'a.x IS b.x',
    pg: 'a.x IS NOT DISTINCT FROM b.x',
  },
  {
    helper: 'startsWith', site: 'engine/registrationAdmission.ts:39',
    build: (s) => sqlx.startsWith(s, raw('"nodes"."id"'), 'node_direct_'),
    sqlite: `"nodes"."id" GLOB 'node_direct_*'`,
    pg: `starts_with("nodes"."id", 'node_direct_')`,
  },
  {
    helper: 'contains', site: 'engine/inbox.ts:231',
    build: (s) => sqlx.contains(s, raw('"messages"."body"'), '@bob'),
    sqlite: 'instr("messages"."body", ?) > 0',
    sqliteParams: ['@bob'],
    pg: 'strpos("messages"."body", $1) > 0',
    pgParams: ['@bob'],
  },
  {
    helper: 'indexExists', site: 'engine/agentRetention.ts:85',
    build: (s) => sqlx.indexExists(s, ['idx_a', 'idx_b']),
    sqlite: `SELECT name FROM sqlite_master
    WHERE type = 'index' AND name IN (?, ?)`,
    sqliteParams: ['idx_a', 'idx_b'],
    pg: 'SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL',
    pgParams: [['idx_a', 'idx_b']],
  },
  {
    helper: 'indexedBy', site: 'engine/delivery.ts:555',
    build: (s) => sqlx.indexedBy(s, 'idx_deliveries_id_lookup'),
    sqlite: 'INDEXED BY idx_deliveries_id_lookup',
    pg: '',
  },
  {
    helper: 'notIndexed', site: 'engine/inbox.ts:204',
    build: (s) => sqlx.notIndexed(s),
    sqlite: 'NOT INDEXED',
    pg: '',
  },
  {
    helper: 'rowid (bare)', site: 'engine/workspaceDrain.ts:219',
    build: (s) => sqlx.rowid(s),
    sqlite: 'rowid',
    pg: 'rowid',
  },
  {
    helper: 'rowid (table)', site: 'engine/dm.ts:942',
    build: (s) => sqlx.rowid(s, raw('"dm_conversations"')),
    sqlite: '"dm_conversations".rowid',
    pg: '"dm_conversations".rowid',
  },
  {
    helper: 'rowid (alias)', site: '(alias form)',
    build: (s) => sqlx.rowid(s, 'd'),
    sqlite: 'd.rowid',
    pg: 'd.rowid',
  },
];

describe('sqlx helpers', () => {
  for (const c of cases) {
    describe(`${c.helper} (${c.site})`, () => {
      it('renders the pre-rewrite SQLite text', () => {
        expect(lite(c.build('sqlite'))).toEqual({ sql: c.sqlite, params: c.sqliteParams ?? [] });
        // A branded handle dispatches the same as the dialect name.
        expect(lite(c.build({ engineDialect: 'sqlite' }))).toEqual({ sql: c.sqlite, params: c.sqliteParams ?? [] });
      });
      it('renders the PostgreSQL form', () => {
        expect(pg(c.build('pg'))).toEqual({ sql: c.pg, params: c.pgParams ?? [] });
        expect(pg(c.build({ engineDialect: 'pg' }))).toEqual({ sql: c.pg, params: c.pgParams ?? [] });
      });
      for (const [label, source] of UNBRANDED) {
        it(`throws for ${label}`, () => {
          expect(() => c.build(source as sqlx.DialectSource)).toThrow();
        });
      }
    });
  }

  it('rejects malformed JSON paths, aliases, identifiers and prefixes on every dialect', () => {
    for (const d of ['sqlite', 'pg'] as const) {
      expect(() => sqlx.jsonGet(d, raw('x'), `$.a'); DROP TABLE t; --`)).toThrow();
      expect(() => sqlx.jsonGet(d, raw('x'), '$[0]')).toThrow();
      expect(() => sqlx.jsonEach(d, raw('x'), { alias: ' AS a; --', elements: 'text' })).toThrow();
      expect(() => sqlx.indexedBy(d, 'idx; DROP')).toThrow();
      expect(() => sqlx.indexExists(d, ['ok', 'bad name'])).toThrow();
      expect(() => sqlx.rowid(d, 'a.b')).toThrow();
      expect(() => sqlx.startsWith(d, raw('x'), `a'*`)).toThrow();
    }
  });
});

describe('sqlx.lockSeq', () => {
  const targets: sqlx.SeqLockTarget[] = [
    { kind: 'workspace_event', workspaceId: 'ws1' },
    { kind: 'session_event', agentId: 'ag1' },
    { kind: 'delivery', workspaceId: 'ws1', agentIds: ['b', 'a'] },
    { kind: 'delivery', workspaceId: 'ws1', agentIds: sql`SELECT agent_id FROM channel_members WHERE channel_id = ${'c1'}` },
  ];

  it('is an empty statement on SQLite and a no-op lock there', () => {
    for (const target of targets) expect(lite(sqlx.lockSeq('sqlite', target))).toEqual({ sql: '', params: [] });
    expect(sqlx.isNoopLock('sqlite')).toBe(true);
    expect(sqlx.isNoopLock('pg')).toBe(false);
    expect(sqlx.inPgTransaction('sqlite')).toBe(false);
    expect(sqlx.inPgTransaction('pg')).toBe(false);
  });

  it('takes a per-workspace advisory transaction lock for workspace events', () => {
    expect(pg(sqlx.lockSeq('pg', targets[0]!))).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', params: ['we:ws1'],
    });
  });

  it('takes a per-agent advisory transaction lock for session events', () => {
    expect(pg(sqlx.lockSeq('pg', targets[1]!))).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', params: ['se:ag1'],
    });
  });

  it('locks recipient agent rows in id order for deliveries', () => {
    expect(pg(sqlx.lockSeq('pg', targets[2]!))).toEqual({
      sql: 'SELECT id FROM agents WHERE workspace_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE',
      params: ['ws1', ['b', 'a']],
    });
    expect(pg(sqlx.lockSeq('pg', targets[3]!))).toEqual({
      sql: 'SELECT id FROM agents WHERE workspace_id = $1 AND id IN (SELECT agent_id FROM channel_members WHERE channel_id = $2) ORDER BY id FOR UPDATE',
      params: ['ws1', 'c1'],
    });
  });

  it('throws for unbranded sources and unknown lock kinds', () => {
    for (const [, source] of UNBRANDED) {
      expect(() => sqlx.lockSeq(source as sqlx.DialectSource, targets[0]!)).toThrow();
      expect(() => sqlx.isNoopLock(source as sqlx.DialectSource)).toThrow();
      expect(() => sqlx.inPgTransaction(source as sqlx.DialectSource)).toThrow();
    }
    expect(() => sqlx.lockSeq('pg', { kind: 'nope' } as unknown as sqlx.SeqLockTarget)).toThrow(/unknown lock kind/);
  });
});

describe('sqlx.requireSqlite', () => {
  it('passes on SQLite and throws a typed unsupported_on_postgres error on PostgreSQL', () => {
    expect(() => sqlx.requireSqlite('sqlite', 'feature')).not.toThrow();
    let caught: unknown;
    try { sqlx.requireSqlite({ engineDialect: 'pg' }, 'feature'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(sqlx.UnsupportedOnPostgresError);
    expect(caught).toMatchObject({ code: 'unsupported_on_postgres', feature: 'feature' });
  });

  it('throws for unbranded sources', () => {
    for (const [, source] of UNBRANDED) expect(() => sqlx.requireSqlite(source as sqlx.DialectSource, 'f')).toThrow();
  });
});

describe('rowid retention cursorStore on PostgreSQL', () => {
  it('rejects with unsupported_on_postgres before touching the database or cursor store', async () => {
    const touched: string[] = [];
    const pgHandle = new Proxy({ engineDialect: 'pg' }, {
      get(target, key) {
        if (key in target) return (target as Record<PropertyKey, unknown>)[key];
        touched.push(String(key));
        return undefined;
      },
    }) as unknown as Parameters<typeof pruneRowidPages>[0];
    const cursorStore = {
      load: async () => { touched.push('load'); return undefined; },
      save: async () => { touched.push('save'); },
    };
    await expect(pruneRowidPages(pgHandle, { cursorStore })).rejects.toMatchObject({ code: 'unsupported_on_postgres' });
    await expect(pruneExpired(pgHandle, { cursorStore })).rejects.toBeInstanceOf(sqlx.UnsupportedOnPostgresError);
    expect(touched).toEqual([]);
  });
});
