/**
 * Minimal structured-log metrics shim (hardening item 6).
 *
 * The relayfile DO/Worker doesn't have a dedicated metrics adapter
 * today — observability is `console.log` JSON shapes. This module wraps
 * those into typed helpers so:
 *   - metric names are checked at compile time,
 *   - labels are always emitted as a flat object (easy to ingest in any
 *     log aggregator that can parse JSON),
 *   - alert configs in docs/operations/relayfile-alerts.md reference
 *     the same names that show up in the log stream.
 *
 * Output shape:
 *   { "@metric": "relayfile_workspace_file_count", value: 5000,
 *     labels: { workspace_id: "ws_..." } }
 *
 * Ingestors that recognize the `@metric` discriminator turn this into a
 * counter/gauge/histogram. The rest treat it as a structured log line.
 */

export type RelayfileMetricName =
  | "relayfile_workspace_file_count"
  | "relayfile_workspace_total_bytes"
  | "relayfile_writeback_body_bytes"
  | "relayfile_do_request_duration_ms"
  | "relayfile_do_oom_reset_total"
  | "relayfile_export_files_emitted"
  | "relayfile_export_github_base_snapshot_files"
  | "relayfile_vfs_plane_resolved_total"
  | "relayfile_worker_route_requests_total"
  | "relayfile_worker_fs_file_not_modified_total"
  | "relayfile_worker_fs_bulk_read_files_total"
  | "relayfile_vfs_plane_write_candidate_total"
  | "relayfile_export_blob_read_timeout_total"
  | "relayfile_export_blob_read_retry_total"
  | "relayfile_export_blob_read_exhausted_total"
  | "relayfile_workspace_memory_high_water"
  | "relayfile_admission_rejected_total"
  | "relayfile_workspace_deleted_total"
  | "relayfile_workspace_deleted_objects_total";

export type MetricLabels = Record<string, string | number | boolean>;

export interface MetricEmitter {
  emit(name: RelayfileMetricName, value: number, labels?: MetricLabels): void;
}

class ConsoleMetricEmitter implements MetricEmitter {
  emit(
    name: RelayfileMetricName,
    value: number,
    labels: MetricLabels = {},
  ): void {
    // Single-line JSON for easy log ingestion. Workers logs strip
    // unstructured prefixes so we don't add a level tag.
    console.log(
      JSON.stringify({
        "@metric": name,
        value,
        labels,
        ts: Date.now(),
      }),
    );
  }
}

const defaultEmitter: MetricEmitter = new ConsoleMetricEmitter();

/**
 * Replace the global emitter (for tests). Returns the previous emitter
 * so the test can restore it.
 */
let activeEmitter: MetricEmitter = defaultEmitter;
export function setMetricEmitter(emitter: MetricEmitter): MetricEmitter {
  const prev = activeEmitter;
  activeEmitter = emitter;
  return prev;
}

export function emitMetric(
  name: RelayfileMetricName,
  value: number,
  labels?: MetricLabels,
): void {
  activeEmitter.emit(name, value, labels);
}

/**
 * Wrap a handler with a duration histogram + OOM-reset counter. If the
 * handler throws (or the DO crashes with an isolate-reset shaped error),
 * we increment `relayfile_do_oom_reset_total` so an operator alert can
 * fire on a rising counter.
 */
export async function withHandlerMetrics<T>(
  handler: string,
  workspaceId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    emitMetric("relayfile_do_request_duration_ms", Date.now() - t0, {
      handler,
      workspace_id: workspaceId ?? "",
      outcome: "ok",
    });
    return out;
  } catch (err) {
    emitMetric("relayfile_do_request_duration_ms", Date.now() - t0, {
      handler,
      workspace_id: workspaceId ?? "",
      outcome: "error",
    });
    const message = (err as Error)?.message ?? String(err);
    // Heuristic: workerd's OOM-reset error message contains "exceeded
    // memory limit" or "Durable Object reset because its code was
    // updated"; the latter is benign but the former is the OOM signal.
    if (/exceeded memory|out of memory|isolate.*disposed/i.test(message)) {
      emitMetric("relayfile_do_oom_reset_total", 1, {
        handler,
        workspace_id: workspaceId ?? "",
      });
    }
    throw err;
  }
}
