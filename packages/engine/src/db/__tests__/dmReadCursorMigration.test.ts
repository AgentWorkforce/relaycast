import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { getSqliteDb, runMigrations } from '../../adapters/node/database.js';

it('seeds DM read cursors from the newest read receipt, ordered numerically', () => {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const handle = getSqliteDb(':memory:');
  const db = handle.sqlite;
  try {
    db.exec('CREATE TABLE _engine_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && name < '0078').sort()) {
      db.exec(readFileSync(directory + name, 'utf8'));
      db.prepare('INSERT INTO _engine_migrations VALUES (?,0)').run(name);
    }
    // 17 nines sort after the 18-digit id as text, and before it numerically.
    const older = '9'.repeat(17);
    const newer = '1' + '0'.repeat(17);
    db.exec(`INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','fixture','key');
      INSERT INTO agents(id,workspace_id,name,token_hash) VALUES ('alice','ws','alice','a'),('bob','ws','bob','b'),('cara','ws','cara','c');
      INSERT INTO channels(id,workspace_id,name,channel_type) VALUES ('dmch','ws','dm-alice-bob',1),('gen','ws','general',0);
      INSERT INTO dm_conversations(id,workspace_id,channel_id) VALUES ('dm','ws','dmch');
      INSERT INTO dm_participants(conversation_id,agent_id) VALUES ('dm','alice'),('dm','bob');
      INSERT INTO messages(id,workspace_id,channel_id,agent_id,body) VALUES
        ('${older}','ws','dmch','alice','older'),('${newer}','ws','dmch','alice','newer'),
        ('2${'0'.repeat(17)}','ws','gen','cara','channel');
      INSERT INTO read_receipts(message_id,agent_id) VALUES
        ('${older}','bob'),('${newer}','bob'),('2${'0'.repeat(17)}','alice');`);

    expect(runMigrations(handle).applied).toEqual(['0078_dm_participant_read_cursor.sql', '0079_credential_upgrades.sql']);

    const cursors = db.prepare('SELECT agent_id, last_read_id FROM dm_participants ORDER BY agent_id').all();
    // A receipt in another channel does not seed a DM cursor.
    expect(cursors).toEqual([
      { agent_id: 'alice', last_read_id: null },
      { agent_id: 'bob', last_read_id: newer },
    ]);
  } finally {
    db.close();
  }
});
