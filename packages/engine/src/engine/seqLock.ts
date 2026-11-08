/**
 * Serialized sequence allocation.
 *
 * Engine sequences (`deliveries.seq` per agent, `workspace_events.seq` per
 * workspace, `session_events.sequence` per agent) are allocated with
 * `MAX(...) + 1` inside the inserting statement. SQLite serializes writers, so
 * that is race-free there and nothing here changes SQLite behaviour: no
 * statement is added and no transaction is opened. PostgreSQL runs writers
 * concurrently, so the allocating insert must run in a transaction after
 * {@link sqlx.lockSeq}'s lock statement.
 */
import type { SQLWrapper } from 'drizzle-orm';
import { requireTransactionCapability, runAtomic, type AtomicWrite, type EngineDb } from '../ports/database.js';
import * as sqlx from '../db/sqlx.js';

/**
 * Run `fn` with the sequence lock for `target` held. SQLite: `fn(db)` as is.
 * PostgreSQL: inside the caller's transaction when `db` already is one,
 * otherwise in a new transaction (the handle must have withTransaction).
 */
export async function withSeqLock<T>(
  db: EngineDb,
  target: sqlx.SeqLockTarget | readonly sqlx.SeqLockTarget[],
  fn: (db: EngineDb) => PromiseLike<T>,
): Promise<T> {
  if (sqlx.isNoopLock(db)) return await fn(db);
  const targets = Array.isArray(target) ? target as readonly sqlx.SeqLockTarget[] : [target as sqlx.SeqLockTarget];
  const locked = async (tx: EngineDb) => {
    for (const each of targets) await sqlx.run(tx, sqlx.lockSeq(tx, each));
    return fn(tx);
  };
  if (sqlx.inPgTransaction(db)) return locked(db);
  requireTransactionCapability(db);
  return runAtomic(db, locked);
}

/**
 * An atomic write whose execution first takes the sequence lock for `target`.
 * SQLite: `write` itself, unchanged. PostgreSQL: a write that runs the lock
 * statement and then `write`, resolving to `write`'s result; `db` must be the
 * transaction handle the write was built from (runAtomicWrites builds
 * statements from its transaction), so the lock is held until commit.
 */
export function seqLockedWrite(db: EngineDb, target: sqlx.SeqLockTarget, write: AtomicWrite): AtomicWrite {
  if (sqlx.isNoopLock(db)) return write;
  if (!sqlx.inPgTransaction(db)) {
    throw new Error(
      `Sequence-allocating ${target.kind} write must be built from a PostgreSQL transaction handle (use runAtomicWrites with withTransaction)`,
    );
  }
  const lock = sqlx.lockSeq(db, target);
  const locked: SQLWrapper & PromiseLike<unknown> = {
    getSQL: () => write.getSQL(),
    then(onfulfilled, onrejected) {
      return (async () => {
        await sqlx.run(db, lock);
        return await write;
      })().then(onfulfilled, onrejected);
    },
  };
  return locked;
}
