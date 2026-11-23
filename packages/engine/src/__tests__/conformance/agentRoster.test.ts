import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_LIVENESS_TTL_MS, AGENT_ROSTER_RECENCY_MS, RELEASED_AGENT_STATUS, listAgents } from '../../engine/agent.js';
import {
  createWorkspace, interceptStatements, makeNodeStack, observeStatementRows, pgMode, rawAll, rawRun, rejectWrites, type TestStack,
} from './harness.js';

// bun:sqlite (the standalone binary's driver, under `npm run test:bun`) has no
// user-defined SQL functions, which this visit-counting probe relies on.
const userFunctions = !process.versions.bun;

// SQLite stores last_seen in whole seconds. Exercise both the exact TTL
// boundary and fractional-second request times, which must expire that row.
const NOW = 1_800_000_000_000;
const CUTOFF = (NOW - AGENT_LIVENESS_TTL_MS) / 1_000;
const fixtures = [
  { name: 'fresh-active', status: 'active', lastSeen: NOW / 1_000 },
  { name: 'fresh-online', status: 'online', lastSeen: NOW / 1_000 },
  { name: 'stale-active', status: 'active', lastSeen: CUTOFF - 1 },
  { name: 'stale-online', status: 'online', lastSeen: CUTOFF - 1 },
  { name: 'boundary-active', status: 'active', lastSeen: CUTOFF },
  { name: 'boundary-online', status: 'online', lastSeen: CUTOFF },
  { name: 'future-active', status: 'active', lastSeen: NOW / 1_000 + 3_600 },
  { name: 'future-online', status: 'online', lastSeen: NOW / 1_000 + 3_600 },
  ...['offline', 'idle', 'blocked', 'waiting', 'released'].flatMap((status) => [
    { name: `fresh-${status}`, status, lastSeen: NOW / 1_000 },
    { name: `stale-${status}`, status, lastSeen: CUTOFF - 1 },
  ]),
];

function expectedRoster(offset: number) {
  return fixtures.filter((row) => row.status !== 'released').map((row) => ({
    name: row.name,
    status: row.status === 'active' || row.status === 'online'
      ? row.name.startsWith('stale-') || (offset > 0 && row.name.startsWith('boundary-'))
        ? 'offline' : 'active'
      : row.status,
  }));
}

describe('agent roster read contract', () => {
  it('pins the released status used literally by the query and partial index', () => {
    expect(RELEASED_AGENT_STATUS).toBe('released');
  });

  let stack: TestStack;
  let workspaceId: string;
  let workspaceKey: string;

  beforeEach(async () => {
    stack = makeNodeStack();
    ({ workspaceId, workspaceKey } = await createWorkspace(stack.app, 'roster-read-contract'));
    const other = await createWorkspace(stack.app, 'other-roster');
    for (const scope of [workspaceId, other.workspaceId]) {
      for (const row of fixtures) {
        const id = `${scope}-${row.name}`;
        await rawRun(stack.runtime.deps.db, `
      INSERT INTO agents (id, workspace_id, name, token_hash, status, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, scope, row.name, `test-hash-${id}`, row.status, row.lastSeen]);
      }
    }
    // Reject even zero-row UPDATEs, not just observable status changes.
    rejectWrites(stack);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stack.close();
  });

  for (const offset of [0, 1, 999]) {
    it.each([undefined, '', 'all', 'active', 'online', 'offline', 'idle', 'blocked', 'waiting', 'released', 'unknown'])(
      `filters status=%s in SQL with the same presence at TTL + ${offset}ms`,
      async (status) => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW + offset);
        const materialized: number[] = [];
        observeStatementRows(stack, /from "agents"/i, (_source, rows) => { materialized.push(rows); });
        const query = status === undefined ? '' : `?status=${status}`;
        const response = await stack.app.request(`/v1/agents${query}`, {
          headers: { authorization: `Bearer ${workspaceKey}` },
        });
        expect(response.status).toBe(200);
        const body = await response.json() as { ok: boolean; data: Array<{ name: string; status: string }> };
        const requested = status === 'online' ? 'active' : status;
        const expected = expectedRoster(offset).filter((row) => !requested || requested === 'all' || row.status === requested);
        expect(body.ok).toBe(true);
        expect(body.data.map(({ name, status }) => ({ name, status })).sort((a, b) => a.name.localeCompare(b.name)))
          .toEqual(expected.sort((a, b) => a.name.localeCompare(b.name)));
        // A JS post-filter can return the right API response while still
        // loading every row. Count actual database results to catch that cost.
        expect(materialized).toEqual([expected.length]);
      },
    );
  }

  it('uses one presence snapshot when a SELECT crosses the TTL boundary', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    interceptStatements(stack, (source) => {
      if (/from "agents"/i.test(source)) clock.mockReturnValue(NOW + 1_000);
    });
    const roster = await listAgents(stack.runtime.deps.db, workspaceId, 'active');
    expect(roster.filter((row) => row.name.startsWith('boundary-')).map((row) => row.status))
      .toEqual(['active', 'active']);
    expect(roster.every((row) => row.status === 'active')).toBe(true);
  });

  it('serves repeated roster and detail reads with writes disabled and leaves stored presence untouched', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 1);
    const snapshot = () => rawAll(stack.runtime.deps.db, 'SELECT id, status, last_seen FROM agents ORDER BY id');
    const before = await snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const expected of expectedRoster(1)) {
        const response = await stack.app.request(`/v1/agents/${expected.name}`, {
          headers: { authorization: `Bearer ${workspaceKey}` },
        });
        expect(response.status).toBe(200);
        const body = await response.json() as { data: { name: string; status: string } };
        expect(body.data).toMatchObject(expected);
      }
      expect(await listAgents(stack.runtime.deps.db, workspaceId)).toHaveLength(expectedRoster(1).length);
      const missing = await stack.app.request('/v1/agents/missing', {
        headers: { authorization: `Bearer ${workspaceKey}` },
      });
      expect(missing.status).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('agent roster recency and projection', () => {
  it('bounds default/all reads in SQL, preserves desktop metadata, and leaves history accessible', async () => {
    const stack = makeNodeStack();
    const { workspaceId, workspaceKey } = await createWorkspace(stack.app, 'recent-roster');
    const other = await createWorkspace(stack.app, 'other-recent-roster');
    const cutoff = (NOW - AGENT_ROSTER_RECENCY_MS) / 1_000;
    const metadata = { cli: 'codex', host: 'finn-mini', session_id: 'session', objective: 'investigate', padding: 'x'.repeat(10_000) };
    for (const scope of [workspaceId, other.workspaceId]) {
      for (const [name, status, lastSeen] of [
        ['old', 'offline', cutoff - 1], ['boundary', 'offline', cutoff],
        ['recent', 'active', NOW / 1_000], ['released', 'released', NOW / 1_000],
      ] as const) {
        await rawRun(stack.runtime.deps.db, `INSERT INTO agents(id, workspace_id, name, token_hash, status, last_seen, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [scope + name, scope, name, scope + name, status, lastSeen, JSON.stringify(metadata)]);
      }
    }
    const queries: string[] = [];
    const materialized: number[] = [];
    observeStatementRows(stack, /from "agents"/i, (source, rows) => {
      queries.push(source);
      materialized.push(rows);
    });
    rejectWrites(stack);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const read = async (query = '') => {
      const response = await stack.app.request(`/v1/agents${query}`, { headers: { authorization: `Bearer ${workspaceKey}` } });
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ name: string; metadata: Record<string, unknown> }> };
      return body.data;
    };
    try {
      for (const query of ['', '?status=all', '?status=all&include_stale=0']) {
        const rows = await read(query);
        expect(rows.map(row => row.name).sort()).toEqual(['boundary', 'recent']);
        // pg: jsonb keeps its own key order, so the document itself must match there.
        expect(rows.every(row => pgMode
          ? isDeepStrictEqual(row.metadata, metadata)
          : JSON.stringify(row.metadata) === JSON.stringify(metadata))).toBe(true);
        expect(materialized.at(-1)).toBe(2);
        expect(queries.at(-1)).not.toMatch(/token_hash|session_ref|delivery_seq/);
      }
      expect((await read('?status=all&include_stale=1')).map(row => row.name).sort()).toEqual(['boundary', 'old', 'recent']);
      expect(materialized.at(-1)).toBe(3);
      expect((await read('?status=offline')).map(row => row.name).sort()).toEqual(['boundary', 'old']);
      const lean = await read('?include_metadata=0');
      expect(lean.every(row => JSON.stringify(row.metadata) === '{}')).toBe(true);
      expect(queries.at(-1)).not.toContain('"agents"."metadata"');
      expect((await read('?include_metadata=1'))[0].metadata).toEqual(metadata);
      vi.mocked(Date.now).mockReturnValue(NOW + 1);
      expect((await read()).map(row => row.name)).toEqual(['recent']);
      const historical = await stack.app.request('/v1/agents/old', { headers: { authorization: `Bearer ${workspaceKey}` } });
      expect(historical.status).toBe(200);
      for (const query of ['include_stale=true', 'include_metadata=false']) {
        const invalid = await stack.app.request(`/v1/agents?${query}`, { headers: { authorization: `Bearer ${workspaceKey}` } });
        expect(invalid.status).toBe(400);
      }
    } finally {
      vi.restoreAllMocks();
      await stack.close();
    }
  });
});

describe('agent roster row visits', () => {
  // Counts SQLite planner row visits through a user-defined function behind a
  // view over the renamed table; PostgreSQL's planner has no equivalent probe.
  it.skipIf(!userFunctions || pgMode)('skips released history and seeks live status ranges within one workspace', async () => {
    const stack = makeNodeStack();
    const { workspaceId, workspaceKey } = await createWorkspace(stack.app, 'roster-row-visits');
    const other = await createWorkspace(stack.app, 'other-row-visits');
    const sqlite = stack.runtime.handle.sqlite;
    const insert = sqlite.prepare(`
      INSERT INTO agents (id, workspace_id, name, token_hash, status, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    sqlite.transaction(() => {
      for (const scope of [workspaceId, other.workspaceId]) {
        for (let n = 0; n < 10_000; n++) {
          const id = `${scope}-${n}`;
          insert.run(id, scope, id, id, 'released', CUTOFF - 1);
        }
        for (const row of fixtures) {
          const id = `${scope}-${row.name}`;
          insert.run(id, scope, row.name, id, row.status, row.lastSeen);
        }
        for (let n = 0; n < 1_000; n++) {
          const id = `${scope}-stale-${n}`;
          insert.run(id, scope, id, id, 'active', CUTOFF - 1);
        }
      }
    })();

    // A non-deterministic predicate counts candidate visits before hydration;
    // the view keeps the real indexes available to SQLite's query planner.
    let visits = 0;
    sqlite.function('record_roster_visit', () => { visits++; return 1; });
    sqlite.exec(`
      ALTER TABLE agents RENAME TO retained_agents;
      CREATE VIEW agents AS
        SELECT * FROM retained_agents WHERE record_roster_visit() = 1;
      PRAGMA query_only = ON;
    `);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      for (const status of [undefined, 'active', 'online', 'idle', 'blocked', 'waiting', 'released', 'unknown']) {
        visits = 0;
        const query = status === undefined ? '' : `?status=${status}`;
        const response = await stack.app.request(`/v1/agents${query}`, {
          headers: { authorization: `Bearer ${workspaceKey}` },
        });
        expect(response.status).toBe(200);
        const body = await response.json() as { data: Array<{ name: string; status: string }> };
        const expectedStatus = status === 'online' ? 'active' : status;
        const expected = expectedRoster(0).filter(row => !expectedStatus || row.status === expectedStatus);
        const expectedCount = expected.length + (status === undefined ? 1_000 : 0);
        expect(body.data).toHaveLength(expectedCount);
        expect(visits, `candidate visits for status=${status}`).toBe(expectedCount);
      }
    } finally {
      vi.restoreAllMocks();
      await stack.close();
    }
  });
});
