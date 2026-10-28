/**
 * Operational diagnostics: how long the engine's expensive database operations
 * take, and how far long-running cleanups have progressed. Distinct from
 * `TelemetrySink`, which carries domain observations. Hosts decide whether and
 * where to export these; the default is to drop them.
 *
 * The engine cannot see per-statement database cost (rows read/written) through
 * its query builder, so it only reports operation-level timing. A host that can
 * (for example a D1 binding wrapper) attributes each statement to the operation
 * in flight with `currentEngineOperation()`.
 */

/** Stable, low-cardinality names for the engine operations worth timing. */
export type EngineOperationLabel =
  | 'inbox.get'
  | 'deliveries.list'
  | 'workspace.delete'
  | 'invocations.sweep'
  | 'backfill.mention_fts';

export interface EngineOperationScope {
  label: EngineOperationLabel;
  workspaceId?: string;
}

export interface EngineOperationSample extends EngineOperationScope {
  durationMs: number;
  outcome: 'ok' | 'error';
  /** `error.name` only — never the message, which may carry tenant data. */
  errorName?: string;
}

export type EngineProgressOperation = 'workspace.delete' | 'backfill.mention_fts';

export interface EngineProgressSample {
  operation: EngineProgressOperation;
  workspaceId?: string;
  phase: 'started' | 'batch' | 'completed' | 'failed';
  /** For a workspace delete: the table this batch drained. */
  table?: string;
  /** Rows processed by this batch. */
  rows?: number;
  /** Rows still to process, when cheaply known; otherwise null. */
  remaining?: number | null;
  durationMs?: number;
}

/** Callbacks may be async; a throw or rejection is contained and never affects the engine. */
export interface EngineDiagnostics {
  operation?(sample: EngineOperationSample): void | Promise<void>;
  progress?(sample: EngineProgressSample): void | Promise<void>;
}
