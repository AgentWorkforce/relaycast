import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_LIVENESS_TTL_MS, listAgents } from '../../engine/agent.js';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';

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
  let stack: TestStack;
  let workspaceId: string;
  let workspaceKey: string;

  beforeEach(async () => {
    stack = makeNodeStack();
    ({ workspaceId, workspaceKey } = await createWorkspace(stack.app, 'roster-read-contract'));
    const other = await createWorkspace(stack.app, 'other-roster');
    const insert = stack.runtime.handle.sqlite.prepare(`
      INSERT INTO agents (id, workspace_id, name, token_hash, status, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const scope of [workspaceId, other.workspaceId]) {
      for (const row of fixtures) {
        const id = `${scope}-${row.name}`;
        insert.run(id, scope, row.name, `test-hash-${id}`, row.status, row.lastSeen);
      }
    }
    // Reject even zero-row UPDATEs, not just observable status changes.
    stack.runtime.handle.sqlite.pragma('query_only = ON');
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
        const sqlite = stack.runtime.handle.sqlite;
        const prepare = sqlite.prepare.bind(sqlite);
        const materialized: number[] = [];
        vi.spyOn(sqlite, 'prepare').mockImplementation((source: string) => {
          const statement = prepare(source);
          if (/from "agents"/i.test(source)) {
            const all = statement.all.bind(statement);
            vi.spyOn(statement, 'all').mockImplementation((...params: unknown[]) => {
              const rows = all(...params);
              materialized.push(rows.length);
              return rows;
            });
          }
          return statement;
        });
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
        // loading every row. Count actual SQLite results to catch that cost.
        expect(materialized).toEqual([expected.length]);
      },
    );
  }

  it('uses one presence snapshot when a SELECT crosses the TTL boundary', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const sqlite = stack.runtime.handle.sqlite;
    const prepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, 'prepare').mockImplementation((source: string) => {
      const statement = prepare(source);
      if (/from "agents"/i.test(source)) clock.mockReturnValue(NOW + 1_000);
      return statement;
    });
    const roster = await listAgents(stack.runtime.deps.db, workspaceId, 'active');
    expect(roster.filter((row) => row.name.startsWith('boundary-')).map((row) => row.status))
      .toEqual(['active', 'active']);
    expect(roster.every((row) => row.status === 'active')).toBe(true);
  });

  it('serves repeated roster and detail reads with writes disabled and leaves stored presence untouched', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 1);
    const sqlite = stack.runtime.handle.sqlite;
    const snapshot = () => sqlite.prepare('SELECT id, status, last_seen FROM agents ORDER BY id').all();
    const before = snapshot();
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
    expect(snapshot()).toEqual(before);
  });
});

describe('agent roster row visits', () => {
  it('skips released history and seeks live status ranges within one workspace', async () => {
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
