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
 * A snapshot lives until the next advance. The engine retries a failed
 * advance once, then logs it and carries on, so a store whose calls can fail
 * must bound how long it serves one snapshot.
 *
 * Every database handle that writes those tables must be bound to the same
 * store ({@link configureActionCatalog}); a handle without one reads the
 * database directly and advances nothing.
 */
export interface ActionCatalogStore {
  read(workspaceId: string): Promise<{ revision: string; snapshot: ActionCatalogSnapshot | null }>;
  fill(workspaceId: string, revision: string, snapshot: ActionCatalogSnapshot): Promise<void>;
  advance(workspaceId: string): Promise<void>;
  /** The workspace was deleted: release what the store holds for it. Omitted: the engine advances instead. */
  forget?(workspaceId: string): Promise<void>;
}

/**
 * Single-process store for a self-hosted engine. Revisions come from one
 * store-wide counter and are never reused, so a forgotten workspace's entry
 * can go: a fill still holding one of its revisions matches nothing.
 */
export class MemoryActionCatalogStore implements ActionCatalogStore {
  private readonly entries = new Map<string, { revision: number; snapshot: ActionCatalogSnapshot | null }>();
  private clock = 0;

  async read(workspaceId: string) {
    let entry = this.entries.get(workspaceId);
    if (!entry) {
      entry = { revision: ++this.clock, snapshot: null };
      this.entries.set(workspaceId, entry);
    }
    return { revision: String(entry.revision), snapshot: entry.snapshot };
  }

  async fill(workspaceId: string, revision: string, snapshot: ActionCatalogSnapshot) {
    const entry = this.entries.get(workspaceId);
    if (entry && String(entry.revision) === revision) entry.snapshot = snapshot;
  }

  async advance(workspaceId: string) {
    // With no entry, any revision a reader still holds (one read before a forget) matches nothing, so
    // its fill is dropped; the next read starts past every earlier revision.
    if (this.entries.has(workspaceId)) this.entries.set(workspaceId, { revision: ++this.clock, snapshot: null });
  }

  async forget(workspaceId: string) {
    this.entries.delete(workspaceId);
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
