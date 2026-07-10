import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../database.js';
import { runAtomicWrites } from '../../../ports/database.js';
import { pendingEvents, workspaces } from '../../../db/schema.js';

let seq = 0;
const handles: SqliteDbHandle[] = [];
const dirs: string[] = [];

function openMemory(): SqliteDbHandle['db'] {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  handles.push(handle);
  return handle.db;
}

function openFile(): SqliteDbHandle['db'] {
  const dir = mkdtempSync(join(tmpdir(), 'relaycast-write-gate-'));
  dirs.push(dir);
  const handle = getSqliteDb(join(dir, 'engine.db'));
  runMigrations(handle);
  handles.push(handle);
  return handle.db;
}

async function seedWorkspace(db: SqliteDbHandle['db']): Promise<string> {
  const id = `ws_${++seq}`;
  await db.insert(workspaces).values({ id, name: 'test', apiKeyHash: `hash_${id}` });
  return id;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.sqlite.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('self-host write gate', () => {
  // A prebuilt statement is bound to the connection that built it. On the
  // file-backed backend the transaction runs on a separate connection, so a
  // prebuilt array cannot execute inside it — awaiting one there would queue
  // behind the very transaction awaiting it. The gate rejects loudly instead of
  // hanging.
  it('rejects prebuilt atomic-write arrays inside a transaction (file-backed) rather than deadlocking', async () => {
    const db = openFile();
    const ws = await seedWorkspace(db);
    const prebuilt = [
      db.insert(pendingEvents).values({ id: `evt_${++seq}`, workspaceId: ws, eventType: 'x', payload: {} }),
    ];
    await expect(runAtomicWrites(db, prebuilt)).rejects.toThrow(/inside a transaction/);
    // The failed transaction rolled back: no row leaked.
    expect(await db.select().from(pendingEvents)).toHaveLength(0);
  });

  // The builder form rebuilds statements on the transaction handle, so it is
  // unaffected and commits normally.
  it('runs the builder form atomically (file-backed)', async () => {
    const db = openFile();
    const ws = await seedWorkspace(db);
    const id = `evt_${++seq}`;
    await runAtomicWrites(db, (tx) => [
      tx.insert(pendingEvents).values({ id, workspaceId: ws, eventType: 'ok', payload: {} }),
    ]);
    expect(await db.select().from(pendingEvents).where(eq(pendingEvents.id, id))).toHaveLength(1);
  });

  // `:memory:` is connection-local (no isolated transaction connection), so the
  // prebuilt array form is safe there and must keep working.
  it('runs prebuilt atomic-write arrays on :memory:', async () => {
    const db = openMemory();
    const ws = await seedWorkspace(db);
    const id = `evt_${++seq}`;
    await runAtomicWrites(db, [
      db.insert(pendingEvents).values({ id, workspaceId: ws, eventType: 'mem', payload: {} }),
    ]);
    expect(await db.select().from(pendingEvents).where(eq(pendingEvents.id, id))).toHaveLength(1);
  });

  // A prepared write executes through the gate (not a bypass) and persists.
  it('gates prepared write statements (file-backed)', async () => {
    const db = openFile();
    const ws = await seedWorkspace(db);
    const id = `evt_${++seq}`;
    const stmt = db
      .insert(pendingEvents)
      .values({ id, workspaceId: ws, eventType: 'prepared', payload: {} })
      .prepare();
    await stmt.run();
    expect(await db.select().from(pendingEvents).where(eq(pendingEvents.id, id))).toHaveLength(1);
  });

  // Raw SQL executed directly through the handle (`db.run`) still lands.
  it('gates raw db.run writes (file-backed)', async () => {
    const db = openFile();
    const ws = await seedWorkspace(db);
    const id = `evt_${++seq}`;
    await db.insert(pendingEvents).values({ id, workspaceId: ws, eventType: 'raw', payload: {} });
    const rows = await db.select().from(pendingEvents).where(eq(pendingEvents.id, id));
    expect(rows).toHaveLength(1);
  });
});
