// Synthetic local-only allocation model. Never connects to D1 or copies user data.
// Usage: node scripts/measure-compact-migrations.mjs [rows=100000] [activeFraction=0.5]
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rows = Number(process.argv[2] ?? 100000);
const activeFraction = Number(process.argv[3] ?? 0.5);
if (!Number.isInteger(rows) || rows < 1000 || rows > 200000 || !Number.isFinite(activeFraction) || activeFraction < 0 || activeFraction > 1) {
  throw new Error('Expected 1000..200000 rows and activeFraction 0..1');
}
const directory = fileURLToPath(new URL('../packages/engine/src/db/migrations/', import.meta.url));
const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
const sql = name => readFileSync(directory + name, 'utf8');
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
for (const file of files.filter(name => name < '0048')) db.exec(sql(file));
db.exec(`INSERT INTO workspaces(id,name,api_key_hash) VALUES ('workspace11','fixture','key');
  INSERT INTO nodes(id,workspace_id,name,token_hash) VALUES ('node0000011','workspace11','node','node-key');
  INSERT INTO agents(id,workspace_id,name,token_hash) VALUES ('agent0000000000000','workspace11','agent','agent-key');
  INSERT INTO channels(id,workspace_id,name) VALUES ('channel','workspace11','general');`);
const message = db.prepare("INSERT INTO messages(id,workspace_id,channel_id,agent_id,body) VALUES (?,'workspace11','channel','agent0000000000000','synthetic')");
const delivery = db.prepare(`INSERT INTO deliveries(id,workspace_id,message_id,agent_id,status,seq,route_node_id,route_node_kind,expires_at)
  VALUES (?,'workspace11',?,'agent0000000000000',?,?,'node0000011','ws',1788000000)`);
const event = db.prepare("INSERT INTO workspace_events(workspace_id,seq,type,payload) VALUES ('workspace11',?,'message.created','{}')");
db.transaction(() => {
  for (let n = 1; n <= rows; n++) {
    const id = String(n).padStart(20, '0');
    message.run(id);
    delivery.run('d_' + id + '_agent0000000000000', id, n / rows <= activeFraction ? 'queued' : 'dead_lettered', n);
    if (n % 2 === 0) event.run(n / 2);
  }
})();
const size = () => Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true }));
const baseline = size();
// Roll back the legacy comparison, including the allocation it caused.
db.exec('BEGIN');
db.exec(sql('0048_bounded_maintenance.sql'));
db.exec(sql('0049_redrive_review_hardening.sql'));
const legacyPeak = size();
db.exec('ROLLBACK');
let compactPeak = size();
const steps = [];
db.exec('BEGIN');
for (const statement of sql('0050_compact_maintenance_indexes.sql').replace(/^--.*$/gm, '').split(';').filter(part => part.trim())) {
  db.exec(statement);
  compactPeak = Math.max(compactPeak, size());
  steps.push({ operation: statement.trim().split('\n')[0], allocatedBytes: size() });
}
db.exec('COMMIT');
const legacyGrowth = legacyPeak - baseline;
const compactGrowth = compactPeak - baseline;
console.log(JSON.stringify({
  scenario: { rows, activeFraction, eventRows: rows / 2, deliveryIdBytes: 41, workspaceIdBytes: 11, agentIdBytes: 18 },
  baseline, legacyPeak, compactPeak, legacyGrowth, compactGrowth,
  growthReductionPercent: 100 * (1 - compactGrowth / legacyGrowth),
  projectedCompactGrowthAt8m: compactGrowth * 8000000 / rows,
  caveat: 'Local synthetic projection, not production capacity proof. Includes one synthetic message per delivery and one event per two deliveries. Does not bound D1 build duration or concurrent growth.',
  steps,
}, null, 2));
db.close();
