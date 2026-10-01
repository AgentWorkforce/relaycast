// Synthetic local evidence only. Usage after engine build:
// node scripts/test-support/seed-agent-retention.mjs /tmp/retention-demo.db
import { existsSync } from 'node:fs';
import { getSqliteDb, runMigrations } from '../../packages/engine/dist/adapters/node/database.js';

const path = process.argv[2];
if (!path || existsSync(path)) throw new Error('Provide a new SQLite fixture path');
const handle = getSqliteDb(path);
try {
  runMigrations(handle);
  const db = handle.sqlite;
  const old = Math.floor(Date.now() / 1000) - 60 * 86400;
  const recent = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    db.prepare("INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws_retention_demo','Synthetic retention fixture','fixture-only')").run();
    db.prepare("INSERT INTO nodes(id,workspace_id,name,token_hash,status,role) VALUES ('broker_demo','ws_retention_demo','broker','broker-fixture','offline','broker')").run();
    db.prepare("INSERT INTO channels(id,workspace_id,name) VALUES ('ch_demo','ws_retention_demo','history')").run();
    const agent = db.prepare(`INSERT INTO agents(id,workspace_id,name,token_hash,status,created_at,last_seen,location_node_id)
      VALUES (?,'ws_retention_demo',?,?,?, ?,?,?)`);
    const message = db.prepare("INSERT INTO messages(id,workspace_id,channel_id,agent_id,body) VALUES (?,'ws_retention_demo','ch_demo',?,'Synthetic retained history')");
    for (let i = 0; i < 2628; i++) {
      const id = `demo-${String(i).padStart(4, '0')}`;
      agent.run(id, id, id, i >= 2595 ? 'active' : 'offline', old, i >= 2570 ? recent : old,
        i >= 2500 && i < 2550 ? 'broker_demo' : null);
      if (i >= 2550 && i < 2570) message.run(`message-${i}`, id);
    }
  })();
  console.log(JSON.stringify({ source: 'synthetic fixture; not production', workspace_id: 'ws_retention_demo',
    agents: 2628, expected: { eligible: 2500, ownership_protected: 50, history_referenced: 20, recent_or_unknown: 25, not_offline: 33 } }));
} finally {
  handle.sqlite.close();
}
