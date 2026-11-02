import type { EngineDb } from './database.js';

/** One `actions` row, as the hot paths read it. */
export interface ActionCatalogAction {
  id: string;
  name: string;
  description: string;
  handlerAgentId: string | null;
  handlerNodeId: string | null;
  handlerProvider: string | null;
  availableTo: string[] | null;
  isActive: boolean;
  isGlobal: boolean;
  queue: boolean;
  executionMode: 'short' | 'task';
}

/** One enabled `triggers` row. Its last fire time is left out: the fire claim enforces the rate limit. */
export interface ActionCatalogTrigger {
  id: string;
  channel: string | null;
  pattern: string | null;
  mention: boolean | null;
  actionName: string;
}

/**
 * A workspace's complete action and enabled-trigger rows, or `oversize` when
 * the workspace holds more than the engine caches (readers then query the
 * database directly). `shape` names the row layout; the engine ignores a
 * snapshot whose shape it does not write.
 */
export type ActionCatalogSnapshot =
  | { shape: number; oversize: false; actions: ActionCatalogAction[]; triggers: ActionCatalogTrigger[] }
  | { shape: number; oversize: true };

/**
 * Writer-advanced cache of each workspace's action catalog.
 *
 * The engine calls {@link advance} after every write that can change a
 * workspace's `actions` rows or enabled `triggers` rows commits (or fails), so
 * the revision moves past any snapshot filled from the previous state. A
 * reader takes the current revision, reads the rows when no snapshot is held
 * at it, and offers them back with {@link fill}; the store keeps them only if
 * the revision is still current, so a fill that raced a write is dropped.
 * Nothing expires: a snapshot lives until the next advance.
 *
 * Every database handle that writes those tables must be bound to the same
 * store ({@link configureActionCatalog}); a handle without one reads the
 * database directly and advances nothing.
 */
export interface ActionCatalogStore {
  read(workspaceId: string): Promise<{ revision: string; snapshot: ActionCatalogSnapshot | null }>;
  fill(workspaceId: string, revision: string, snapshot: ActionCatalogSnapshot): Promise<void>;
  advance(workspaceId: string): Promise<void>;
}

/** Single-process store for a self-hosted engine. */
export class MemoryActionCatalogStore implements ActionCatalogStore {
  private readonly entries = new Map<string, { revision: number; snapshot: ActionCatalogSnapshot | null }>();

  async read(workspaceId: string) {
    const entry = this.entries.get(workspaceId);
    return { revision: String(entry?.revision ?? 0), snapshot: entry?.snapshot ?? null };
  }

  async fill(workspaceId: string, revision: string, snapshot: ActionCatalogSnapshot) {
    const entry = this.entries.get(workspaceId) ?? { revision: 0, snapshot: null };
    if (String(entry.revision) !== revision) return;
    this.entries.set(workspaceId, { revision: entry.revision, snapshot });
  }

  async advance(workspaceId: string) {
    const revision = (this.entries.get(workspaceId)?.revision ?? 0) + 1;
    this.entries.set(workspaceId, { revision, snapshot: null });
  }
}

const stores = new WeakMap<object, ActionCatalogStore>();
/** Bind all HTTP, maintenance and socket-owner database wrappers. */
export function configureActionCatalog(db: EngineDb, store?: ActionCatalogStore): void {
  if (store) stores.set(db, store);
  else stores.delete(db);
}
export function actionCatalogStore(db: object): ActionCatalogStore | undefined {
  return stores.get(db);
}
