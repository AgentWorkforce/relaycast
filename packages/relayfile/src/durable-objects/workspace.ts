import { DurableObject } from "cloudflare:workers";
import type { FilesystemEvent, OperationStatusResponse } from "@relayfile/sdk";
import { authorizeBearer } from "../middleware/auth.js";
import type { TokenClaims } from "../middleware/auth.js";
import type {
  SyncProviderStatus,
  WebhookDeliveryQueueMessage,
  WebhookSubscription,
  WebhookSubscriptionCreateRequest,
  WebhookSubscriptionCreateResponse,
  WorkspaceEvent,
  WorkspaceFile,
  WorkspaceOperation,
} from "../types.js";
import type { Bindings } from "../env.js";
import {
  createCoreStorageAdapter,
  toCoreFileRow,
  type Row,
  type WorkspaceAdapterContext,
} from "./adapter.js";
import {
  d1All,
  d1First,
  d1Run,
  upsertWorkspaceOperation,
  asNumber,
  asOptionalString,
  asString,
  type D1Context,
} from "./d1.js";
import {
  buildIngressStatus,
  buildIngressStatusMap,
  buildSyncProviders,
  buildSyncStatusMap,
  bumpIngressMetric,
  ensureWorkspaceStats,
  loadWorkspaceStats,
  syncWorkspaceStats,
  touchWorkspaceActivity,
  touchWorkspaceWriteStats,
  updateProviderStatus,
  type WorkspaceStatsContext,
} from "./stats.js";
import { handleDrainLegacyWritebackDrafts } from "./handlers/drain-legacy-drafts.js";
import {
  getRecentEvents,
  handleBulkWrite,
  handleDeleteFile,
  handleDeleteFileAny,
  handleExportManifest,
  handleExportWorkspace,
  handleExportWorkspaceGet,
  handleGetChangeResourceGet,
  handleListEvents,
  handleListEventsGet,
  handleListChangesGet,
  handleListTree,
  handleListTreeGet,
  handleQueryFiles,
  handleQueryFilesGet,
  handleReadFile,
  handleReadFileGet,
  handleReadFileMetadata,
  handleRegisterImportedContent,
  handleWriteFile,
  type FsHandlerErrors,
  type WorkspaceFsContext,
} from "./handlers/fs.js";
import {
  DIGEST_REFRESH_DUE_STORAGE_KEY,
  dispatchWriteback,
  ensureNextAlarm,
  getOperation,
  handleAckWriteback,
  handleDispatchWriteback,
  handleGetWritebackContext,
  handleGetWritebackContentStream,
  handleGetOperation,
  handleListOperationsGet,
  handleListWritebacks,
  handlePendingWritebacks,
  handleReplayOperation,
  handleReplayOperationInternal,
  recordMutation,
  recordMutations,
  type OpsHandlerContext,
} from "./handlers/ops.js";
import { isDigestPath, refreshWorkspaceDigests } from "./digest.js";
import {
  handleAckDeadLetter,
  handleGenericWebhook,
  handleGetDeadLetter,
  handleInternalWebhookEnvelope,
  handleListDeadLetters,
  handleProcessEnvelope,
  handleReplayDeadLetter,
  handleSyncIngress,
  handleSyncRefresh,
  handleSyncStatus,
  handleSyncWebhookHealth,
  writeSystemFileIfChanged,
  type SyncHandlerContext,
} from "./handlers/sync.js";
import {
  handleAdminRoute,
  type AdminHandlerContext,
  type AdminRoute,
} from "./handlers/admin.js";
import {
  handleGetIntegrationCredential,
  handleUpsertIntegrationCredential,
  type IntegrationHandlerContext,
} from "./handlers/integrations.js";
import {
  toWebSocketEventMessage,
  webSocketClose,
  webSocketError,
  webSocketMessage,
  type WebSocketHandlerContext,
} from "./handlers/websocket.js";
import { base64StringToByteStream } from "./content-hash.js";
import { streamR2ObjectContent } from "./content-read.js";
import {
  InflightAdmissionController,
  inflightAdmissionHttpContract,
  isAdmissionControlPlaneRequest,
  resolveInflightAdmissionOptions,
  type InflightAdmissionRejection,
} from "./request-admission.js";
import {
  decideWriteAdmission,
  isForegroundWriteAdmissionClass,
  resolveWriteAdmissionClass,
  resolveWriteAdmissionLeaseReason,
  type WriteAdmissionClass,
} from "./write-admission.js";
import {
  eventMatchesAnyWebhookGlob,
  MAX_WEBHOOK_FANOUT_PER_EVENT,
  MAX_WEBHOOK_SUBSCRIPTIONS_PER_WORKSPACE,
} from "../webhook-delivery.js";

type WorkspaceRoute = {
  workspaceId: string;
  segments: string[];
};

type HttpErrorShape = {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

type WorkspaceWebSocketAttachment = {
  teamSubtreePrefix: string | null;
};

type WriteAdmissionLeaseSample = {
  leaseId: string;
  purpose: string;
  writeClass: string;
  ageMs: number;
  expiresInMs: number;
};

const INGRESS_QUEUE_CAPACITY = 10_000;
const WRITEBACK_QUEUE_CAPACITY = 10_000;
const DEFAULT_INGRESS_ALERT_PROFILE = "balanced";
const WORKSPACE_ACTIVITY_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024;
const DEFAULT_WRITE_ADMISSION_MAX_INFLIGHT = 4;
const DEFAULT_WRITE_ADMISSION_FOREGROUND_RESERVED = 1;
const DEFAULT_WRITE_ADMISSION_LEASE_TTL_MS = 120_000;
const DEFAULT_WRITE_ADMISSION_RETRY_AFTER_SECONDS = 5;
const WRITE_ADMISSION_BUSY_LEASE_SAMPLE_LIMIT = 8;
const DEFAULT_WEBHOOK_SECRET_BYTES = 32;

const ERRORS = {
  badRequest: { status: 400, code: "bad_request", message: "bad request" },
  invalidInput: {
    status: 400,
    code: "invalid_input",
    message: "invalid input",
  },
  notFound: { status: 404, code: "not_found", message: "not found" },
  revisionConflict: {
    status: 409,
    code: "revision_conflict",
    message: "revision conflict",
  },
  duplicateEnvelope: {
    status: 409,
    code: "duplicate_envelope",
    message: "duplicate envelope",
  },
  invalidState: {
    status: 409,
    code: "invalid_state",
    message: "invalid resource state",
  },
  preconditionFailed: {
    status: 412,
    code: "precondition_failed",
    message: "missing If-Match header",
  },
  payloadTooLarge: {
    status: 413,
    code: "payload_too_large",
    message: "payload too large",
  },
  rateLimited: {
    status: 429,
    code: "rate_limited",
    message: "queue is full, retry later",
  },
  internal: {
    status: 500,
    code: "internal_error",
    message: "internal server error",
  },
} as const;

/**
 * Debounce window for the deferred digest refresh. The first non-digest write
 * in a quiet period arms an alarm at `now + DIGEST_REFRESH_DEBOUNCE_MS`;
 * writes that land inside this window coalesce into that one alarm fire.
 *
 * 15s is short enough that an operator who makes a single change sees the
 * digest update within a normal "refresh the page" loop, and long enough that
 * a sync batch (which writes many records back-to-back) produces ONE refresh
 * instead of N. The exact value isn't load-bearing; the property that matters
 * is that the refresh never runs on the synchronous write critical path.
 * See cloud#846.
 */
const DIGEST_REFRESH_DEBOUNCE_MS = 15_000;

/**
 * Build the body for a `CONTENT_BUCKET.put`. R2 `.put` with a `ReadableStream`
 * body requires a KNOWN length — workerd rejects a length-less stream with
 * "Provided readable stream must have a known length …". `base64StringToByteStream`
 * returns a plain, length-less stream, so for base64 content we buffer the
 * decoded bytes into a fixed-length `ArrayBuffer` before the put. `content` is
 * already fully materialized in the isolate heap, so buffering costs no more
 * than holding the base64 string. utf-8 content is already a fixed-length
 * string and is passed through unchanged. (cloud#2319)
 */
export async function r2ContentBody(
  content: string,
  encoding: "utf-8" | "base64",
): Promise<string | ArrayBuffer> {
  if (encoding === "base64") {
    return new Response(base64StringToByteStream(content)).arrayBuffer();
  }
  return content;
}

export class WorkspaceDO extends DurableObject<Bindings> {
  private readonly state: DurableObjectState;
  private readonly bindings: Bindings;
  private readonly sql: SqlStorage;
  private readonly admission: InflightAdmissionController;
  private workspaceId: string | null = null;

  constructor(state: DurableObjectState, env: Bindings) {
    super(state, env);
    this.state = state;
    this.bindings = env;
    this.sql = state.storage.sql;
    this.admission = new InflightAdmissionController(
      resolveInflightAdmissionOptions(
        env as Partial<
          Record<
            | "RELAYFILE_DO_MAX_INFLIGHT_REQUESTS"
            | "RELAYFILE_DO_MAX_INFLIGHT_AGE_MS"
            | "RELAYFILE_DO_RETRY_AFTER_SECONDS",
            string
          >
        >,
      ),
    );
    this.initSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Write-admission control-plane ops MUST bypass the inflight admission gate
    // (cloud#1261, codex-1 review): a release FREES capacity — throttling it
    // leaks the lease until its TTL and AMPLIFIES the very backpressure this
    // limiter exists to prevent — and acquire is the write-gate's own control
    // plane, so the data-plane gate must not throttle it either.
    const isAdmissionControlPlane = isAdmissionControlPlaneRequest(
      request.method,
      url.pathname,
    );

    // Foreground (clone-materialize) ops get the reserved admission lane so they
    // aren't starved by the background burst. Only honored on internal,
    // parent-Worker-constructed paths (e.g. /internal/export-manifest for the
    // clone tar) so external clients can't spoof it to skip the limit.
    const foreground =
      url.pathname.startsWith("/internal/") &&
      request.headers.get("X-Relayfile-Admission") === "clone-foreground";
    const admission = isAdmissionControlPlane
      ? null
      : this.admission.tryAcquire(Date.now(), foreground);
    if (admission && !admission.admit) {
      return this.backpressureResponse(request, admission);
    }
    try {
      if (
        request.method === "POST" &&
        url.pathname === "/internal/process-envelope"
      ) {
        return handleProcessEnvelope(this.createSyncContext(), request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/write-admission/acquire"
      ) {
        return this.handleWriteAdmissionAcquire(request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/write-admission/release"
      ) {
        return this.handleWriteAdmissionRelease(request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/replay-operation"
      ) {
        return handleReplayOperationInternal(this.createOpsContext(), request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/writeback-context"
      ) {
        return handleGetWritebackContext(this.createOpsContext(), request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/writeback-content"
      ) {
        return handleGetWritebackContentStream(
          this.createOpsContext(),
          request,
        );
      }
      if (request.method === "POST" && url.pathname === "/internal/cleanup") {
        return this.handleWorkspaceCleanup(request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/webhook-delivery-result"
      ) {
        return this.handleWebhookDeliveryResult(request);
      }
      // cloud#2029 follow-up #2: operator-triggered bounded legacy-draft drain
      // (dry-run by default; destructive only with explicit dryRun:false).
      if (
        request.method === "POST" &&
        url.pathname === "/internal/drain-legacy-writeback-drafts"
      ) {
        return handleDrainLegacyWritebackDrafts(
          this.createFsContext(),
          request,
        );
      }
      if (request.method === "GET" && url.pathname === "/ws") {
        return this.handleWebSocketUpgrade(request);
      }
      if (request.method === "POST" && url.pathname === "/list-tree") {
        return handleListTree(this.createFsContext(), request);
      }
      if (request.method === "POST" && url.pathname === "/read-file") {
        return handleReadFile(this.createFsContext(), request);
      }
      if (request.method === "POST" && url.pathname === "/write-file") {
        return handleWriteFile(this.createFsContext(), request);
      }
      if (request.method === "POST" && url.pathname === "/delete-file") {
        return handleDeleteFile(this.createFsContext(), request);
      }
      if (request.method === "POST" && url.pathname === "/list-events") {
        return handleListEvents(this.createFsContext(), request);
      }
      if (request.method === "POST" && url.pathname === "/query-files") {
        return handleQueryFiles(this.createFsContext(), request);
      }
      if (request.method === "POST" && url.pathname === "/bulk-write") {
        return handleBulkWrite(this.createFsContext(), request);
      }
      if (request.method === "POST" && url.pathname === "/export-workspace") {
        return handleExportWorkspace(this.createFsContext(), request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/export-manifest"
      ) {
        return handleExportManifest(this.createFsContext(), request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/read-file-metadata"
      ) {
        return handleReadFileMetadata(this.createFsContext(), request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/internal/register-imported-content"
      ) {
        return handleRegisterImportedContent(this.createFsContext(), request);
      }
      if (request.method === "POST" && url.pathname === "/dispatch-writeback") {
        return handleDispatchWriteback(this.createOpsContext(), request);
      }

      const workspaceRoute = parseWorkspaceRoute(url.pathname);
      if (workspaceRoute) {
        return this.handleWorkspaceRoute(request, workspaceRoute);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/internal/webhook-envelopes"
      ) {
        return handleInternalWebhookEnvelope(this.createSyncContext(), request);
      }

      const adminRoute = parseAdminRoute(url.pathname);
      if (adminRoute) {
        return handleAdminRoute(this.createAdminContext(), request, adminRoute);
      }

      return this.errorResponse(
        request,
        ERRORS.notFound.status,
        ERRORS.notFound.code,
        "route not found",
      );
    } catch (error) {
      return this.handleUnexpectedError(request, error);
    } finally {
      if (admission?.admit) {
        admission.release();
      }
    }
  }

  async alarm(): Promise<void> {
    const nowIso = new Date().toISOString();
    const dueOps = this.all<Row>(
      `
        SELECT op_id
        FROM operations
        WHERE status = 'pending'
          AND next_attempt_at IS NOT NULL
          AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT 100
      `,
      nowIso,
    );

    for (const row of dueOps) {
      const opId = asString(row.op_id);
      if (opId) {
        await dispatchWriteback(this.createOpsContext(), opId);
      }
    }

    // Run the debounced digest refresh if it's due (alarm-fire may have been
    // triggered for an op while a digest refresh is still pending in the
    // future — `runDueDigestRefresh` checks the wall clock before doing any
    // work). Doing this before the final `ensureNextAlarm` lets the digest
    // due-key be cleared so the alarm doesn't immediately re-fire.
    await this.runDueDigestRefresh();

    await ensureNextAlarm(this.createOpsContext());
  }

  /**
   * Arm a debounced digest regeneration. Called from the write/sync paths
   * via `scheduleDigestRefresh` on the fs and sync contexts. The actual
   * `refreshWorkspaceDigests` work runs inside `alarm()` so the write
   * response is never gated on it (cloud#846).
   */
  private async scheduleDigestRefresh(options: {
    changedPaths: readonly string[];
    generatedAt: Date;
    correlationId: string;
  }): Promise<void> {
    // Preserve the previous skip: digest-only or empty change sets never
    // arm a refresh (a write inside `/digests/` IS the refresh itself).
    if (
      options.changedPaths.length === 0 ||
      options.changedPaths.every((path) => isDigestPath(path))
    ) {
      return;
    }

    const existing = await this.state.storage.get<number>(
      DIGEST_REFRESH_DUE_STORAGE_KEY,
    );
    if (existing === undefined) {
      // Leading-edge debounce: the FIRST non-digest write in a quiet period
      // arms the alarm; subsequent writes within the window coalesce into
      // this one fire. Storing `now + debounce` (not a flag) lets
      // `ensureNextAlarm` reconcile against pending op retries with a
      // simple `Math.min`.
      await this.state.storage.put(
        DIGEST_REFRESH_DUE_STORAGE_KEY,
        Date.now() + DIGEST_REFRESH_DEBOUNCE_MS,
      );
    }
    // Always reconcile — even if the due key was already set, a new op may
    // have been queued in this same write and we want the earliest alarm.
    await ensureNextAlarm(this.createOpsContext());
  }

  /**
   * Run the deferred digest refresh if it's due. Called from `alarm()`.
   * Clears the due key BEFORE running so writes that land during the
   * refresh re-arm a fresh cycle rather than being dropped. A throw inside
   * `refreshWorkspaceDigests` is non-fatal: the next non-digest write will
   * re-arm the alarm.
   */
  private async runDueDigestRefresh(): Promise<void> {
    const dueAt = await this.state.storage.get<number>(
      DIGEST_REFRESH_DUE_STORAGE_KEY,
    );
    if (typeof dueAt !== "number" || dueAt > Date.now()) {
      // Either no refresh pending, or the alarm fired for a sooner op and
      // the digest is still in its debounce window. Leave the key in
      // place — `ensureNextAlarm` will re-set the alarm to `dueAt`.
      return;
    }
    await this.state.storage.delete(DIGEST_REFRESH_DUE_STORAGE_KEY);

    const workspaceId = await this.getWorkspaceId();
    if (!workspaceId) {
      return;
    }
    try {
      await refreshWorkspaceDigests(this.createFsContext(), workspaceId, {
        // No `changedPaths`: refreshWorkspaceDigests recomputes every default
        // window from the events table, so a path list isn't needed (and
        // capturing one over a debounce window would just duplicate the SQL).
        generatedAt: new Date(),
        correlationId: "digest-refresh",
        timeZone: this.bindings.RELAYFILE_DIGEST_TIMEZONE,
        // cloud#1251: env-tunable cap on per-refresh verb-override content reads
        // (undefined → digest.ts default). Lets us dial precision-vs-CPU without
        // a redeploy.
        verbOverrideMaxEvents: parseDigestVerbOverrideMaxEvents(
          (
            this.bindings as {
              RELAYFILE_DIGEST_VERB_OVERRIDE_MAX_EVENTS?: string;
            }
          ).RELAYFILE_DIGEST_VERB_OVERRIDE_MAX_EVENTS,
        ),
        verbOverrideBudgetBytes: parseDigestVerbOverrideBudgetBytes(
          this.bindings.RELAYFILE_DIGEST_VERB_OVERRIDE_BUDGET_BYTES,
        ),
      });
    } catch (err) {
      // Mirror the previous inline error policy: a failed digest refresh is
      // non-fatal. The next non-digest write re-arms the alarm.
      console.error("runDueDigestRefresh: refreshWorkspaceDigests failed", err);
    }
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await webSocketMessage(this.createWebSocketContext(), ws, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await webSocketClose(this.createWebSocketContext(), ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await webSocketError(this.createWebSocketContext(), ws, error);
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const workspaceId = await this.resolveWorkspaceId(request, {
      workspaceId: extractWorkspaceIdFromRequest(request) ?? undefined,
    });
    if (!workspaceId) {
      return this.errorResponse(
        request,
        ERRORS.invalidInput.status,
        ERRORS.invalidInput.code,
        "missing workspaceId",
      );
    }

    // WS handshakes cannot carry an `Authorization` header from a browser, so
    // the upgrade path opts into the `?token=` query credential. Ordinary
    // fs/ops/sync routes do NOT (Finding 3): see `resolveBearerAuthHeader`.
    const claims = await this.getRequestClaims(request, {
      allowQueryToken: true,
    });
    const access = resolveWebSocketSubtreeAccess(claims);
    if (!access.ok) {
      return this.errorResponse(
        request,
        access.status,
        access.code,
        access.message,
      );
    }
    const teamSubtreePrefix = access.teamSubtreePrefix;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Accept FIRST, then serialize the isolation state, per the Cloudflare DO
    // Hibernation API convention: the attachment is managed by the hibernation
    // manager, which the socket only joins on accept. Serializing before
    // accept can silently drop the attachment, which would fail OPEN after a
    // hibernation round-trip — a team-scoped subscriber would deserialize a
    // null prefix and receive every workspace + cross-team event (Finding 1).
    this.state.acceptWebSocket(server);
    if (typeof server.serializeAttachment !== "function") {
      // Fail LOUD rather than silently skipping the attachment (which would
      // also fail open): a freshly accepted socket without serializeAttachment
      // is a platform breakage, not a recoverable condition.
      throw new Error(
        "WebSocket.serializeAttachment unavailable after acceptWebSocket; " +
          "cannot persist team-subtree isolation state",
      );
    }
    server.serializeAttachment({
      teamSubtreePrefix,
    } satisfies WorkspaceWebSocketAttachment);

    const recentEvents = getRecentEvents(
      this.createFsContext(),
      workspaceId,
      100,
    ) as unknown as FilesystemEvent[];
    for (const event of recentEvents) {
      if (!eventMatchesTeamSubtree(event.path, teamSubtreePrefix)) {
        continue;
      }
      try {
        server.send(JSON.stringify(toWebSocketEventMessage(event)));
      } catch {
        break;
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleWorkspaceRoute(
    request: Request,
    route: WorkspaceRoute,
  ): Promise<Response> {
    await this.resolveWorkspaceId(request, { workspaceId: route.workspaceId });
    const joined = route.segments.join("/");

    if (request.method === "GET" && joined === "fs/tree") {
      return handleListTreeGet(this.createFsContext(), request);
    }
    if (request.method === "GET" && joined === "fs/file") {
      return handleReadFileGet(this.createFsContext(), request);
    }
    if (request.method === "PUT" && joined === "fs/file") {
      return handleWriteFile(this.createFsContext(), request);
    }
    if (request.method === "DELETE" && joined === "fs/file") {
      return handleDeleteFileAny(this.createFsContext(), request);
    }
    if (request.method === "GET" && joined === "fs/events") {
      return handleListEventsGet(this.createFsContext(), request);
    }
    if (request.method === "GET" && joined === "fs/changes") {
      return handleListChangesGet(this.createFsContext(), request);
    }
    if (request.method === "GET" && joined === "fs/changes/resource") {
      return handleGetChangeResourceGet(this.createFsContext(), request);
    }
    if (request.method === "GET" && joined === "fs/query") {
      return handleQueryFilesGet(this.createFsContext(), request);
    }
    if (request.method === "POST" && joined === "fs/bulk") {
      return handleBulkWrite(this.createFsContext(), request);
    }
    if (request.method === "GET" && joined === "fs/export") {
      return handleExportWorkspaceGet(this.createFsContext(), request);
    }
    if (request.method === "GET" && joined === "fs/ws") {
      return this.handleWebSocketUpgrade(request);
    }
    if (request.method === "GET" && joined === "ops") {
      return handleListOperationsGet(this.createOpsContext(), request);
    }
    if (
      request.method === "GET" &&
      route.segments[0] === "ops" &&
      route.segments.length === 2
    ) {
      return handleGetOperation(
        this.createOpsContext(),
        request,
        route.segments[1],
      );
    }
    if (
      request.method === "POST" &&
      route.segments[0] === "ops" &&
      route.segments[2] === "replay" &&
      route.segments.length === 3
    ) {
      return handleReplayOperation(
        this.createOpsContext(),
        request,
        route.segments[1],
      );
    }
    if (request.method === "GET" && joined === "sync/status") {
      return handleSyncStatus(this.createSyncContext(), request);
    }
    if (request.method === "GET" && joined === "sync/ingress") {
      return handleSyncIngress(this.createSyncContext(), request);
    }
    if (request.method === "POST" && joined === "sync/webhook-health") {
      return handleSyncWebhookHealth(this.createSyncContext(), request);
    }
    if (request.method === "GET" && joined === "sync/dead-letter") {
      return handleListDeadLetters(this.createSyncContext(), request);
    }
    if (
      request.method === "GET" &&
      route.segments[0] === "sync" &&
      route.segments[1] === "dead-letter" &&
      route.segments.length === 3
    ) {
      return handleGetDeadLetter(
        this.createSyncContext(),
        request,
        route.segments[2],
      );
    }
    if (
      request.method === "POST" &&
      route.segments[0] === "sync" &&
      route.segments[1] === "dead-letter" &&
      route.segments[3] === "replay" &&
      route.segments.length === 4
    ) {
      return handleReplayDeadLetter(
        this.createSyncContext(),
        request,
        route.segments[2],
      );
    }
    if (
      request.method === "POST" &&
      route.segments[0] === "sync" &&
      route.segments[1] === "dead-letter" &&
      route.segments[3] === "ack" &&
      route.segments.length === 4
    ) {
      return handleAckDeadLetter(
        this.createSyncContext(),
        request,
        route.segments[2],
      );
    }
    if (request.method === "POST" && joined === "sync/refresh") {
      return handleSyncRefresh(this.createSyncContext(), request);
    }
    if (request.method === "POST" && joined === "webhooks") {
      return this.handleCreateWebhookSubscription(request);
    }
    if (request.method === "GET" && joined === "webhooks") {
      return this.handleListWebhookSubscriptions(request);
    }
    if (
      request.method === "DELETE" &&
      route.segments[0] === "webhooks" &&
      route.segments.length === 2
    ) {
      return this.handleDeleteWebhookSubscription(request, route.segments[1]);
    }
    if (request.method === "POST" && joined === "webhooks/ingest") {
      return handleGenericWebhook(this.createSyncContext(), request);
    }
    if (request.method === "GET" && joined === "writeback/pending") {
      return handlePendingWritebacks(this.createOpsContext(), request);
    }
    // Mirror the relayfile daemon's `GET /v1/workspaces/{wsId}/writeback?state=…`
    // endpoint (added in relayfile#148) so cloud-hosted workspaces serve the
    // same `WritebackItem[]` shape `relayfile writeback list --state <state>`
    // expects. The single-segment match keeps the existing 2-segment
    // `writeback/pending` route intact for backward compatibility.
    if (
      request.method === "GET" &&
      route.segments.length === 1 &&
      route.segments[0] === "writeback"
    ) {
      return handleListWritebacks(this.createOpsContext(), request);
    }
    if (
      request.method === "POST" &&
      route.segments[0] === "writeback" &&
      route.segments[2] === "ack" &&
      route.segments.length === 3
    ) {
      return handleAckWriteback(
        this.createOpsContext(),
        request,
        route.segments[1],
      );
    }
    if (
      request.method === "PUT" &&
      route.segments[0] === "integrations" &&
      route.segments.length === 2
    ) {
      return handleUpsertIntegrationCredential(
        this.createIntegrationContext(),
        request,
        route.segments[1],
      );
    }
    if (
      request.method === "GET" &&
      route.segments[0] === "integrations" &&
      route.segments.length === 2
    ) {
      return handleGetIntegrationCredential(
        this.createIntegrationContext(),
        request,
        route.segments[1],
      );
    }

    return this.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      "route not found",
    );
  }

  private createAdapterContext(): WorkspaceAdapterContext {
    return {
      allRows: <T extends Row = Row>(query: string, ...bindings: unknown[]) =>
        this.all<T>(query, ...bindings),
      sqlExec: (query: string, ...bindings: unknown[]) => {
        this.sql.exec(query, ...bindings);
      },
      getFileRow: this.getFileRow.bind(this),
      getOperation: (opId: string) => getOperation({ sql: this.sql }, opId),
      insertEvent: this.insertEvent.bind(this),
      loadContent: this.loadContent.bind(this),
      nextId: this.nextId.bind(this),
      toWorkspaceFile: this.toWorkspaceFile.bind(this),
      toEvent: this.toEvent.bind(this),
      toWorkspaceOperation: this.toWorkspaceOperation.bind(this),
    };
  }

  private createStatsContext(): WorkspaceStatsContext {
    return {
      d1Run: (query: string, ...bindings: unknown[]) =>
        this.d1Run(query, ...bindings),
      d1First: <T extends Row>(query: string, ...bindings: unknown[]) =>
        this.d1First<T>(query, ...bindings),
      d1All: <T extends Row>(query: string, ...bindings: unknown[]) =>
        this.d1All<T>(query, ...bindings),
      all: <T extends Row>(query: string, ...bindings: unknown[]) =>
        this.all<T>(query, ...bindings),
      ingressQueueCapacity: INGRESS_QUEUE_CAPACITY,
    };
  }

  private createD1Context(): D1Context {
    return {
      bindings: this.bindings,
    };
  }

  private createFsContext(): WorkspaceFsContext {
    const errors: FsHandlerErrors = {
      invalidInput: ERRORS.invalidInput,
      notFound: ERRORS.notFound,
      preconditionFailed: ERRORS.preconditionFailed,
      revisionConflict: ERRORS.revisionConflict,
      payloadTooLarge: ERRORS.payloadTooLarge,
      badRequest: ERRORS.badRequest,
    };

    return {
      ...this.createAdapterContext(),
      errors,
      readJson: <T>(request: Request) => this.readJson<T>(request),
      resolveWorkspaceId: this.resolveWorkspaceId.bind(this),
      getRequestClaims: this.getRequestClaims.bind(this),
      internalHmacSecret: this.bindings.INTERNAL_HMAC_SECRET,
      json: this.json.bind(this),
      errorResponse: this.errorResponse.bind(this),
      correlationId: this.correlationId.bind(this),
      dedupKv: this.bindings.DEDUP_KV,
      putObject: this.putObject.bind(this),
      putObjectStream: this.putObjectStream.bind(this),
      deleteContent: (contentRef: string) =>
        this.bindings.CONTENT_BUCKET.delete(contentRef),
      contentRef: this.contentRef.bind(this),
      recordMutation: (input) => recordMutation(this.createOpsContext(), input),
      recordMutations: (inputs) =>
        recordMutations(this.createOpsContext(), inputs),
      syncWorkspaceStats: (workspaceId, overrides) =>
        syncWorkspaceStats(this.createStatsContext(), workspaceId, overrides),
      touchWorkspaceWriteStats: (workspaceId, overrides) =>
        touchWorkspaceWriteStats(
          this.createStatsContext(),
          workspaceId,
          overrides,
        ),
      touchWorkspaceActivity: (workspaceId) =>
        this.touchWorkspaceActivity(workspaceId),
      flushStorage: () => this.flushStorage(),
      scheduleDigestRefresh: (options) => this.scheduleDigestRefresh(options),
    };
  }

  private createOpsContext(): OpsHandlerContext {
    return {
      workspaceId: this.workspaceId,
      // Pass the full bindings record; the Pick in OpsHandlerContext now
      // includes CONTENT_BUCKET so handleGetWritebackContentStream can
      // stream R2 bodies straight to the executor without buffering.
      bindings: this.bindings,
      state: this.state,
      sql: this.sql,
      getFileRow: this.getFileRow.bind(this),
      loadContent: this.loadContent.bind(this),
      writeReceiptFile: ({ workspaceId, path, receipt, provider, correlationId }) =>
        writeSystemFileIfChanged(this.createSyncContext(), workspaceId, {
          path,
          content: JSON.stringify(receipt),
          contentType: "application/json",
          provider,
          correlationId,
        }).then(() => undefined),
      readJson: <T>(request: Request) => this.readJson<T>(request),
      resolveWorkspaceId: this.resolveWorkspaceId.bind(this),
      requireWorkspaceId: this.requireWorkspaceId.bind(this),
      getWorkspaceId: this.getWorkspaceId.bind(this),
      correlationId: this.correlationId.bind(this),
      json: this.json.bind(this),
      errorResponse: this.errorResponse.bind(this),
      coreStorageAdapter: (workspaceId: string, eventOptions) =>
        createCoreStorageAdapter(
          this.createAdapterContext(),
          workspaceId,
          undefined,
          eventOptions,
        ),
      broadcastEvent: (event) => this.broadcastEvent(event),
      flushStorage: () => this.flushStorage(),
      upsertWorkspaceOperation: (workspaceId, operation, createdAt) =>
        upsertWorkspaceOperation(
          this.createD1Context(),
          workspaceId,
          operation,
          createdAt,
        ),
      syncWorkspaceStats: (workspaceId, overrides) =>
        syncWorkspaceStats(this.createStatsContext(), workspaceId, overrides),
    };
  }

  private createSyncContext(): SyncHandlerContext {
    return {
      bindings: this.bindings,
      sql: this.sql,
      allRows: <T extends Row = Row>(query: string, ...bindings: unknown[]) =>
        this.all<T>(query, ...bindings),
      sqlExec: (query: string, ...bindings: unknown[]) => {
        this.sql.exec(query, ...bindings);
      },
      readJson: <T>(request: Request) => this.readJson<T>(request),
      requireWorkspaceId: this.requireWorkspaceId.bind(this),
      resolveWorkspaceId: this.resolveWorkspaceId.bind(this),
      correlationId: this.correlationId.bind(this),
      json: this.json.bind(this),
      errorResponse: this.errorResponse.bind(this),
      d1Run: (query: string, ...bindings: unknown[]) =>
        this.d1Run(query, ...bindings),
      d1First: <T extends Row>(query: string, ...bindings: unknown[]) =>
        this.d1First<T>(query, ...bindings),
      d1All: <T extends Row>(query: string, ...bindings: unknown[]) =>
        this.d1All<T>(query, ...bindings),
      ensureWorkspaceStats: (workspaceId: string) =>
        ensureWorkspaceStats(this.createStatsContext(), workspaceId),
      loadWorkspaceStats: (workspaceId: string) =>
        loadWorkspaceStats(this.createStatsContext(), workspaceId),
      buildSyncProviders: (workspaceId, providerStatus, providerFilter) =>
        buildSyncProviders(
          this.createStatsContext(),
          workspaceId,
          providerStatus,
          providerFilter,
        ),
      buildIngressStatus: (workspaceId, providerFilter) =>
        buildIngressStatus(
          this.createStatsContext(),
          workspaceId,
          providerFilter,
        ),
      bumpIngressMetric: (workspaceId, provider, update, lastIngestedAt) =>
        bumpIngressMetric(
          this.createStatsContext(),
          workspaceId,
          provider,
          update,
          lastIngestedAt,
        ),
      updateProviderStatus: (workspaceId, provider, updater) =>
        updateProviderStatus(
          this.createStatsContext(),
          workspaceId,
          provider,
          updater,
        ),
      syncWorkspaceStats: (workspaceId, overrides) =>
        syncWorkspaceStats(this.createStatsContext(), workspaceId, overrides),
      touchWorkspaceWriteStats: (workspaceId, overrides) =>
        touchWorkspaceWriteStats(
          this.createStatsContext(),
          workspaceId,
          overrides,
        ),
      nextId: this.nextId.bind(this),
      getFileRow: this.getFileRow.bind(this),
      toCoreFileRow: (file) => toCoreFileRow(file),
      contentRef: this.contentRef.bind(this),
      loadContent: this.loadContent.bind(this),
      putObject: this.putObject.bind(this),
      deleteContent: (contentRef: string) =>
        this.bindings.CONTENT_BUCKET.delete(contentRef),
      insertEvent: (event, options) =>
        this.insertEvent(event as FilesystemEvent, options),
      broadcastEvent: (event) => this.broadcastEvent(event as FilesystemEvent),
      flushStorage: () => this.flushStorage(),
      scheduleDigestRefresh: (options) => this.scheduleDigestRefresh(options),
    };
  }

  private createAdminContext(): AdminHandlerContext {
    return {
      ...this.createD1Context(),
      ...this.createStatsContext(),
      bindings: this.bindings,
      json: this.json.bind(this),
      errorResponse: this.errorResponse.bind(this),
      correlationId: this.correlationId.bind(this),
      errors: {
        notFound: ERRORS.notFound,
        invalidState: ERRORS.invalidState,
      },
      constants: {
        ingressQueueCapacity: INGRESS_QUEUE_CAPACITY,
        writebackQueueCapacity: WRITEBACK_QUEUE_CAPACITY,
        defaultIngressAlertProfile: DEFAULT_INGRESS_ALERT_PROFILE,
      },
    };
  }

  private createIntegrationContext(): IntegrationHandlerContext {
    return {
      sql: this.sql,
      one: <T extends Row = Row>(query: string, ...bindings: unknown[]) =>
        this.one<T>(query, ...bindings),
      readJson: <T>(request: Request) => this.readJson<T>(request),
      resolveWorkspaceId: this.resolveWorkspaceId.bind(this),
      json: this.json.bind(this),
      errorResponse: this.errorResponse.bind(this),
    };
  }

  private createWebSocketContext(): WebSocketHandlerContext {
    return {
      state: this.state,
      resolveWorkspaceId: this.resolveWorkspaceId.bind(this),
      errorResponse: this.errorResponse.bind(this),
      getRecentEvents: (limit: number) =>
        getRecentEvents(
          this.createFsContext(),
          this.workspaceId ?? "",
          limit,
        ) as unknown as FilesystemEvent[],
    };
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content_ref TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        encoding TEXT NOT NULL DEFAULT 'utf-8',
        updated_at TEXT NOT NULL,
        semantics_json TEXT NOT NULL DEFAULT '{}',
        provider TEXT NOT NULL DEFAULT '',
        provider_object_id TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        revision TEXT NOT NULL,
        origin TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        correlation_id TEXT NOT NULL DEFAULT '',
        timestamp TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS operations (
        op_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        revision TEXT NOT NULL,
        action TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        provider_result_json TEXT,
        correlation_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        -- Server-side threading: a reply op points at the parent message op so
        -- the cloud can order parent-before-child and inject thread_ts from the
        -- parent's delivered ts (no agent-side receipt round-trip). Null for the
        -- overwhelming majority of ops, which dispatch eagerly as before.
        parent_op_id TEXT
      );

      CREATE TABLE IF NOT EXISTS integrations (
        provider TEXT PRIMARY KEY,
        provider_config_key TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        alias_fields_json TEXT NOT NULL DEFAULT '{}',
        writeback_dispatch_via TEXT NOT NULL DEFAULT 'bridge',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS write_admission_leases (
        lease_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        write_class TEXT NOT NULL DEFAULT 'background_integration',
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        url TEXT NOT NULL,
        path_globs_json TEXT NOT NULL,
        secret TEXT NOT NULL,
        last_delivery_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_files_provider ON files(provider);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_provider_timestamp ON events(provider, timestamp);
      CREATE INDEX IF NOT EXISTS idx_operations_status_next_attempt ON operations(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_operations_created_at ON operations(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_write_admission_workspace_expires ON write_admission_leases(workspace_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_workspace ON webhook_subscriptions(workspace_id, created_at DESC);
    `);

    // Forward migration for content_hash column. DOs created before this
    // change will not have the column on existing files/events tables, and
    // CREATE TABLE IF NOT EXISTS won't add it. SQLite's ALTER TABLE ADD
    // COLUMN has no IF NOT EXISTS, so we attempt + swallow the duplicate
    // column error. Idempotent across hot starts and warm restarts.
    this.ensureColumn("files", "content_hash", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("events", "content_hash", "TEXT NOT NULL DEFAULT ''");
    // Server-side threading parent pointer (nullable, additive — no backfill).
    this.ensureColumn("operations", "parent_op_id", "TEXT");
    this.ensureColumn(
      "integrations",
      "writeback_dispatch_via",
      "TEXT NOT NULL DEFAULT 'bridge'",
    );
    this.ensureColumn(
      "write_admission_leases",
      "write_class",
      "TEXT NOT NULL DEFAULT 'background_integration'",
    );
  }

  private async handleWriteAdmissionAcquire(
    request: Request,
  ): Promise<Response> {
    const body = await this.readJson<{
      workspaceId?: string;
      purpose?: string;
      reason?: string;
      writeClass?: string;
      maxInflight?: number;
      foregroundReserved?: number;
      backgroundMax?: number;
      leaseTtlMs?: number;
      retryAfterSeconds?: number;
    }>(request);
    const workspaceId = body.workspaceId?.trim();
    if (!workspaceId) {
      return this.errorResponse(
        request,
        ERRORS.badRequest.status,
        ERRORS.badRequest.code,
        "missing workspaceId",
      );
    }

    const maxInflight = positiveInt(
      body.maxInflight,
      DEFAULT_WRITE_ADMISSION_MAX_INFLIGHT,
    );
    const foregroundReserved = clampInt(
      nonNegativeInt(
        body.foregroundReserved,
        DEFAULT_WRITE_ADMISSION_FOREGROUND_RESERVED,
      ),
      0,
      maxInflight,
    );
    const backgroundMax = clampInt(
      nonNegativeInt(body.backgroundMax, maxInflight - foregroundReserved),
      0,
      maxInflight,
    );
    const leaseTtlMs = positiveInt(
      body.leaseTtlMs,
      DEFAULT_WRITE_ADMISSION_LEASE_TTL_MS,
    );
    const retryAfterSeconds = positiveInt(
      body.retryAfterSeconds,
      DEFAULT_WRITE_ADMISSION_RETRY_AFTER_SECONDS,
    );
    const purpose = resolveWriteAdmissionLeaseReason(body);
    const writeClass = resolveWriteAdmissionClass(body.writeClass);
    const now = Date.now();
    this.sql.exec(
      "DELETE FROM write_admission_leases WHERE workspace_id = ? AND expires_at <= ?",
      workspaceId,
      now,
    );
    const active = asNumber(
      this.one<Row>(
        "SELECT COUNT(*) AS count FROM write_admission_leases WHERE workspace_id = ?",
        workspaceId,
      )?.count,
    );
    const foregroundActive = asNumber(
      this.one<Row>(
        `
          SELECT COUNT(*) AS count
          FROM write_admission_leases
          WHERE workspace_id = ?
            AND write_class IN ('foreground_control', 'foreground_content')
        `,
        workspaceId,
      )?.count,
    );
    const decision = decideWriteAdmission({
      writeClass,
      inflight: active,
      foregroundInflight: foregroundActive,
      maxInflight,
      foregroundReserved,
      backgroundMax,
    });
    const isForeground = isForegroundWriteAdmissionClass(writeClass);
    if (!decision.admit) {
      const activeLeases = this.writeAdmissionLeaseSample(workspaceId, now);
      console.warn("write_admission.reject", {
        workspaceId,
        purpose,
        writeClass,
        reason: decision.reason,
        inflight: active,
        foregroundInflight: foregroundActive,
        backgroundInflight: decision.backgroundInflight,
        maxInflight,
        foregroundReserved,
        backgroundMax,
        retryAfterSeconds,
        correlationId: this.correlationId(request),
        activeLeases,
      });
      return this.writeAdmissionBusyResponse(request, {
        purpose,
        writeClass,
        inflight: active,
        foregroundInflight: foregroundActive,
        backgroundInflight: decision.backgroundInflight,
        maxInflight,
        foregroundReserved,
        backgroundMax,
        retryAfterSeconds,
        activeLeases,
      });
    }

    const leaseId = crypto.randomUUID();
    console.info("write_admission.acquire", {
      workspaceId,
      purpose,
      writeClass,
      inflight: active + 1,
      foregroundInflight: foregroundActive + (isForeground ? 1 : 0),
      backgroundInflight: decision.backgroundInflight + (isForeground ? 0 : 1),
      maxInflight,
      foregroundReserved,
      backgroundMax,
      correlationId: this.correlationId(request),
    });
    this.sql.exec(
      `
        INSERT INTO write_admission_leases (lease_id, workspace_id, reason, write_class, acquired_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      leaseId,
      workspaceId,
      purpose,
      writeClass,
      now,
      now + leaseTtlMs,
    );
    return this.json(
      {
        ok: true,
        leaseId,
        expiresAt: new Date(now + leaseTtlMs).toISOString(),
      },
      200,
    );
  }

  private async handleWriteAdmissionRelease(
    request: Request,
  ): Promise<Response> {
    const body = await this.readJson<{
      workspaceId?: string;
      leaseId?: string;
    }>(request);
    const workspaceId = body.workspaceId?.trim();
    const leaseId = body.leaseId?.trim();
    if (!workspaceId || !leaseId) {
      return this.errorResponse(
        request,
        ERRORS.badRequest.status,
        ERRORS.badRequest.code,
        "missing workspaceId or leaseId",
      );
    }
    this.sql.exec(
      "DELETE FROM write_admission_leases WHERE workspace_id = ? AND lease_id = ?",
      workspaceId,
      leaseId,
    );
    return this.json({ ok: true }, 200);
  }

  private writeAdmissionBusyResponse(
    request: Request,
    details: {
      purpose: string;
      writeClass: WriteAdmissionClass;
      inflight: number;
      foregroundInflight: number;
      backgroundInflight: number;
      maxInflight: number;
      foregroundReserved: number;
      backgroundMax: number;
      retryAfterSeconds: number;
      activeLeases?: WriteAdmissionLeaseSample[];
    },
  ): Response {
    return new Response(
      JSON.stringify({
        code: "workspace_busy",
        message:
          "workspace write path is busy; retry after the advertised delay",
        correlationId: this.correlationId(request),
        retryAfterSeconds: details.retryAfterSeconds,
        reason: "write_admission_limit",
        purpose: details.purpose,
        writeClass: details.writeClass,
        inflight: details.inflight,
        foregroundInflight: details.foregroundInflight,
        backgroundInflight: details.backgroundInflight,
        maxInflight: details.maxInflight,
        foregroundReserved: details.foregroundReserved,
        backgroundMax: details.backgroundMax,
        activeLeases: details.activeLeases ?? [],
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(details.retryAfterSeconds),
        },
      },
    );
  }

  private writeAdmissionLeaseSample(
    workspaceId: string,
    now: number,
  ): WriteAdmissionLeaseSample[] {
    return this.all<Row>(
      `
        SELECT lease_id, reason, write_class, acquired_at, expires_at
        FROM write_admission_leases
        WHERE workspace_id = ? AND expires_at > ?
        ORDER BY acquired_at ASC
        LIMIT ?
      `,
      workspaceId,
      now,
      WRITE_ADMISSION_BUSY_LEASE_SAMPLE_LIMIT,
    ).map((row) => ({
      leaseId: asString(row.lease_id),
      purpose: asString(row.reason),
      writeClass: asString(row.write_class),
      ageMs: Math.max(0, now - asNumber(row.acquired_at)),
      expiresInMs: Math.max(0, asNumber(row.expires_at) - now),
    }));
  }

  private ensureColumn(table: string, column: string, columnDef: string): void {
    try {
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
    } catch (err) {
      // Already exists — SQLite raises "duplicate column name" or similar.
      // Other errors (e.g. table missing) would re-throw, but the table is
      // created above in initSchema, so the only realistic failure here is
      // the idempotency case.
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column|already exists/i.test(message)) {
        throw err;
      }
    }
  }

  private async getRequestClaims(
    request: Request,
    options: { allowQueryToken?: boolean } = {},
  ): Promise<TokenClaims | null> {
    // Default to header-only. Only the WS upgrade path opts into `?token=`
    // (Finding 3) — see `resolveBearerAuthHeader`. The fs-context binding at
    // `getRequestClaims: this.getRequestClaims.bind(this)` calls without
    // options, so fs/ops/sync routes never accept a query-string token.
    const authHeader = resolveBearerAuthHeader(request, {
      allowQueryToken: options.allowQueryToken ?? false,
    });
    if (!authHeader) {
      return null;
    }

    const workspaceId =
      extractWorkspaceIdFromRequest(request) ?? (await this.getWorkspaceId());
    if (!workspaceId) {
      return null;
    }

    return authorizeBearer(authHeader, this.bindings, workspaceId, "");
  }

  private getFileRow(path: string): WorkspaceFile | null {
    const row = this.one<Row>(
      `
        SELECT path, revision, content_type, content_ref, size, encoding, updated_at, semantics_json,
               provider, provider_object_id, content_hash
        FROM files
        WHERE path = ?
      `,
      path,
    );
    return row ? this.toWorkspaceFile(row) : null;
  }

  private async loadContent(
    contentRef: string,
    encoding: "utf-8" | "base64",
    maxBytes = this.resolveMaxReadBytes(),
  ): Promise<string> {
    if (!contentRef) {
      return "";
    }
    const object = await this.bindings.CONTENT_BUCKET.get(contentRef);
    if (!object) {
      throw new Error(`content missing from R2: ${contentRef}`);
    }
    return streamR2ObjectContent(object, encoding, maxBytes, contentRef);
  }

  private resolveMaxReadBytes(): number {
    const raw = (this.bindings as { RELAYFILE_MAX_READ_BYTES?: string })
      .RELAYFILE_MAX_READ_BYTES;
    if (!raw) {
      return DEFAULT_MAX_READ_BYTES;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_MAX_READ_BYTES;
  }

  private async putObject(
    contentRef: string,
    content: string,
    encoding: "utf-8" | "base64",
    contentType: string,
    workspaceId: string,
    path: string,
    revision: string,
  ): Promise<void> {
    const body = await r2ContentBody(content, encoding);

    await this.bindings.CONTENT_BUCKET.put(contentRef, body, {
      httpMetadata: { contentType },
      customMetadata: {
        workspaceId,
        path,
        revision,
        encoding,
      },
    });
  }

  /**
   * Streaming variant of {@link putObject} used by the writeback-ingest
   * streaming path (hardening item 2). The body is a ReadableStream<Uint8Array>;
   * R2 consumes it directly without the DO ever materializing the full
   * payload in the isolate heap.
   */
  private async putObjectStream(
    contentRef: string,
    body: ReadableStream<Uint8Array>,
    encoding: "utf-8" | "base64",
    contentType: string,
    workspaceId: string,
    path: string,
    revision: string,
  ): Promise<void> {
    await this.bindings.CONTENT_BUCKET.put(contentRef, body, {
      httpMetadata: { contentType },
      customMetadata: {
        workspaceId,
        path,
        revision,
        encoding,
      },
    });
  }

  private contentRef(
    workspaceId: string,
    path: string,
    revision: string,
  ): string {
    return `${workspaceId}${normalizePath(path)}@${revision}`;
  }

  private toWorkspaceFile(row: Row): WorkspaceFile {
    return {
      path: normalizePath(asString(row.path)),
      revision: asString(row.revision),
      contentType: asString(row.content_type),
      contentRef: asString(row.content_ref),
      size: asNumber(row.size),
      encoding: normalizeEncoding(asString(row.encoding)) ?? "utf-8",
      provider: asString(row.provider),
      providerObjectId: asString(row.provider_object_id),
      updatedAt: asString(row.updated_at),
      semanticsJson: asString(row.semantics_json) || "{}",
      // SELECTs that pre-date the migration won't include content_hash —
      // asString returns "" on undefined, which is the same value the
      // schema default applies for legacy rows.
      contentHash: asString(row.content_hash),
    };
  }

  private toWorkspaceOperation(row: Row): WorkspaceOperation {
    return {
      opId: asString(row.op_id),
      path: normalizePath(asString(row.path)),
      revision: asString(row.revision),
      action: (asString(row.action) ||
        "file_upsert") as WorkspaceOperation["action"],
      provider: asString(row.provider),
      status: (asString(row.status) ||
        "pending") as WorkspaceOperation["status"],
      attemptCount: asNumber(row.attempt_count),
      nextAttemptAt: asOptionalString(row.next_attempt_at) ?? null,
      lastError: asOptionalString(row.last_error) ?? null,
      providerResultJson: asOptionalString(row.provider_result_json) ?? null,
      correlationId: asString(row.correlation_id),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at) || new Date().toISOString(),
      completedAt: row.completed_at ? asString(row.completed_at) : null,
    };
  }

  private toEvent(row: Row): WorkspaceEvent {
    return {
      eventId: asString(row.event_id),
      type: asString(row.type) as WorkspaceEvent["type"],
      path: normalizePath(asString(row.path)),
      revision: asString(row.revision),
      origin: (asString(row.origin) || "system") as WorkspaceEvent["origin"],
      provider: asString(row.provider),
      correlationId: asString(row.correlation_id),
      timestamp: asString(row.timestamp),
      contentHash: asString(row.content_hash),
    };
  }

  private insertEvent(
    event: FilesystemEvent,
    options?: { broadcast?: boolean },
  ): void {
    // Look up the file row written by the same envelope/write so the event
    // carries the exact contentHash for the (path, revision) it points
    // at. For deletes and non-file events, the file row is gone (or never
    // existed) — store an empty string and let the daemon's cross-check
    // skip those events naturally (it only fires when both sides have a
    // hash for the same revision).
    const contentHash = this.lookupContentHashForEvent(event);

    this.sql.exec(
      `
        INSERT INTO events (
          event_id, type, path, revision, origin, provider, correlation_id, timestamp, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      event.eventId,
      event.type,
      event.path,
      event.revision,
      event.origin,
      event.provider ?? "",
      event.correlationId ?? "",
      event.timestamp,
      contentHash,
    );
    if (options?.broadcast !== false) {
      // Attach contentHash to the broadcast payload so connected daemons can
      // run the cross-check on real-time WS events too — not just on
      // /v1/workspaces/{id}/fs/events polls.
      this.broadcastToMatchingSockets({
        ...event,
        contentHash,
      } as FilesystemEvent & {
        contentHash: string;
      });
    }
  }

  private broadcastEvent(event: FilesystemEvent): void {
    // Recompute contentHash here so post-flush broadcasts (issued by
    // sync.applyEnvelope after insertEvent({broadcast:false})) carry the
    // same hash on the wire as the event row that was persisted.
    const contentHash = this.lookupContentHashForEvent(event);
    this.broadcastToMatchingSockets({
      ...event,
      contentHash,
    } as FilesystemEvent & {
      contentHash: string;
    });
  }

  private broadcastToMatchingSockets(
    event: FilesystemEvent & { contentHash?: string },
  ): void {
    const payload = JSON.stringify(toWebSocketEventMessage(event));
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment?.() as unknown;
      if (!shouldDeliverEventToSocket(attachment, event.path)) {
        continue;
      }
      try {
        socket.send(payload);
      } catch {
        // Socket may have closed between enumeration and send.
      }
    }
    this.enqueueMatchingWebhookDeliveries(event);
  }

  // Delivery ordering: events are enqueued in broadcast order but the CF Queue
  // consumer delivers them concurrently across subscriptions. Receivers MUST NOT
  // assume in-order delivery. Reconcile on `revision`; dedupe on `eventId`.
  // Gap recovery: if the subscriber endpoint is down past the retry budget,
  // events dead-letter. On cold-start the receiver must backfill via
  // GET /v1/workspaces/{id}/fs/events?cursor= before resuming live delivery.
  private enqueueMatchingWebhookDeliveries(
    event: FilesystemEvent & { contentHash?: string },
  ): void {
    const queue = this.bindings.WEBHOOK_QUEUE;
    if (!queue) {
      return;
    }
    const workspaceId = this.workspaceId;
    if (!workspaceId) {
      return;
    }
    const rows = this.all<Row>(
      `
        SELECT subscription_id, url, path_globs_json, secret
        FROM webhook_subscriptions
        WHERE workspace_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `,
      workspaceId,
      MAX_WEBHOOK_FANOUT_PER_EVENT + 1,
    );
    let matched = 0;
    const enqueuedAt = new Date().toISOString();
    for (const row of rows) {
      const pathGlobs = parseJsonValue<string[]>(
        asString(row.path_globs_json),
        [],
      );
      if (!eventMatchesAnyWebhookGlob(event.path, pathGlobs)) {
        continue;
      }
      matched += 1;
      if (matched > MAX_WEBHOOK_FANOUT_PER_EVENT) {
        console.warn("relayfile webhook fanout cap reached", {
          workspaceId,
          eventId: event.eventId,
          limit: MAX_WEBHOOK_FANOUT_PER_EVENT,
        });
        break;
      }
      const message = {
        type: "webhook_delivery",
        deliveryId: `whdel_${crypto.randomUUID()}`,
        workspaceId,
        subscriptionId: asString(row.subscription_id),
        url: asString(row.url),
        secret: asString(row.secret),
        event: {
          ...event,
          origin: event.origin ?? "system",
          correlationId: event.correlationId ?? "",
        },
        enqueuedAt,
      } satisfies WebhookDeliveryQueueMessage;
      this.state.waitUntil(
        queue.send(message).catch((error) => {
          console.warn("relayfile webhook enqueue failed", {
            workspaceId,
            eventId: event.eventId,
            subscriptionId: message.subscriptionId,
            error: sanitizeWebhookDeliveryError(error),
          });
        }),
      );
    }
  }

  private lookupContentHashForEvent(event: FilesystemEvent): string {
    if (event.type !== "file.created" && event.type !== "file.updated") {
      // Deletes and sync.* events have no defining content bytes — emit
      // "" so the daemon's `tracked.Hash != event.ContentHash`
      // comparison short-circuits to false for these events.
      return "";
    }
    // The file row's revision must match the event's revision exactly.
    // If a newer write has already landed (e.g. concurrent update),
    // reading the row's hash would be wrong — fail closed and emit ""
    // rather than give the daemon a hash that doesn't match the rev it's
    // looking at.
    const row = this.one<Row>(
      "SELECT revision, content_hash FROM files WHERE path = ?",
      event.path,
    );
    if (!row) {
      return "";
    }
    if (asString(row.revision) !== event.revision) {
      return "";
    }
    return asString(row.content_hash);
  }

  private async flushStorage(): Promise<void> {
    // Force pending SQL writes durable before performing non-transactional
    // side effects (R2 putObject, WS broadcast). If the implicit DO
    // transaction throws AFTER an R2 write or broadcast has already happened,
    // the rev counter and files row would silently roll back, leaving R2 +
    // any subscribed daemon ahead of cloud's view of the world. See PR for
    // full failure mode (rev_96 hash divergence on workspace rw_91c99e4d).
    const storage = this.state.storage as DurableObjectStorage & {
      sync?: () => Promise<void>;
    };
    if (typeof storage.sync === "function") {
      await storage.sync();
    }
  }

  private async d1Run(query: string, ...bindings: unknown[]): Promise<void> {
    await d1Run(this.createD1Context(), query, ...bindings);
  }

  private async d1First<T extends Row>(
    query: string,
    ...bindings: unknown[]
  ): Promise<T | null> {
    return d1First<T>(this.createD1Context(), query, ...bindings);
  }

  private async d1All<T extends Row>(
    query: string,
    ...bindings: unknown[]
  ): Promise<T[]> {
    return d1All<T>(this.createD1Context(), query, ...bindings);
  }

  private one<T extends Row>(query: string, ...bindings: unknown[]): T | null {
    const cursor = this.sql.exec(query, ...bindings) as {
      one?: <R>() => R | null;
      toArray?: <R>() => R[];
      [Symbol.iterator]?: () => Iterator<T>;
    };
    if (typeof cursor.one === "function") {
      try {
        return cursor.one<T>() ?? null;
      } catch {
        if (typeof cursor.toArray === "function") {
          const rows = cursor.toArray<T>();
          return rows[0] ?? null;
        }
      }
    }
    if (typeof cursor.toArray === "function") {
      const rows = cursor.toArray<T>();
      return rows[0] ?? null;
    }
    const iteratorFactory = cursor[Symbol.iterator];
    if (typeof iteratorFactory === "function") {
      const first = iteratorFactory.call(cursor).next();
      return first.done ? null : first.value;
    }
    return null;
  }

  private all<T extends Row>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.sql.exec(query, ...bindings) as {
      toArray?: <R>() => R[];
      [Symbol.iterator]?: () => Iterator<T>;
    };
    if (typeof cursor.toArray === "function") {
      return cursor.toArray<T>();
    }
    if (cursor[Symbol.iterator]) {
      return Array.from(cursor as Iterable<T>);
    }
    return [];
  }

  private nextId(prefix: "rev" | "evt" | "op"): string {
    const current =
      Number.parseInt(this.getMeta(`counter:${prefix}`) ?? "0", 10) || 0;
    const next = current + 1;
    this.setMeta(`counter:${prefix}`, String(next));
    return `${prefix}_${next}`;
  }

  private getMeta(key: string): string | null {
    const row = this.one<Row>("SELECT value FROM meta WHERE key = ?", key);
    return row ? asString(row.value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      `
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      key,
      value,
    );
  }

  private async touchWorkspaceActivity(workspaceId: string): Promise<void> {
    const now = new Date();
    const lastTouchedAt = this.getMeta("workspace:last_activity_touched_at");
    const lastTouchedMs = lastTouchedAt
      ? Date.parse(lastTouchedAt)
      : Number.NaN;
    if (
      Number.isFinite(lastTouchedMs) &&
      now.getTime() - lastTouchedMs < WORKSPACE_ACTIVITY_TOUCH_INTERVAL_MS
    ) {
      return;
    }

    const touchedAt = now.toISOString();
    await touchWorkspaceActivity(
      this.createStatsContext(),
      workspaceId,
      touchedAt,
    );
    this.setMeta("workspace:last_activity_touched_at", touchedAt);
  }

  private async handleWorkspaceCleanup(request: Request): Promise<Response> {
    const workspaceId = await this.resolveWorkspaceId(request);
    if (!workspaceId) {
      throw toHttpError(400, "invalid_input", "missing workspaceId");
    }

    const deletedFiles = asNumber(
      this.one<Row>("SELECT COUNT(*) AS count FROM files")?.count,
    );
    this.sql.exec("DELETE FROM files");
    this.sql.exec("DELETE FROM events");
    this.sql.exec("DELETE FROM operations");
    this.sql.exec("DELETE FROM integrations");
    this.sql.exec("DELETE FROM webhook_subscriptions");
    this.sql.exec("DELETE FROM meta");
    await this.state.storage.delete("workspace_id");
    await this.state.storage.deleteAlarm();
    this.workspaceId = null;

    return this.json({
      workspaceId,
      deletedFiles,
      status: "cleaned",
    });
  }

  private async handleCreateWebhookSubscription(
    request: Request,
  ): Promise<Response> {
    const workspaceId = await this.requireWorkspaceId(request);
    const body = await this.readJson<WebhookSubscriptionCreateRequest>(request);
    const pathGlobs = Array.isArray(body.pathGlobs)
      ? body.pathGlobs.filter((glob) => typeof glob === "string" && glob.trim())
      : [];
    if (!body.url || pathGlobs.length === 0) {
      return this.errorResponse(
        request,
        ERRORS.badRequest.status,
        ERRORS.badRequest.code,
        "missing url or pathGlobs",
      );
    }

    const count = asNumber(
      this.one<Row>(
        "SELECT COUNT(*) AS count FROM webhook_subscriptions WHERE workspace_id = ?",
        workspaceId,
      )?.count,
    );
    if (count >= MAX_WEBHOOK_SUBSCRIPTIONS_PER_WORKSPACE) {
      return this.errorResponse(
        request,
        429,
        "subscription_limit_exceeded",
        "webhook subscription limit exceeded",
        { limit: MAX_WEBHOOK_SUBSCRIPTIONS_PER_WORKSPACE },
      );
    }

    const now = new Date().toISOString();
    const subscriptionId = `whsub_${crypto.randomUUID()}`;
    const providedSecret =
      typeof body.secret === "string" ? body.secret.trim() : "";
    const generatedSecret = providedSecret
      ? null
      : randomBase64Url(DEFAULT_WEBHOOK_SECRET_BYTES);
    const secret = providedSecret || generatedSecret || "";
    this.sql.exec(
      `
        INSERT INTO webhook_subscriptions (
          subscription_id, workspace_id, url, path_globs_json, secret,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      subscriptionId,
      workspaceId,
      body.url,
      JSON.stringify(pathGlobs),
      secret,
      now,
      now,
    );

    return this.json(
      {
        subscriptionId,
        ...(generatedSecret ? { secret: generatedSecret } : {}),
      } satisfies WebhookSubscriptionCreateResponse,
      201,
    );
  }

  private async handleListWebhookSubscriptions(
    request: Request,
  ): Promise<Response> {
    const workspaceId = await this.requireWorkspaceId(request);
    const rows = this.all<Row>(
      `
        SELECT subscription_id, url, path_globs_json, last_delivery_at,
               last_success_at, last_error, consecutive_failures, created_at, updated_at
        FROM webhook_subscriptions
        WHERE workspace_id = ?
        ORDER BY created_at DESC
      `,
      workspaceId,
    );
    return this.json(rows.map((row) => this.toWebhookSubscription(row)));
  }

  private async handleDeleteWebhookSubscription(
    request: Request,
    subscriptionId: string,
  ): Promise<Response> {
    const workspaceId = await this.requireWorkspaceId(request);
    const existing = this.one<Row>(
      "SELECT subscription_id FROM webhook_subscriptions WHERE workspace_id = ? AND subscription_id = ?",
      workspaceId,
      subscriptionId,
    );
    if (!existing) {
      return this.errorResponse(
        request,
        ERRORS.notFound.status,
        ERRORS.notFound.code,
        ERRORS.notFound.message,
      );
    }
    this.sql.exec(
      "DELETE FROM webhook_subscriptions WHERE workspace_id = ? AND subscription_id = ?",
      workspaceId,
      subscriptionId,
    );
    return new Response(null, { status: 204 });
  }

  private async handleWebhookDeliveryResult(
    request: Request,
  ): Promise<Response> {
    const body = await this.readJson<
      WebhookDeliveryQueueMessage & {
        success?: boolean;
        attemptCount?: number;
        error?: string;
      }
    >(request);
    const workspaceId = body.workspaceId?.trim();
    const subscriptionId = body.subscriptionId?.trim();
    if (!workspaceId || !subscriptionId) {
      return this.errorResponse(
        request,
        ERRORS.badRequest.status,
        ERRORS.badRequest.code,
        "missing workspaceId or subscriptionId",
      );
    }

    const now = new Date().toISOString();
    if (body.success) {
      this.sql.exec(
        `
          UPDATE webhook_subscriptions
          SET last_delivery_at = ?,
              last_success_at = ?,
              last_error = NULL,
              consecutive_failures = 0,
              updated_at = ?
          WHERE workspace_id = ? AND subscription_id = ?
        `,
        now,
        now,
        now,
        workspaceId,
        subscriptionId,
      );
      return this.json({ status: "acknowledged", id: body.deliveryId });
    }

    const error = sanitizeWebhookDeliveryError(body.error);
    this.sql.exec(
      `
        UPDATE webhook_subscriptions
        SET last_delivery_at = ?,
            last_error = ?,
            consecutive_failures = consecutive_failures + 1,
            updated_at = ?
        WHERE workspace_id = ? AND subscription_id = ?
      `,
      now,
      error,
      now,
      workspaceId,
      subscriptionId,
    );
    return this.json({ status: "acknowledged", id: body.deliveryId });
  }

  private toWebhookSubscription(row: Row): WebhookSubscription {
    return {
      id: asString(row.subscription_id),
      url: asString(row.url),
      pathGlobs: parseJsonValue<string[]>(asString(row.path_globs_json), []),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      health: {
        lastDeliveryAt: asString(row.last_delivery_at) || null,
        lastSuccessAt: asString(row.last_success_at) || null,
        lastError: asString(row.last_error) || null,
        consecutiveFailures: asNumber(row.consecutive_failures),
      },
    };
  }

  private async readJson<T>(request: Request): Promise<T> {
    try {
      return (await request.json()) as T;
    } catch {
      throw toHttpError(400, "bad_request", "invalid json body");
    }
  }

  private async requireWorkspaceId(request: Request): Promise<string> {
    const workspaceId = await this.resolveWorkspaceId(request, {
      workspaceId: extractWorkspaceIdFromRequest(request) ?? undefined,
    });
    if (!workspaceId) {
      throw toHttpError(400, "invalid_input", "missing workspaceId");
    }
    return workspaceId;
  }

  private async resolveWorkspaceId(
    request: Request,
    body?: { workspaceId?: string },
  ): Promise<string | null> {
    const explicit =
      body?.workspaceId?.trim() ||
      extractWorkspaceIdFromRequest(request) ||
      this.workspaceId ||
      (await this.state.storage.get<string>("workspace_id")) ||
      null;

    if (!explicit) {
      return null;
    }
    if (this.workspaceId !== explicit) {
      this.workspaceId = explicit;
      await this.state.storage.put("workspace_id", explicit);
    }
    return explicit;
  }

  private async getWorkspaceId(): Promise<string | null> {
    return (
      this.workspaceId ??
      (await this.state.storage.get<string>("workspace_id")) ??
      null
    );
  }

  private json(
    payload: unknown,
    status = 200,
    headers?: HeadersInit,
  ): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(headers ?? {}),
      },
    });
  }

  private errorResponse(
    request: Request,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Response {
    return this.json(
      {
        code,
        message,
        correlationId: this.correlationId(request),
        ...(details ? details : {}),
      },
      status,
    );
  }

  private correlationId(request: Request): string {
    return request.headers.get("X-Correlation-Id")?.trim() ?? "";
  }

  private backpressureResponse(
    request: Request,
    rejection: InflightAdmissionRejection,
  ): Response {
    const contract = inflightAdmissionHttpContract(
      rejection,
      this.correlationId(request),
    );
    return this.json(contract.body, contract.status, contract.headers);
  }

  private handleUnexpectedError(request: Request, error: unknown): Response {
    if (isHttpError(error)) {
      return this.errorResponse(
        request,
        error.status,
        error.code,
        error.message,
        error.details,
      );
    }
    return this.errorResponse(
      request,
      ERRORS.internal.status,
      ERRORS.internal.code,
      error instanceof Error && error.message
        ? error.message
        : ERRORS.internal.message,
    );
  }
}

export function deriveTeamSubtreePrefix(
  claims: TokenClaims | null,
): string | null {
  if (!claims) {
    return null;
  }

  let teamPrefix: string | null = null;
  for (const scope of claims.scopes) {
    const grant = parseFilesystemScopeGrant(scope);
    if (!grant.relevant) {
      continue;
    }
    if (!grant.teamPrefix) {
      return null;
    }
    if (teamPrefix && teamPrefix !== grant.teamPrefix) {
      return null;
    }
    teamPrefix = grant.teamPrefix;
  }

  return teamPrefix;
}

export type WebSocketSubtreeAccess =
  | { ok: true; teamSubtreePrefix: string | null }
  | { ok: false; status: 401 | 403; code: string; message: string };

export function resolveWebSocketSubtreeAccess(
  claims: TokenClaims | null,
): WebSocketSubtreeAccess {
  if (!claims) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "unauthorized",
    };
  }

  let sawFilesystemGrant = false;
  let sawWorkspaceRootGrant = false;
  let teamPrefix: string | null = null;
  for (const scope of claims.scopes) {
    const grant = parseFilesystemScopeGrant(scope);
    if (!grant.relevant) {
      continue;
    }
    sawFilesystemGrant = true;
    if (grant.workspaceRoot) {
      sawWorkspaceRootGrant = true;
      continue;
    }
    if (!grant.teamPrefix) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "filesystem scope is not eligible for websocket subscription",
      };
    }
    if (teamPrefix && teamPrefix !== grant.teamPrefix) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "filesystem scopes span multiple team subtrees",
      };
    }
    teamPrefix = grant.teamPrefix;
  }

  if (!sawFilesystemGrant) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: "missing filesystem scopes",
    };
  }
  if (sawWorkspaceRootGrant) {
    return { ok: true, teamSubtreePrefix: null };
  }
  if (teamPrefix) {
    return { ok: true, teamSubtreePrefix: teamPrefix };
  }

  return {
    ok: false,
    status: 403,
    code: "forbidden",
    message: "missing eligible websocket filesystem scopes",
  };
}

function parseFilesystemScopeGrant(scope: string):
  | { relevant: false }
  | {
      relevant: true;
      teamPrefix: string | null;
      workspaceRoot: boolean;
    } {
  const segments = scope.split(":");
  const hasPlane = segments[0] === "relayfile" || segments[0] === "*";
  const resource = hasPlane ? segments[1] : segments[0];
  const action = hasPlane ? segments[2] : segments[1];
  const path = segments.slice(hasPlane ? 3 : 2).join(":");

  if (resource !== "fs" && resource !== "*") {
    return { relevant: false };
  }
  if (
    action !== "read" &&
    action !== "write" &&
    action !== "manage" &&
    action !== "*"
  ) {
    return { relevant: false };
  }
  if (!path || path === "*") {
    return { relevant: true, teamPrefix: null, workspaceRoot: true };
  }

  return {
    relevant: true,
    teamPrefix: teamPrefixFromScopePath(path),
    workspaceRoot: false,
  };
}

function teamPrefixFromScopePath(path: string): string | null {
  const pathWithoutWildcard = path.endsWith("/*") ? path.slice(0, -2) : path;
  const normalized = normalizePath(pathWithoutWildcard);
  const segments = normalized.split("/").filter(Boolean);
  if (segments[0] !== "teams" || !segments[1]) {
    return null;
  }
  return `/teams/${segments[1]}`;
}

export function pathIsInsidePrefix(path: string, prefix: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPrefix = normalizePath(prefix);
  return (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  );
}

/**
 * Realtime delivery predicate for the team-subtree isolation boundary
 * (spec §10/§15). A `null` prefix (root/parent token) matches every event; a
 * `/teams/{id}` prefix matches only events at or inside that subtree.
 */
export function eventMatchesTeamSubtree(
  eventPath: string,
  teamSubtreePrefix: string | null,
): boolean {
  if (teamSubtreePrefix === null) {
    return true;
  }
  const normalizedTeamSubtreePrefix =
    normalizeTeamSubtreePrefix(teamSubtreePrefix);
  if (!normalizedTeamSubtreePrefix) {
    return false;
  }
  return pathIsInsidePrefix(eventPath, normalizedTeamSubtreePrefix);
}

function normalizeTeamSubtreePrefix(prefix: string): string | null {
  const normalized = normalizePath(prefix);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "teams" || !segments[1]) {
    return null;
  }
  return `/teams/${segments[1]}`;
}

/**
 * Resolve the team-subtree isolation state persisted on a hibernatable
 * WebSocket. The attachment is written exactly once, immediately after
 * `acceptWebSocket`, for every connection (root sockets get `null`).
 *
 *   - `{ evaluated: true, teamSubtreePrefix }` — the socket's scope was
 *     evaluated at upgrade time. `null` is an unconstrained root/parent token;
 *     a string is a `/teams/{id}` confinement.
 *   - `{ evaluated: false }` — no well-formed attachment is present, so the
 *     socket's scope was never recorded. Callers MUST treat this as "unknown",
 *     never as "unconstrained".
 */
export function resolveSocketSubtreePrefix(
  attachment: unknown,
):
  | { evaluated: false }
  | { evaluated: true; teamSubtreePrefix: string | null } {
  if (
    attachment &&
    typeof attachment === "object" &&
    "teamSubtreePrefix" in attachment
  ) {
    const value = (attachment as { teamSubtreePrefix: unknown })
      .teamSubtreePrefix;
    if (typeof value === "string") {
      const normalizedTeamSubtreePrefix = normalizeTeamSubtreePrefix(value);
      if (normalizedTeamSubtreePrefix) {
        return {
          evaluated: true,
          teamSubtreePrefix: normalizedTeamSubtreePrefix,
        };
      }
    }
    if (value === null) {
      return { evaluated: true, teamSubtreePrefix: null };
    }
  }
  return { evaluated: false };
}

/**
 * Decide whether a single hibernatable socket should receive an event, given
 * the isolation attachment serialized onto it. This is the realtime half of
 * the team-subtree isolation boundary (spec §10/§15).
 *
 * Fail CLOSED on an unevaluated attachment: a socket whose scope cannot be
 * read receives nothing rather than the entire workspace. A missed event is a
 * liveness blip the client recovers from on reconnect; delivering another
 * team's events would be a confidentiality breach — the exact failure this
 * slice exists to prevent. With serialize-after-accept (Finding 1) the
 * attachment is well-formed for every live socket, so this branch only fires
 * on a genuinely lost attachment.
 */
export function shouldDeliverEventToSocket(
  attachment: unknown,
  eventPath: string,
): boolean {
  const resolution = resolveSocketSubtreePrefix(attachment);
  if (!resolution.evaluated) {
    return false;
  }
  return eventMatchesTeamSubtree(eventPath, resolution.teamSubtreePrefix);
}

/**
 * Resolve the bearer credential for a DO request.
 *
 * The `Authorization` header is the only credential accepted on ordinary
 * (fs/ops/sync) routes. A `?token=` query parameter is honored ONLY when the
 * caller opts in (`allowQueryToken: true`) — the WebSocket upgrade path, where
 * browsers cannot set `Authorization` on the handshake. Honoring `?token=`
 * everywhere would leak bearer tokens into access logs, proxies, browser
 * history and `Referer` on every route (Finding 3), so the default is
 * header-only.
 */
export function resolveBearerAuthHeader(
  request: Request,
  options: { allowQueryToken: boolean },
): string | null {
  const headerAuth = request.headers.get("Authorization")?.trim();
  if (headerAuth) {
    return headerAuth;
  }
  if (options.allowQueryToken) {
    const queryToken = new URL(request.url).searchParams.get("token")?.trim();
    if (queryToken) {
      return `Bearer ${queryToken}`;
    }
  }
  return null;
}

function parseWorkspaceRoute(pathname: string): WorkspaceRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "v1" || segments[1] !== "workspaces" || !segments[2]) {
    return null;
  }
  return {
    workspaceId: segments[2],
    segments: segments.slice(3),
  };
}

function parseAdminRoute(pathname: string): AdminRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "v1" || segments[1] !== "admin") {
    return null;
  }
  return { segments: segments.slice(2) };
}

function extractWorkspaceIdFromRequest(request: Request): string | null {
  const path = parseWorkspaceRoute(new URL(request.url).pathname);
  return (
    path?.workspaceId ??
    request.headers.get("X-Workspace-Id")?.trim() ??
    new URL(request.url).searchParams.get("workspace_id")?.trim() ??
    null
  );
}

function parseJsonValue<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sanitizeWebhookDeliveryError(error: unknown): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? "unknown error");
  return message
    .replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/bearer\s+[A-Za-z0-9._~\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(
      /x-relay-signature\s*[:=]\s*[a-f0-9]+/gi,
      "x-relay-signature=[REDACTED]",
    )
    .slice(0, 1000);
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : "/";
}

function normalizeEncoding(encoding?: string): "utf-8" | "base64" | null {
  const value = encoding?.trim().toLowerCase() ?? "";
  if (!value || value === "utf-8" || value === "utf8") {
    return "utf-8";
  }
  if (value === "base64") {
    return "base64";
  }
  return null;
}

function parseDigestVerbOverrideMaxEvents(
  raw: string | undefined,
): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  // >= 0 so an explicit "0" disables verb overrides entirely; an unset/invalid
  // value returns undefined → refreshWorkspaceDigests uses its built-in default.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseDigestVerbOverrideBudgetBytes(
  raw: string | undefined,
): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  // >= 0 so an explicit "0" disables the aggregate byte budget; unset/invalid
  // values return undefined so refreshWorkspaceDigests uses its default.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveInt(
  raw: number | string | undefined,
  fallback: number,
): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  }
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(
  raw: number | string | undefined,
  fallback: number,
): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
  }
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isHttpError(value: unknown): value is HttpErrorShape {
  return Boolean(
    value &&
    typeof value === "object" &&
    "status" in value &&
    "code" in value &&
    "message" in value,
  );
}

function toHttpError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HttpErrorShape {
  return { status, code, message, details };
}
