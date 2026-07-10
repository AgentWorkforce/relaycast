import type { SyncProviderStatusState } from "@relayfile/sdk";

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
  revision: string;
  provider?: string;
  providerObjectId?: string;
  size?: number;
  updatedAt?: string;
  propertyCount?: number;
  relationCount?: number;
  permissionCount?: number;
  commentCount?: number;
}

export interface TreeResponse {
  path: string;
  entries: TreeEntry[];
  nextCursor: string | null;
}

export interface FileSemantics {
  properties?: Record<string, string>;
  relations?: string[];
  permissions?: string[];
  comments?: string[];
}

export interface FileReadResponse {
  path: string;
  revision: string;
  contentType: string;
  /**
   * Decoded (utf-8) or base64-encoded body, depending on `encoding`.
   *
   * `null` is reserved for the writeback-context flow: when the WorkspaceDO
   * elides a file body larger than its inline threshold, it returns
   * `content: null` (alongside `contentInline: false`) so consumers MUST
   * hydrate the body out-of-band via
   * `POST /internal/writeback-content` before use. Older daemons that
   * destructure `file.content` as a string will fail loudly on null
   * instead of silently writing an empty file to the provider.
   *
   * Every other code path (file-read, export, etc.) sets a string here.
   */
  content: string | null;
  encoding?: string;
  provider?: string;
  providerObjectId?: string;
  lastEditedAt?: string;
  semantics?: FileSemantics;
}

export interface FileWriteRequest {
  contentType?: string;
  content: string;
  encoding?: string;
  semantics?: FileSemantics;
}

export interface FileQueryItem {
  path: string;
  revision: string;
  contentType: string;
  provider?: string;
  providerObjectId?: string;
  lastEditedAt?: string;
  size: number;
  properties?: Record<string, string>;
  relations?: string[];
  permissions?: string[];
  comments?: string[];
}

export interface FileQueryResponse {
  items: FileQueryItem[];
  nextCursor: string | null;
}

export type BulkWriteFile =
  | {
      op?: "upsert";
      path: string;
      dependsOn?: string[];
      contentType: string;
      content: string;
      encoding?: string;
      semantics?: FileSemantics;
      contentIdentity?: {
        kind: string;
        key: string;
        ttlSeconds?: number;
      };
    }
  | {
      op: "delete";
      path: string;
      dependsOn?: string[];
      baseRevision?: string;
    };

export interface BulkWriteError {
  path: string;
  code: string;
  message: string;
}

export interface BulkWriteDedupedFile {
  path: string;
  deduped: true;
  originalWriter: string;
  revision: null;
}

export interface BulkWriteResponse {
  written: number;
  errorCount: number;
  errors: BulkWriteError[];
  correlationId: string;
  dedupedFiles?: BulkWriteDedupedFile[];
}

export interface WriteQueuedResponse {
  opId: string;
  status: "queued" | "pending";
  targetRevision: string;
  writeback?: {
    provider?: string;
    state?: WritebackState;
  };
}

export type FilesystemEventType =
  | "file.created"
  | "file.updated"
  | "file.deleted"
  | "dir.created"
  | "dir.deleted"
  | "sync.error"
  | "sync.ignored"
  | "sync.suppressed"
  | "sync.stale"
  | "writeback.failed"
  | "writeback.succeeded";

export type EventOrigin = "provider_sync" | "agent_write" | "system";

export interface FilesystemEvent {
  eventId: string;
  type: FilesystemEventType;
  path: string;
  revision: string;
  origin: EventOrigin;
  provider?: string;
  correlationId: string;
  timestamp: string;
  contentHash?: string;
}

export interface EventFeedResponse {
  events: FilesystemEvent[];
  nextCursor: string | null;
}

export interface WebhookSubscriptionHealth {
  lastDeliveryAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface WebhookSubscription {
  id: string;
  url: string;
  pathGlobs: string[];
  createdAt: string;
  updatedAt: string;
  health: WebhookSubscriptionHealth;
}

export interface WebhookSubscriptionCreateRequest {
  url: string;
  pathGlobs: string[];
  secret?: string;
}

export interface WebhookSubscriptionCreateResponse {
  subscriptionId: string;
  /**
   * Returned only when relayfile generated the subscription secret because the
   * caller did not provide one. It is never returned by list/get routes.
   */
  secret?: string;
}

export interface WebhookDeliveryQueueMessage {
  type: "webhook_delivery";
  deliveryId: string;
  workspaceId: string;
  subscriptionId: string;
  url: string;
  secret: string;
  event: FilesystemEvent;
  enqueuedAt: string;
}

export interface WebhookDeliveryDeadLetterItem {
  deliveryId: string;
  workspaceId: string;
  subscriptionId: string;
  eventId: string;
  url: string;
  failedAt: string;
  attemptCount: number;
  lastError: string;
  replayCount: number;
  status: "dead_lettered" | "queued" | "delivered";
}

export interface WebhookDeliveryDeadLetterFeedResponse {
  items: WebhookDeliveryDeadLetterItem[];
  nextCursor: string | null;
}

export type ExportFormat = "json" | "tar" | "patch";
export type WritebackActionType = "file_upsert" | "file_delete";
export type WritebackState =
  | "pending"
  | "succeeded"
  | "failed"
  | "dead_lettered";

export interface OperationStatusResponse {
  opId: string;
  path?: string;
  revision?: string;
  action?: WritebackActionType;
  provider?: string;
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "dead_lettered"
    | "canceled";
  attemptCount: number;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  providerResult?: Record<string, unknown>;
  correlationId?: string;
}

export type WorkspaceOperationStatus =
  | OperationStatusResponse["status"]
  | "dispatched";

export interface OperationFeedResponse {
  items: OperationStatusResponse[];
  nextCursor: string | null;
}

export interface SyncProviderStatus {
  provider: string;
  status: SyncProviderStatusState;
  cursor?: string | null;
  watermarkTs?: string | null;
  lagSeconds?: number;
  lastError?: string | null;
  failureCodes?: Record<string, number>;
  deadLetteredEnvelopes?: number;
  deadLetteredOps?: number;
  webhookHealthy?: boolean;
  webhookLastEventAt?: string | null;
  webhookLastError?: string | null;
}

export interface SyncStatusResponse {
  workspaceId: string;
  providers: SyncProviderStatus[];
}

export interface ProviderIngressStatus {
  acceptedTotal: number;
  droppedTotal: number;
  dedupedTotal: number;
  coalescedTotal: number;
  pendingTotal: number;
  oldestPendingAgeSeconds: number;
  suppressedTotal: number;
  staleTotal: number;
  dedupeRate: number;
  coalesceRate: number;
}

export interface IngressStatusResponse {
  workspaceId: string;
  queueDepth: number;
  queueCapacity: number;
  queueUtilization: number;
  pendingTotal: number;
  oldestPendingAgeSeconds: number;
  deadLetterTotal: number;
  deadLetterByProvider: Record<string, number>;
  acceptedTotal: number;
  droppedTotal: number;
  dedupedTotal: number;
  coalescedTotal: number;
  dedupeRate: number;
  coalesceRate: number;
  suppressedTotal: number;
  staleTotal: number;
  ingressByProvider: Record<string, ProviderIngressStatus>;
}

export interface BackendStatusResponse {
  backendProfile: string;
  stateBackend: string;
  envelopeQueue: string;
  envelopeQueueDepth: number;
  envelopeQueueCapacity: number;
  writebackQueue: string;
  writebackQueueDepth: number;
  writebackQueueCapacity: number;
}

export interface DeadLetterItem {
  envelopeId: string;
  workspaceId: string;
  provider: string;
  deliveryId: string;
  correlationId?: string;
  failedAt: string;
  attemptCount: number;
  lastError: string;
}

export interface DeadLetterFeedResponse {
  items: DeadLetterItem[];
  nextCursor: string | null;
}

export interface SyncRefreshRequest {
  provider: string;
  reason?: string;
}

export interface QueuedResponse {
  status: "queued";
  id: string;
  correlationId?: string;
}

export interface AckResponse {
  status: "acknowledged";
  id: string;
  correlationId?: string;
}

export interface ErrorResponse {
  code: string;
  message: string;
  correlationId: string;
  details?: Record<string, unknown>;
}

export interface ConflictErrorResponse extends ErrorResponse {
  expectedRevision: string;
  currentRevision: string;
  currentContentPreview?: string;
}

// Re-export the canonical `WritebackItem` shape from `@relayfile/sdk` so the
// cloud worker speaks the same row contract as the relayfile daemon (the
// daemon serves the same shape from `internal/httpapi/server.go` via
// `relayfile writeback list`). The narrow legacy fields the existing
// `writeback/pending` handler emitted are a strict subset of this shape
// (everything beyond `id|workspaceId|path|revision|correlationId` is
// optional), so existing callers continue to work unchanged.
export type {
  WritebackItem,
  WritebackListState,
  WritebackDeadLetterError,
  WritebackDeadLetterErrorCode,
} from "@relayfile/sdk";

export interface WritebackListResponse {
  items: import("@relayfile/sdk").WritebackItem[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface WritebackQueueMessage {
  opId: string;
  workspaceId: string;
  path: string;
  revision: string;
  correlationId?: string;
  /**
   * Parent-dependency: the parent op's delivered provider object id, set by the
   * DO when it releases a held child op from the parent's ack. The provider uses
   * it to reference the parent (the slack provider injects it as `thread_ts` so a
   * reply threads without an agent-side receipt round-trip). Absent otherwise.
   */
  parentExternalId?: string;
}

export interface WritebackExecutionContextResponse {
  workspaceId: string;
  operation: {
    opId: string;
    path: string;
    revision: string;
    action: WritebackActionType;
    provider: string;
    status: string;
    correlationId: string;
  };
  file: FileReadResponse | null;
  /**
   * When `false`, `file.content` was elided from this response because the
   * stored body was larger than the WorkspaceDO inline threshold (returning
   * a multi-megabyte JSON string from a Durable Object is the primary OOM
   * vector). Consumers MUST hydrate the content out-of-band via
   * `POST /internal/writeback-content` before using `file.content`.
   *
   * Wire shape in this case: `file.content === null`. The cloud previously
   * sent `""` here, which let pre-`contentInline` daemons silently write an
   * empty file to the provider. Sending `null` makes those daemons fail
   * loudly (TypeError / schema-validation error) instead of corrupting
   * data. The streaming hydrator in `provider-executor.ts` detects
   * `content === null` and pulls the body before passing the file to a
   * provider.
   *
   * Defaults to `true` (inline) when omitted, so older callers continue to
   * work unchanged for normal-sized files.
   */
  contentInline?: boolean;
  /**
   * Size in bytes of the stored file body (decoded). Present whenever
   * `file` is non-null so callers can size their R2 fetch buffers and log
   * accurate writeback metrics without re-reading the body.
   */
  contentSize?: number;
}

export interface IngressStatusMapResponse {
  generatedAt: string;
  alertProfile: "strict" | "balanced" | "relaxed";
  effectiveAlertProfile: "strict" | "balanced" | "relaxed" | "custom";
  workspaceCount: number;
  returnedWorkspaceCount: number;
  workspaceIds: string[];
  nextCursor: string | null;
  pendingTotal: number;
  deadLetterTotal: number;
  acceptedTotal: number;
  droppedTotal: number;
  dedupedTotal: number;
  coalescedTotal: number;
  suppressedTotal: number;
  staleTotal: number;
  thresholds: {
    pending: number;
    deadLetter: number;
    stale: number;
    dropRate: number;
  };
  alertTotals: {
    total: number;
    critical: number;
    warning: number;
    byType: Record<string, number>;
  };
  alertsTruncated: boolean;
  alerts: Array<{
    workspaceId: string;
    type: "dead_letters" | "pending_backlog" | "drop_rate" | "stale_events";
    severity: "warning" | "critical";
    value: number;
    threshold: number;
    message: string;
  }>;
  workspaces: Record<string, IngressStatusResponse>;
}

export interface AdminSyncStatusMapResponse {
  generatedAt: string;
  workspaceCount: number;
  returnedWorkspaceCount: number;
  workspaceIds: string[];
  nextCursor: string | null;
  providerStatusCount: number;
  healthyCount: number;
  laggingCount: number;
  errorCount: number;
  pausedCount: number;
  deadLetteredEnvelopesTotal: number;
  deadLetteredOpsTotal: number;
  thresholds: {
    statusError: number;
    lagSeconds: number;
    deadLetteredEnvelopes: number;
    deadLetteredOps: number;
  };
  alertTotals: {
    total: number;
    critical: number;
    warning: number;
    byType: Record<string, number>;
  };
  alertsTruncated: boolean;
  alerts: Array<{
    workspaceId: string;
    provider: string;
    type:
      | "status_error"
      | "lag_seconds"
      | "dead_lettered_envelopes"
      | "dead_lettered_ops";
    severity: "warning" | "critical";
    value: number;
    threshold: number;
    message: string;
  }>;
  failureCodes: Record<string, number>;
  workspaces: Record<string, SyncStatusResponse>;
}

export interface WorkspaceFile {
  path: string;
  revision: string;
  contentType: string;
  contentRef: string;
  size: number;
  encoding: "utf-8" | "base64";
  provider: string;
  providerObjectId: string;
  updatedAt: string;
  semanticsJson: string;
  /**
   * SHA-256 hex of the raw content bytes. Empty string for legacy rows
   * written before the column existed; populated on every new write.
   * Surfaced on fs/file, fs/tree, and fs/events responses so the daemon
   * defensive cross-check from relayfile PR #90 becomes active.
   */
  contentHash: string;
}

export interface WorkspaceOperation {
  opId: string;
  path: string;
  revision: string;
  action: WritebackActionType;
  provider: string;
  status: WorkspaceOperationStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  providerResultJson: string | null;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface WorkspaceEvent {
  eventId: string;
  type: FilesystemEventType;
  path: string;
  revision: string;
  origin: EventOrigin;
  provider: string;
  correlationId: string;
  timestamp: string;
  /**
   * SHA-256 hex of the file's content at this event's revision. Empty
   * string (or undefined) for non-file events (sync.error etc) and for
   * delete events. Surfaced on fs/events responses + WS broadcasts so the
   * daemon's defensive cross-check from relayfile PR #90 becomes active.
   */
  contentHash?: string;
}

export interface WebhookEnvelopeRequest {
  envelopeId?: string;
  workspaceId: string;
  provider: string;
  deliveryId?: string;
  receivedAt?: string;
  headers?: Record<string, string>;
  payload: Record<string, unknown>;
  correlationId?: string;
}
