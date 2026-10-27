/** A structured log record emitted by the engine. */
export interface EngineLogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: Record<string, unknown>;
  occurredAt: string;
}

/** Optional host-owned transport for engine log records. */
export type EngineLogExport = (record: EngineLogRecord) => void | Promise<void>;
