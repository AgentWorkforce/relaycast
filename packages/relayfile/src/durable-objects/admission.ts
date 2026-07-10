/**
 * Per-workspace admission control (hardening item 4).
 *
 * The WorkspaceDO is one instance per workspace, ~128MB cap. Even with
 * streaming export, streaming writeback, and bounded SELECTs, a
 * pathological workspace shape can still blow the budget — e.g. an export
 * manifest page whose every row carries a 20 KB semantics_json.
 *
 * This module computes a rough estimate of the export-manifest page live-set
 * BEFORE doing the heavy work and rejects with 413 + a clear error code when
 * the page would exceed the budget. The estimate is
 * intentionally pessimistic — false positives are fine (caller pages),
 * false negatives are not (DO crashes).
 *
 * Configurable via the `RELAYFILE_DO_MEMORY_BUDGET_BYTES` env var
 * (default 96 MiB — 32 MiB headroom below the 128 MiB cap).
 */

import type { Bindings } from "../env.js";

/** Bytes of request body we'll buffer at once. Matches the write cap. */
const DEFAULT_BUDGET_BYTES = 96 * 1024 * 1024;

/**
 * Rough per-file row overhead (path + revision + content_type +
 * content_ref + size + encoding + updated_at + provider + ... +
 * semantics_json average). This deliberately budgets for the documented
 * heavy-semantics case: a 20 KiB semantics_json plus row/string overhead.
 */
export const AVG_FILE_ROW_BYTES = 24 * 1024;

/** Rough per-event row overhead (smaller — no semantics_json). */
export const AVG_EVENT_ROW_BYTES = 512;

/** Rough per-operation row overhead. */
export const AVG_OP_ROW_BYTES = 1024;

export type AdmissionEstimate = {
  /** Approximate bytes the request would resident in the DO heap. */
  estimatedBytes: number;
  /** Bytes already buffered from the request body. Kept at 0 for manifest reads. */
  bodyBytes: number;
  /** Rough metadata cost for rows resident in the current bounded page. */
  metadataBytes: number;
};

export type AdmissionDecision =
  | { admit: true; estimate: AdmissionEstimate }
  | {
      admit: false;
      estimate: AdmissionEstimate;
      reason: "workspace_too_large";
      message: string;
      budget: number;
    };

export interface AdmissionInput {
  /** Total files in the workspace; used for messages and export ceilings. */
  fileCount: number;
  /** Files resident in the current page; defaults to fileCount for legacy callers. */
  residentFileRows?: number;
  /** Measured bytes for the actual resident page, when the caller has rows. */
  residentMetadataBytes?: number;
  eventCount?: number;
  operationCount?: number;
}

export function resolveDoMemoryBudgetBytes(
  bindings: Partial<Pick<Bindings, "ENVIRONMENT">> & {
    RELAYFILE_DO_MEMORY_BUDGET_BYTES?: string;
  },
): number {
  const raw = bindings.RELAYFILE_DO_MEMORY_BUDGET_BYTES;
  if (!raw) return DEFAULT_BUDGET_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGET_BYTES;
}

export function estimateRequestFootprint(
  input: AdmissionInput,
): AdmissionEstimate {
  const residentFileRows = Math.max(
    0,
    input.residentFileRows ?? input.fileCount,
  );
  const metadataBytes =
    (input.residentMetadataBytes ?? residentFileRows * AVG_FILE_ROW_BYTES) +
    (input.eventCount ?? 0) * AVG_EVENT_ROW_BYTES +
    (input.operationCount ?? 0) * AVG_OP_ROW_BYTES;
  const bodyBytes = 0;
  return {
    estimatedBytes: metadataBytes + bodyBytes,
    bodyBytes,
    metadataBytes,
  };
}

export function decideAdmission(
  input: AdmissionInput,
  budget: number,
): AdmissionDecision {
  const estimate = estimateRequestFootprint(input);
  if (estimate.estimatedBytes <= budget) {
    return { admit: true, estimate };
  }
  const reason = "workspace_too_large" as const;
  const message =
    `workspace has ${input.fileCount} files (estimated ${estimate.metadataBytes} bytes of resident page metadata) ` +
    `which exceeds the DO memory budget of ${budget} bytes for a single manifest page; ` +
    `use the paginated tree/read APIs (GET /fs/tree, GET /fs/file) instead`;
  return {
    admit: false,
    estimate,
    reason,
    message,
    budget,
  };
}
