// Per-hop structured logging for the Nango webhook path.
//
// The merged path runs through six hops:
//
//   1. ingest      — webhook-worker handler accepts + verifies signature
//   2. enqueue     — webhook-worker pushes the v2 message to WEBHOOK_QUEUE
//   3. consume     — webhook-worker queue-consumer normalizes the message
//   4. dedup       — withWebhookDedup claims / completes / fails
//   5. plan        — provider-write-planner gates by parity registry
//   6. write       — relayfile-http-writer + record-writer applies the batch
//
// Each hop emits one log line per outcome — success or failure — with the
// SAME canonical shape so that CloudWatch / Logpush queries can filter on a
// stable `hop` field. On error we always run the cause through
// `errorLogFields` so the deepest Postgres `code` and drizzle context are
// surfaced. This is the structural fix for the #743 trap.
//
// Worker-safe (no Node-only imports).

import { errorLogFields, type ErrorFrame } from "./error-cause.js";

export const NANGO_OBSERVABILITY_AREA = "nango-webhook-path";

export type NangoHopName =
  | "ingest"
  | "enqueue"
  | "consume"
  | "dedup"
  | "plan"
  | "write"
  | "reenqueue";

export type NangoHopOutcome = "ok" | "error" | "skip" | "retry" | "duplicate";

/**
 * The canonical envelope every per-hop log emits. Every field is optional
 * EXCEPT `area` + `hop` + `outcome` — callers fill in what they have at the
 * hop boundary. Missing values stay `undefined` so log queries can detect
 * structural drift.
 */
export type HopLogFields = {
  area: typeof NANGO_OBSERVABILITY_AREA;
  hop: NangoHopName;
  outcome: NangoHopOutcome;
  service?: string;
  environment?: string;
  version?: string;
  // Correlation — requestId for the ingress, dedupeId for the dedup hop.
  // At least one MUST be set on consume/dedup/plan/write hops; the ingest
  // hop populates requestId and downstream hops carry it through.
  requestId?: string;
  dedupeId?: string;
  messageId?: string;
  // Provider/sync triple — populated as soon as the message is parsed.
  provider?: string;
  workspaceId?: string;
  connectionId?: string;
  providerConfigKey?: string;
  syncName?: string;
  model?: string;
  // Batch shape.
  batchSize?: number;
  written?: number;
  deleted?: number;
  errors?: number;
  // Timing.
  durationMs?: number;
  // Disposition for queue messages (ack/retry/dlq).
  disposition?: "ack" | "retry" | "dlq";
  // Free-form note — keep short.
  note?: string;
  // Error surface — populated on outcome === "error" only.
  errorName?: string | null;
  errorMessage?: string;
  errorCode?: string | null;
  errorCauseChain?: ErrorFrame[];
  errorCauseTruncated?: boolean;
};

export type HopLogger = Pick<Console, "info" | "warn" | "error">;

function levelForOutcome(outcome: NangoHopOutcome): "info" | "warn" | "error" {
  if (outcome === "error") return "error";
  if (outcome === "retry" || outcome === "skip" || outcome === "duplicate") return "warn";
  return "info";
}

/**
 * Emit a single structured per-hop log line. Always sets `area` so a single
 * CloudWatch filter (area:"nango-webhook-path") surfaces the entire path.
 *
 * If `error` is provided, the cause chain is flattened via `errorLogFields`
 * and merged in — caller fields take precedence so a hop can override the
 * top-of-chain `errorMessage` with its own context.
 */
export function logHop(
  fields: Omit<HopLogFields, "area"> & {
    error?: unknown;
    logger?: HopLogger;
    meta?: Pick<HopLogFields, "service" | "environment" | "version">;
  },
): void {
  const { error, logger, meta, ...rest } = fields;
  const level = levelForOutcome(rest.outcome);
  const out: HopLogFields = {
    area: NANGO_OBSERVABILITY_AREA,
    ...(meta?.service ? { service: meta.service } : {}),
    ...(meta?.environment ? { environment: meta.environment } : {}),
    ...(meta?.version ? { version: meta.version } : {}),
    ...rest,
  };

  if (error !== undefined && error !== null) {
    const surface = errorLogFields(error);
    // Caller fields win — if the hop already set `errorMessage` to a more
    // descriptive variant, keep it; otherwise inherit from the chain head.
    out.errorName = out.errorName ?? surface.errorName;
    out.errorMessage = out.errorMessage ?? surface.errorMessage;
    out.errorCode = out.errorCode ?? surface.errorCode;
    out.errorCauseChain = out.errorCauseChain ?? surface.errorCauseChain;
    out.errorCauseTruncated = out.errorCauseTruncated ?? surface.errorCauseTruncated;
  }

  const sink = logger ?? console;
  const label = `[${NANGO_OBSERVABILITY_AREA}/${rest.hop}] ${rest.outcome}`;
  sink[level](label, out);
}

/**
 * Convenience: time an async hop. Always emits exactly one log line —
 * `ok` on resolve, `error` on reject (with the surfaced cause chain).
 * Re-throws the original error so behavior is unchanged.
 */
export async function withHopTiming<T>(
  base: Omit<HopLogFields, "area" | "outcome" | "durationMs">,
  run: () => Promise<T>,
  options: { logger?: HopLogger; now?: () => number } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const start = now();
  try {
    const result = await run();
    logHop({
      ...base,
      outcome: "ok",
      durationMs: now() - start,
      logger: options.logger,
    });
    return result;
  } catch (error) {
    logHop({
      ...base,
      outcome: "error",
      durationMs: now() - start,
      error,
      logger: options.logger,
    });
    throw error;
  }
}
