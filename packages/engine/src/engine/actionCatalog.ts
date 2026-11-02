import { and, eq } from 'drizzle-orm';
import { actions, triggers } from '../db/schema.js';
import type { EngineDb } from '../ports/database.js';
import {
  actionCatalogStore,
  type ActionCatalogAction,
  type ActionCatalogSnapshot,
  type ActionCatalogTrigger,
} from '../ports/actionCatalog.js';
export { configureActionCatalog, actionCatalogStore } from '../ports/actionCatalog.js';

/**
 * The snapshot row layout this engine writes. Raise it whenever the cached
 * columns change or a migration rewrites `actions` / `triggers` rows, so
 * snapshots filled before the deploy are ignored.
 */
export const ACTION_CATALOG_SHAPE = 1;

/** Rows per table a snapshot holds; a larger workspace is read directly. */
export const ACTION_CATALOG_ROW_LIMIT = 1000;

export interface ActionCatalog {
  actions: ActionCatalogAction[];
  triggers: ActionCatalogTrigger[];
}

async function readActionCatalog(db: EngineDb, workspaceId: string): Promise<ActionCatalogSnapshot> {
  const [actionRows, triggerRows] = await Promise.all([
    db
      .select({
        id: actions.id,
        name: actions.name,
        description: actions.description,
        handlerAgentId: actions.handlerAgentId,
        handlerNodeId: actions.handlerNodeId,
        handlerProvider: actions.handlerProvider,
        availableTo: actions.availableTo,
        isActive: actions.isActive,
        isGlobal: actions.isGlobal,
        queue: actions.queue,
        executionMode: actions.executionMode,
      })
      .from(actions)
      .where(eq(actions.workspaceId, workspaceId))
      .limit(ACTION_CATALOG_ROW_LIMIT + 1),
    db
      .select({
        id: triggers.id,
        channel: triggers.channel,
        pattern: triggers.pattern,
        mention: triggers.mention,
        actionName: triggers.actionName,
      })
      .from(triggers)
      .where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.enabled, true)))
      .limit(ACTION_CATALOG_ROW_LIMIT + 1),
  ]);
  if (actionRows.length > ACTION_CATALOG_ROW_LIMIT || triggerRows.length > ACTION_CATALOG_ROW_LIMIT) {
    return { shape: ACTION_CATALOG_SHAPE, oversize: true };
  }
  return { shape: ACTION_CATALOG_SHAPE, oversize: false, actions: actionRows, triggers: triggerRows };
}

/**
 * The workspace's actions and enabled triggers from the bound store, read from
 * the database at most once per catalog revision. `null` when the handle has
 * no store or the workspace is oversize: the caller runs its own query.
 */
export async function cachedActionCatalog(db: EngineDb, workspaceId: string): Promise<ActionCatalog | null> {
  const store = actionCatalogStore(db);
  if (!store) return null;
  const { revision, snapshot } = await store.read(workspaceId);
  if (snapshot?.shape === ACTION_CATALOG_SHAPE) return snapshot.oversize ? null : snapshot;
  const fresh = await readActionCatalog(db, workspaceId);
  await store.fill(workspaceId, revision, fresh);
  return fresh.oversize ? null : fresh;
}

/**
 * Run a write that can change the workspaces' actions or enabled triggers,
 * then advance their catalog revisions, whether the write committed or not
 * (a rolled-back transaction may have filled a snapshot from its own rows).
 * Call it around the outermost transaction: advancing before the commit lets a
 * concurrent reader fill the new revision from the old rows. The advance never
 * throws, so the caller's post-commit effects still run.
 */
export async function advancingActionCatalog<T>(
  db: object,
  workspaceIds: string | readonly string[],
  write: () => PromiseLike<T>,
): Promise<T> {
  try {
    return await write();
  } finally {
    await advanceActionCatalog(db, workspaceIds);
  }
}

/** Like {@link advancingActionCatalog}, for a write that deletes the workspaces. */
export async function forgettingActionCatalog<T>(
  db: object,
  workspaceIds: readonly string[],
  write: () => PromiseLike<T>,
): Promise<T> {
  try {
    return await write();
  } finally {
    await updateCatalog(db, workspaceIds, 'forget');
  }
}

/**
 * Advance the workspaces' catalog revisions. Never throws: a store call that
 * fails twice is logged, and the store's own bound on a snapshot's age
 * (see {@link ActionCatalogStore}) covers the missed advance.
 */
export async function advanceActionCatalog(db: object, workspaceIds: string | readonly string[]): Promise<void> {
  await updateCatalog(db, typeof workspaceIds === 'string' ? [workspaceIds] : workspaceIds, 'advance');
}

async function updateCatalog(db: object, workspaceIds: readonly string[], op: 'advance' | 'forget'): Promise<void> {
  const store = actionCatalogStore(db);
  if (!store) return;
  const apply = (id: string) => (op === 'forget' && store.forget ? store.forget(id) : store.advance(id));
  await Promise.all([...new Set(workspaceIds)].map(async (id) => {
    try {
      await apply(id);
    } catch {
      try {
        await apply(id);
      } catch (err) {
        console.warn(`[actions] catalog ${op} failed`, { workspaceId: id, err });
      }
    }
  }));
}
