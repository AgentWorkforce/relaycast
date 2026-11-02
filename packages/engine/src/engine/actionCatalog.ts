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
 * concurrent reader fill the new revision from the old rows.
 */
export async function advancingActionCatalog<T>(
  db: object,
  workspaceIds: string | readonly string[],
  write: () => PromiseLike<T>,
): Promise<T> {
  let result: T;
  try {
    result = await write();
  } catch (err) {
    await advanceActionCatalog(db, workspaceIds).catch((advanceErr: unknown) => {
      console.warn('[actions] catalog advance failed after a failed write', { workspaceIds, err: advanceErr });
    });
    throw err;
  }
  await advanceActionCatalog(db, workspaceIds);
  return result;
}

export async function advanceActionCatalog(db: object, workspaceIds: string | readonly string[]): Promise<void> {
  const store = actionCatalogStore(db);
  if (!store) return;
  const ids = typeof workspaceIds === 'string' ? [workspaceIds] : [...new Set(workspaceIds)];
  await Promise.all(ids.map((id) => store.advance(id)));
}
