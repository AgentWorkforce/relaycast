import type { WorkspaceFsContext } from "./fs.js";

/**
 * cloud#2029 follow-up #2 — bounded, operator-triggered legacy-draft drain.
 *
 * Removes stale Slack writeback command drafts (`draft*.json` / `create.json`)
 * whose writeback op already reached terminal SUCCESS, so they stop counting as
 * `pendingWriteback` (which makes the #2036/#2037 gate fire loud) and stop
 * choking the `--once` full-tree flush.
 *
 * SAFETY (this is data-loss-sensitive — see cloud#2029):
 *  - Eligible IFF the latest op for the path is `succeeded` AND that op's
 *    revision === the on-disk file revision (the draft is PROVABLY the delivered
 *    one — guards the create.json-REUSE case: succeeded@R1 but on-disk rewritten
 *    to undelivered R2) AND there is no non-terminal op for the path (no
 *    in-flight redelivery). `failed`/`dead_lettered`/`canceled`/orphan/pending →
 *    LEFT untouched + surfaced (those are exactly the failures #2029 makes
 *    visible; deleting them re-buries silent loss).
 *  - Removal is WRITEBACK-SUPPRESSED: a system-origin `file.deleted` (no op, no
 *    dispatch — recordMutations suppresses ops for `origin:"system"`). A normal
 *    delete would enqueue a `file_delete` writeback → the Slack adapter turns
 *    that into a `chat.delete`, UN-SENDING the delivered message. Never that.
 *  - The tombstone carries the drain correlation marker so the agent-watch
 *    delivery layer can suppress the notification fan-out (the event still
 *    reaches mounts via the relayfile feed — mounts MUST consume it).
 *  - DRY-RUN first: report counts, delete nothing.
 *  - Bounded per call; idempotent (already-removed drafts are gone; only
 *    `succeeded`+revision-matched drafts are ever touched).
 */

export const LEGACY_DRAIN_CORRELATION_PREFIX = "relayfile:legacy-draft-drain:";

const TERMINAL_SUCCESS_STATUS = "succeeded";
const TERMINAL_OPERATION_STATUSES = new Set([
  "succeeded",
  "failed",
  "dead_lettered",
  "canceled",
]);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type DrainLeaveReason =
  | "no_op"
  | "not_succeeded"
  | "revision_mismatch"
  | "pending_op";

export type DrainLegacyDraftsResult = {
  dryRun: boolean;
  runId: string;
  scanned: number;
  eligible: number;
  removed: number;
  leftByReason: Record<DrainLeaveReason, number>;
};

type DrainRequestBody = {
  workspaceId?: string;
  /**
   * The Slack writeback command roots to sweep (e.g.
   * `/slack/channels/<id>/messages`). The caller (cloud-web admin route)
   * derives these from the integration scope and passes them in; the DO stays
   * provider-agnostic. Required + non-empty.
   */
  commandRoots?: string[];
  dryRun?: boolean;
  limit?: number;
};

type OperationRow = { status: string; revision: string; created_at: string };
type DraftFileRow = { path: string; revision: string; content_ref: string };

function isDraftCommandFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  // The agent-authored writeback-command convention (cf Pear
  // /(?:draft[@-][^/]*|create)\.json$/). Deliberately NARROW: command roots are
  // MIRROR dirs, so inbound `<ts>.json` messages must NOT be swept.
  return /^draft[@-].*\.json$/u.test(base) || base === "create.json";
}

function normalizeRoot(root: string): string {
  const trimmed = root.replace(/\/+$/u, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export async function handleDrainLegacyWritebackDrafts(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<DrainRequestBody>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "workspaceId is required",
    );
  }

  const roots = Array.isArray(body.commandRoots)
    ? [...new Set(body.commandRoots.filter((r) => typeof r === "string" && r.trim().length > 0).map(normalizeRoot))]
    : [];
  if (roots.length === 0) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "commandRoots must be a non-empty array",
    );
  }

  const dryRun = body.dryRun !== false; // default to dry-run; destructive must be explicit
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, typeof body.limit === "number" ? Math.floor(body.limit) : DEFAULT_LIMIT),
  );

  const runId = context.correlationId(request);
  const correlationId = `${LEGACY_DRAIN_CORRELATION_PREFIX}${runId}`;
  const leftByReason: Record<DrainLeaveReason, number> = {
    no_op: 0,
    not_succeeded: 0,
    revision_mismatch: 0,
    pending_op: 0,
  };
  let scanned = 0;
  let eligible = 0;
  let removed = 0;

  for (const root of roots) {
    if (scanned >= limit) {
      break;
    }
    const lo = `${root}/`;
    const hi = `${root}/￿`;
    // Bound the LIMIT window to DRAFT files, not total mirror volume. Command
    // roots are mirror dirs; inbound `<ts>.json` (leading digit) sort BEFORE
    // `create.json`/`draft*` (c/d) under ORDER BY path, so without this filter a
    // busy root with > limit inbound rows fills the window with inbound and the
    // drafts (sorting last) are NEVER fetched — a deterministic silent
    // under-drain + a falsely-clean dry-run count (cloud2029-shadow #2038).
    // GLOBs are deliberately a SUPERSET of `isDraftCommandFile` (the exact JS
    // gate below): `*` matches `/`, so they cover drafts at any depth and never
    // under-match a name the JS gate accepts; over-matches are dropped by the JS
    // gate. `[-@]` (dash first = literal) = the draft@/draft- conventions.
    const draftGlob = `${root}/*draft[-@]*.json`;
    const createGlob = `${root}/*create.json`;
    const rows = context.allRows<DraftFileRow>(
      "SELECT path, revision, content_ref FROM files WHERE path >= ? AND path < ? AND (path GLOB ? OR path GLOB ?) ORDER BY path LIMIT ?",
      lo,
      hi,
      draftGlob,
      createGlob,
      limit - scanned,
    );

    for (const file of rows) {
      if (!isDraftCommandFile(file.path)) {
        continue;
      }
      scanned += 1;

      const ops = context.allRows<OperationRow>(
        "SELECT status, revision, created_at FROM operations WHERE path = ? ORDER BY created_at DESC, rowid DESC",
        file.path,
      );

      if (ops.length === 0) {
        leftByReason.no_op += 1;
        continue;
      }
      // Any non-terminal op (pending/queued/running/...) ⇒ in-flight delivery;
      // never delete under it.
      if (ops.some((op) => !TERMINAL_OPERATION_STATUSES.has(op.status))) {
        leftByReason.pending_op += 1;
        continue;
      }
      const latest = ops[0];
      if (latest.status !== TERMINAL_SUCCESS_STATUS) {
        // failed / dead_lettered / canceled — UNDELIVERED, preserve + surface.
        leftByReason.not_succeeded += 1;
        continue;
      }
      // The succeeded op must be for the EXACT on-disk revision, else the draft
      // was rewritten after delivery to an undelivered revision (create.json
      // reuse) → preserve.
      if (latest.revision !== file.revision) {
        leftByReason.revision_mismatch += 1;
        continue;
      }

      eligible += 1;
      if (dryRun) {
        continue;
      }

      // Writeback-SUPPRESSED removal: system-origin file.deleted (no op, no
      // dispatch) + the drain marker for downstream notification suppression.
      context.sqlExec("DELETE FROM files WHERE path = ?", file.path);
      await context.recordMutation({
        path: file.path,
        revision: context.nextId("rev"),
        provider: "slack",
        correlationId,
        eventType: "file.deleted",
        action: "file_delete",
        timestamp: new Date().toISOString(),
        origin: "system",
      });
      if (file.content_ref) {
        await context.deleteContent(file.content_ref).catch(() => undefined);
      }
      removed += 1;
    }
  }

  const result: DrainLegacyDraftsResult = {
    dryRun,
    runId,
    scanned,
    eligible,
    removed,
    leftByReason,
  };
  return context.json(result);
}
