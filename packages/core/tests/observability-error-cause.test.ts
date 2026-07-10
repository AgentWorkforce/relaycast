// F0-rigor proof: every per-hop log emission MUST surface the underlying
// Postgres `code` and drizzle `cause` chain, NOT just the wrapper's
// `error.message`. The #743 trap was that `errorResponse` logged only
// `error.message`, so when drizzle wrapped a pg error with "Failed query",
// the actionable PG code (e.g. 42P01) and the missing-Hyperdrive
// connection diagnostic in `error.cause` were invisible in CloudWatch.
//
// These tests assert the cause/code surface is PRESENT and NON-EMPTY for
// every shape of failure the path can produce.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  errorLogFields,
  loggableError,
  MAX_ERROR_CHAIN_DEPTH,
} from "../src/observability/error-cause.js";
import { logHop, withHopTiming } from "../src/observability/structured-log.js";

/**
 * Build a realistic drizzle-style error chain: outer wrapper carries the
 * SQL context, inner cause carries the PG diagnostic fields. This mirrors
 * what `pg` -> `drizzle-orm` produces in production.
 */
function buildDrizzlePgError(opts: {
  outerMessage: string;
  pgCode: string;
  pgDetail?: string;
  pgTable?: string;
  pgConstraint?: string;
  pgRoutine?: string;
}): Error {
  const pgError = new Error(`PG error ${opts.pgCode}`);
  Object.assign(pgError, {
    name: "PostgresError",
    code: opts.pgCode,
    detail: opts.pgDetail,
    table: opts.pgTable,
    constraint: opts.pgConstraint,
    routine: opts.pgRoutine,
    severity: "ERROR",
    schema: "public",
  });
  return new Error(opts.outerMessage, { cause: pgError });
}

describe("observability/error-cause", () => {
  it("surfaces the PG `code` from a nested drizzle wrapper, not just the top message", () => {
    const error = buildDrizzlePgError({
      outerMessage: "Failed query: insert into nango_sync_dedup",
      pgCode: "42P01",
      pgTable: "nango_sync_dedup",
      pgRoutine: "RelationName",
    });

    const loggable = loggableError(error);

    // Top-of-chain message is the drizzle wrapper — what `error.message`
    // alone would have surfaced (this is the #743 trap).
    assert.equal(loggable.message, "Failed query: insert into nango_sync_dedup");
    // …but the PG `code` from the deeper `cause` is surfaced anyway.
    assert.equal(loggable.code, "42P01");
    // And the full chain is structured so a CloudWatch query can filter
    // on `errorCauseChain[1].table === "nango_sync_dedup"`.
    assert.equal(loggable.chain.length, 2);
    assert.equal(loggable.chain[0].name, "Error");
    assert.equal(loggable.chain[1].name, "PostgresError");
    assert.equal(loggable.chain[1].code, "42P01");
    assert.equal(loggable.chain[1].table, "nango_sync_dedup");
    assert.equal(loggable.chain[1].routine, "RelationName");
    assert.equal(loggable.chain[1].severity, "ERROR");
  });

  it("surfaces PG diagnostic fields end-to-end via errorLogFields()", () => {
    const error = buildDrizzlePgError({
      outerMessage: "Failed query",
      pgCode: "23505",
      pgDetail: "Key (surface, dedupe_id) already exists",
      pgConstraint: "nango_sync_dedup_pkey",
    });

    const fields = errorLogFields(error);

    // Every field used by the downstream hop log MUST be non-empty.
    assert.equal(fields.errorMessage, "Failed query");
    assert.equal(fields.errorName, "Error");
    assert.equal(fields.errorCode, "23505");
    assert.equal(fields.errorCauseTruncated, false);
    assert.ok(fields.errorCauseChain.length === 2);
    assert.equal(fields.errorCauseChain[1].code, "23505");
    assert.equal(
      fields.errorCauseChain[1].detail,
      "Key (surface, dedupe_id) already exists",
    );
    assert.equal(fields.errorCauseChain[1].constraint, "nango_sync_dedup_pkey");
  });

  it("does not collapse a cause chain into just `message` (regression guard for #743)", () => {
    // The exact failure mode #743 hid: a drizzle wrapper whose `message`
    // says "Failed query" but whose `cause` carries the actionable PG code.
    // The PRE-FIX behavior was log.error(error.message) → "Failed query"
    // with nothing else. The fix is: errorLogFields surfaces `errorCode`.
    const error = buildDrizzlePgError({
      outerMessage: "Failed query",
      pgCode: "08006", // connection_failure — what #743 actually was.
    });

    const fields = errorLogFields(error);

    // Pre-fix: just "Failed query". Post-fix: also "08006".
    assert.equal(fields.errorMessage, "Failed query");
    assert.equal(fields.errorCode, "08006");
    // Strong non-vacuous assertion: `errorCode` must be a non-empty string.
    assert.ok(
      typeof fields.errorCode === "string" && fields.errorCode.length > 0,
      "errorCode must be a non-empty string — the #743 trap regression guard",
    );
  });

  it("caps chain depth and marks truncation to bound log size", () => {
    let current: Error = new Error("root");
    for (let i = 0; i < MAX_ERROR_CHAIN_DEPTH + 4; i += 1) {
      current = new Error(`wrap-${i}`, { cause: current });
    }

    const loggable = loggableError(current);
    assert.equal(loggable.chain.length, MAX_ERROR_CHAIN_DEPTH);
    assert.equal(loggable.truncated, true);
  });

  it("is cycle-safe when cause loops back on itself", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a }) as Error & { cause?: unknown };
    a.cause = b;

    const loggable = loggableError(a);
    // Two unique frames; loop detection keeps us bounded.
    assert.equal(loggable.chain.length, 2);
    assert.equal(loggable.truncated, false);
  });

  it("handles non-Error throwables (string/number/object) without dropping context", () => {
    const stringLoggable = loggableError("plain string failure");
    assert.equal(stringLoggable.message, "plain string failure");
    assert.equal(stringLoggable.code, null);
    assert.equal(stringLoggable.chain.length, 1);

    const objectLoggable = loggableError({ message: "from-object", code: "X1" });
    assert.equal(objectLoggable.message, "from-object");
    assert.equal(objectLoggable.code, "X1");
  });
});

describe("observability/structured-log", () => {
  function captureLogger() {
    const calls: Array<{ level: string; label: string; payload: unknown }> = [];
    return {
      logger: {
        info: (label: string, payload: unknown) =>
          calls.push({ level: "info", label, payload }),
        warn: (label: string, payload: unknown) =>
          calls.push({ level: "warn", label, payload }),
        error: (label: string, payload: unknown) =>
          calls.push({ level: "error", label, payload }),
      },
      calls,
    };
  }

  it("emits area=nango-webhook-path with hop+outcome on every log line", () => {
    const { logger, calls } = captureLogger();
    logHop({
      hop: "consume",
      outcome: "ok",
      provider: "confluence",
      logger,
    });

    assert.equal(calls.length, 1);
    const payload = calls[0].payload as Record<string, unknown>;
    assert.equal(payload.area, "nango-webhook-path");
    assert.equal(payload.hop, "consume");
    assert.equal(payload.outcome, "ok");
    assert.equal(payload.provider, "confluence");
    assert.equal(calls[0].level, "info");
  });

  it("surfaces error.cause + PG code on outcome=error (the #743 regression guard)", () => {
    const { logger, calls } = captureLogger();
    const dbError = new Error("Failed query: select nango_sync_dedup", {
      cause: Object.assign(new Error("connection terminated unexpectedly"), {
        name: "PostgresError",
        code: "08006",
        severity: "FATAL",
      }),
    });

    logHop({
      hop: "dedup",
      outcome: "error",
      requestId: "req-1",
      dedupeId: "v1:abc",
      provider: "confluence",
      error: dbError,
      logger,
    });

    assert.equal(calls.length, 1);
    const payload = calls[0].payload as Record<string, unknown>;
    assert.equal(calls[0].level, "error");
    // Per-hop log MUST contain the cause-chain code, not just the wrapper.
    assert.equal(payload.errorCode, "08006");
    assert.equal(payload.errorMessage, "Failed query: select nango_sync_dedup");
    assert.ok(Array.isArray(payload.errorCauseChain));
    const chain = payload.errorCauseChain as Array<Record<string, unknown>>;
    assert.equal(chain.length, 2);
    assert.equal(chain[1].code, "08006");
    assert.equal(chain[1].severity, "FATAL");
    // Strong non-vacuous gate: the code must be a non-empty string at the
    // per-hop log boundary, not just inside a deeper structure.
    assert.ok(
      typeof payload.errorCode === "string" && (payload.errorCode as string).length > 0,
      "per-hop log MUST surface non-empty PG code",
    );
  });

  it("withHopTiming emits one log on success and one on failure with surfaced cause", async () => {
    const { logger, calls } = captureLogger();
    const tickedNow = (() => {
      let n = 1000;
      return () => {
        n += 7;
        return n;
      };
    })();

    await withHopTiming(
      { hop: "consume", provider: "confluence", model: "ConfluenceSpace" },
      async () => "ok",
      { logger, now: tickedNow },
    );

    assert.equal(calls.length, 1);
    const okPayload = calls[0].payload as Record<string, unknown>;
    assert.equal(okPayload.outcome, "ok");
    assert.equal(typeof okPayload.durationMs, "number");
    assert.ok((okPayload.durationMs as number) > 0);

    const drizzleErr = new Error("Failed query", {
      cause: Object.assign(new Error("relation \"nango_sync_dedup\" does not exist"), {
        name: "PostgresError",
        code: "42P01",
        table: "nango_sync_dedup",
      }),
    });

    await assert.rejects(
      withHopTiming(
        { hop: "dedup", provider: "confluence" },
        async () => {
          throw drizzleErr;
        },
        { logger, now: tickedNow },
      ),
      drizzleErr,
    );

    assert.equal(calls.length, 2);
    const errPayload = calls[1].payload as Record<string, unknown>;
    assert.equal(errPayload.outcome, "error");
    assert.equal(errPayload.errorCode, "42P01");
    const chain = errPayload.errorCauseChain as Array<Record<string, unknown>>;
    assert.equal(chain[1].table, "nango_sync_dedup");
  });
});

/**
 * Mark `mock` referenced so the explicit dependency on `node:test`'s mock
 * helper is preserved for future expansions; no behavior here.
 */
void mock;
