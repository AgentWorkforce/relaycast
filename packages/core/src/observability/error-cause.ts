// Surfaces error.cause chain + Postgres diagnostic fields end-to-end.
//
// Why this exists: the #743 trap. `errorResponse(error.message)` truncated
// drizzle/pg errors to a generic "error" string, hiding the real Postgres
// `code` (e.g. 42P01 / 23505) that would have pointed at the missing
// Hyperdrive binding on the Worker bundle in minutes instead of a day.
//
// Every per-hop log on the Nango webhook path (router → enqueue → consume →
// dedup → adapter → runtime → planner → relayfile writer) MUST run errors
// through `loggableError(error)` before serializing. The function walks the
// `cause` chain and pulls Postgres' `code`, `detail`, `severity`, `routine`,
// `schema`, `table`, `constraint`, `position`, plus drizzle's wrapper fields.
//
// Worker-safe: pure functions, no Node-only imports, no runtime-specific
// globals. Importable from `@cloud/core/observability/error-cause.js` on both
// Lambda and Cloudflare Workers.

export const MAX_ERROR_CHAIN_DEPTH = 6;
export const MAX_ERROR_MESSAGE_LENGTH = 1024;
export const MAX_ERROR_FIELD_LENGTH = 512;

/**
 * Postgres / drizzle diagnostic fields we surface from each frame in the
 * `cause` chain. These are the fields that would have surfaced the #743
 * root cause: the PG `code` is the most actionable single field for any
 * Postgres failure (42P01 = undefined_table, 23505 = unique_violation,
 * 08006 = connection failure, 28P01 = invalid password, etc.).
 *
 * `query` and `parameters` come from drizzle's error wrapper.
 */
export const PG_ERROR_FIELDS = [
  "code",
  "detail",
  "hint",
  "severity",
  "routine",
  "schema",
  "table",
  "column",
  "dataType",
  "constraint",
  "position",
  "internalPosition",
  "internalQuery",
  "where",
  "file",
  "line",
  "query",
  "parameters",
] as const satisfies readonly string[];

export type ErrorFrame = {
  name: string | null;
  message: string;
  // PG / drizzle diagnostic surface — flat for easy log filtering.
  code: string | null;
  detail: string | null;
  hint: string | null;
  severity: string | null;
  routine: string | null;
  schema: string | null;
  table: string | null;
  column: string | null;
  dataType: string | null;
  constraint: string | null;
  position: string | null;
  internalPosition: string | null;
  internalQuery: string | null;
  where: string | null;
  file: string | null;
  line: string | null;
  query: string | null;
  parameters: string | null;
  // Whether this frame had a deeper `cause` to walk.
  hasCause: boolean;
};

export type LoggableError = {
  // Convenience: top-of-chain summary.
  name: string | null;
  message: string;
  code: string | null;
  // Full chain (capped). The deepest frame is usually the one that has the
  // PG `code` — drizzle wraps its caller's error with a sql-context message
  // and stashes the original in `cause`.
  chain: ErrorFrame[];
  // Truncation marker — set when the chain was longer than the cap.
  truncated: boolean;
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

function readStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > 0 ? truncate(value, MAX_ERROR_FIELD_LENGTH) : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // drizzle stashes `parameters` as an array — serialize compactly.
  if (Array.isArray(value)) {
    try {
      return truncate(JSON.stringify(value), MAX_ERROR_FIELD_LENGTH);
    } catch {
      return `[array length=${value.length}]`;
    }
  }
  if (typeof value === "object") {
    try {
      return truncate(JSON.stringify(value), MAX_ERROR_FIELD_LENGTH);
    } catch {
      return "[unserializable object]";
    }
  }
  return null;
}

function serializeFrame(error: object): ErrorFrame {
  const record = error as Record<string, unknown>;
  const message =
    typeof record.message === "string" && record.message.length > 0
      ? truncate(record.message, MAX_ERROR_MESSAGE_LENGTH)
      : truncate(String(error), MAX_ERROR_MESSAGE_LENGTH);

  const frame: ErrorFrame = {
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : null,
    message,
    code: readStringField(record, "code"),
    detail: readStringField(record, "detail"),
    hint: readStringField(record, "hint"),
    severity: readStringField(record, "severity"),
    routine: readStringField(record, "routine"),
    schema: readStringField(record, "schema"),
    table: readStringField(record, "table"),
    column: readStringField(record, "column"),
    dataType: readStringField(record, "dataType"),
    constraint: readStringField(record, "constraint"),
    position: readStringField(record, "position"),
    internalPosition: readStringField(record, "internalPosition"),
    internalQuery: readStringField(record, "internalQuery"),
    where: readStringField(record, "where"),
    file: readStringField(record, "file"),
    line: readStringField(record, "line"),
    query: readStringField(record, "query"),
    parameters: readStringField(record, "parameters"),
    hasCause: "cause" in record && record.cause != null,
  };
  return frame;
}

/**
 * Walks the error.cause chain and produces a flat, log-friendly object
 * containing every Postgres diagnostic field we can reach. Cycle-safe and
 * depth-capped.
 *
 * Always call this BEFORE handing an error to console.error / logger.error
 * on any Nango-sync hop. The Worker default logger drops fields that aren't
 * primitives in the structured-log JSON, so flat is critical.
 */
export function loggableError(error: unknown): LoggableError {
  const chain: ErrorFrame[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  let truncated = false;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (chain.length >= MAX_ERROR_CHAIN_DEPTH) {
      truncated = true;
      break;
    }
    chain.push(serializeFrame(current as object));
    current = (current as { cause?: unknown }).cause;
  }

  if (chain.length === 0) {
    chain.push({
      name: null,
      message: truncate(String(error), MAX_ERROR_MESSAGE_LENGTH),
      code: null,
      detail: null,
      hint: null,
      severity: null,
      routine: null,
      schema: null,
      table: null,
      column: null,
      dataType: null,
      constraint: null,
      position: null,
      internalPosition: null,
      internalQuery: null,
      where: null,
      file: null,
      line: null,
      query: null,
      parameters: null,
      hasCause: false,
    });
  }

  const head = chain[0];
  // Pick the most actionable PG code we can find anywhere in the chain —
  // drizzle wrappers often hide the real `code` in `cause`.
  const code = chain.reduce<string | null>((acc, frame) => acc ?? frame.code, null);

  return {
    name: head.name,
    message: head.message,
    code,
    chain,
    truncated,
  };
}

/**
 * Lower-level helper for callers that only want to attach the chain to
 * an existing structured log object. Returns a plain JSON-friendly object
 * suitable for spreading into a `console.error` payload.
 */
export function errorLogFields(error: unknown): {
  errorName: string | null;
  errorMessage: string;
  errorCode: string | null;
  errorCauseChain: ErrorFrame[];
  errorCauseTruncated: boolean;
} {
  const serialized = loggableError(error);
  return {
    errorName: serialized.name,
    errorMessage: serialized.message,
    errorCode: serialized.code,
    errorCauseChain: serialized.chain,
    errorCauseTruncated: serialized.truncated,
  };
}
