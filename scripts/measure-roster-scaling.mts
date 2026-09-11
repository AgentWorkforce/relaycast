// Local, synthetic data only. Run: npx tsx scripts/measure-roster-scaling.mts
// Counts candidate visits through the real engine functions. Timings describe
// this machine's SQLite/JS work; they do not model D1 queueing or network cost.
import assert from 'node:assert/strict';
import { getSqliteDb, runMigrations } from '../packages/engine/src/adapters/node/database.js';
import { getPublicNode, listNodes } from '../packages/engine/src/engine/node.js';
import { listAgents } from '../packages/engine/src/engine/agent.js';

const results = [];
for (const staleRows of [0, 100, 1_000, 6_274, 12_548]) {
  const handle = getSqliteDb(':memory:');
  const { sqlite, db } = handle;
  try {
    runMigrations(handle);
    sqlite.exec("INSERT INTO workspaces(id,name,api_key_hash) VALUES ('measured','measured','key1'),('control','control','key2')");
    const node = sqlite.prepare(`INSERT INTO nodes
      (id, workspace_id, name, token_hash, role, status, last_heartbeat_at, capabilities, tags)
      VALUES (?, ?, ?, ?, 'broker', ?, ?, ?, ?)`);
    const agent = sqlite.prepare(`INSERT INTO agents
      (id, workspace_id, name, token_hash, status, last_seen) VALUES (?, ?, ?, ?, ?, ?)`);
    const now = Math.floor(Date.now() / 1_000);
    sqlite.transaction(() => {
      for (const workspace of ['measured', 'control']) {
        for (let n = 0; n < 13 + staleRows; n++) {
          const id = `${workspace}-${String(n).padStart(6, '0')}`;
          const live = n < 13;
          node.run(id, workspace, id, id, live ? 'online' : 'offline', live ? now : now - 86_400,
            JSON.stringify(live ? ['spawn:test'] : []), JSON.stringify(['synthetic']));
          agent.run(id, workspace, id, id, live ? 'active' : 'offline', live ? now : now - 86_400);
        }
      }
    })();
    let visits = 0;
    sqlite.function('record_roster_visit', () => { visits++; return 1; });
    sqlite.exec(`ALTER TABLE nodes RENAME TO retained_nodes;
      CREATE VIEW nodes AS SELECT * FROM retained_nodes WHERE record_roster_visit() = 1;
      ALTER TABLE agents RENAME TO retained_agents;
      CREATE VIEW agents AS SELECT * FROM retained_agents WHERE record_roster_visit() = 1;
      PRAGMA query_only = ON;`);
    const cases = [
      { name: 'nodes_all', read: () => listNodes(db, 'measured'), count: 13 + staleRows, visits: 13 + staleRows },
      { name: 'nodes_name_filter', read: () => listNodes(db, 'measured', { name: 'measured-000000' }), count: 1, visits: 13 + staleRows },
      { name: 'nodes_capability_filter', read: () => listNodes(db, 'measured', { capability: 'spawn:test' }), count: 13, visits: 13 + staleRows },
      { name: 'node_detail', read: async () => [await getPublicNode(db, 'measured', 'measured-000000')], count: 1, visits: 1 },
      { name: 'agents_all', read: () => listAgents(db, 'measured'), count: 13 + staleRows, visits: 13 + staleRows },
      { name: 'agents_active', read: () => listAgents(db, 'measured', 'active'), count: 13, visits: 13 },
    ];
    for (const scenario of cases) {
      await scenario.read(); // Warm up separately from the measured reads.
      const ms = [];
      let bytes = 0;
      for (let attempt = 0; attempt < 7; attempt++) {
        visits = 0;
        const start = performance.now();
        const rows = await scenario.read();
        bytes = Buffer.byteLength(JSON.stringify({ ok: true, data: rows }));
        ms.push(performance.now() - start);
        assert.equal(rows.length, scenario.count, scenario.name);
        assert.equal(visits, scenario.visits, scenario.name);
      }
      ms.sort((a, b) => a - b);
      results.push({ stale_rows: staleRows, workspace_rows: staleRows + 13,
        total_table_rows: 2 * (staleRows + 13), scenario: scenario.name,
        candidate_visits: visits, returned_rows: scenario.count, response_bytes: bytes,
        local_ms: { min: ms[0], median: ms[3], max: ms[6] } });
    }
  } finally {
    sqlite.close();
  }
}
console.log(JSON.stringify({ measured_at: new Date().toISOString(), repetitions: 7,
  method: 'Synthetic in-memory SQLite with repository migrations, real engine reads, nondeterministic candidate-visit views, query_only enabled; timings include hydration and JSON serialization.',
  results }, null, 2));
