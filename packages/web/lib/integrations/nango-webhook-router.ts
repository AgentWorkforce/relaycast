import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Nango } from "@nangohq/node";
import {
  buildDeletionRecord,
  createWebhookSyncJob,
  writeBatchToRelayfile,
} from "@cloud/core/sync/record-writer.js";
import { sql } from "drizzle-orm";
import { isGeneratedNangoProviderModel } from "@cloud/core/sync/nango-provider-parity.js";
import type {
  NangoCheckpoint,
  NangoCheckpointRange,
  NangoSyncResponseResults,
  NangoSyncType,
} from "@cloud/core/sync/nango-sync-job.js";
import {
  NOTION_PAGE_CONTENT_MODEL,
  NOTION_PAGE_MODEL,
  buildNotionContentRecord,
  buildNotionPageRecord,
  extractNotionParentInfo,
  type NotionPageContentRecord,
  type NotionPageRecord,
} from "@cloud/core/sync/notion-record-shapes.js";
import {
  COMPANY_OBJECT_TYPE_ID,
  COMPANY_PROPERTIES,
  CONTACT_OBJECT_TYPE_ID,
  CONTACT_PROPERTIES,
  DEAL_OBJECT_TYPE_ID,
  DEAL_PROPERTIES,
  HUBSPOT_COMPANY_MODEL,
  HUBSPOT_CONTACT_MODEL,
  HUBSPOT_DEAL_MODEL,
  HUBSPOT_TICKET_MODEL,
  TICKET_OBJECT_TYPE_ID,
  TICKET_PROPERTIES,
  buildHubSpotCompanyRecord,
  buildHubSpotContactRecord,
  buildHubSpotDealRecord,
  buildHubSpotTicketRecord,
  extractHubspotWebhookObjectIds,
  type HubSpotAssociationClient,
  type HubSpotRawObject,
} from "@cloud/core/sync/hubspot-record-shapes.js";
import {
  markProviderInitialSyncFailed,
  markProviderInitialSyncQueued,
  markProviderOAuthConnected,
  writeProviderReadiness,
} from "@cloud/core/provider-readiness.js";
import { isValidWorkspaceIdAny } from "@cloud/core/workspace/id.js";
import { eventScopedSyncPaths } from "@cloud/core/relayfile/event-scopes.js";
import {
  linearCommentPath,
  linearAgentWebhookEventPath,
  normalizeLinearWebhook,
  type NormalizedWebhook as LinearNormalizedWebhook,
} from "@relayfile/adapter-linear";
import { routeDaytonaWebhook } from "@/lib/integrations/daytona-hookdeck-webhook";
import { normalizeGcpWebhook } from "@relayfile/adapter-gcp";
import { normalizeCloudflareWebhook } from "@relayfile/adapter-cloudflare/webhook";
import { normalizeFathomWebhook } from "@relayfile/adapter-fathom/webhook";
import { normalizeDropboxWebhook } from "@relayfile/adapter-dropbox/webhook-normalizer";
import { optionalEnv } from "@/lib/env";
import { getDb } from "@/lib/db";
import {
  buildGitHubWebhookFileData,
  enrichGitHubWatchPayload,
  buildGitHubWebhookIngestData,
  createGitHubRelayfileClient,
  getGitHubWebhookRecordWriterTarget,
  type GitHubNormalizedWebhook,
} from "@/lib/integrations/github-relayfile";
import { registry as integrationFanoutRegistry } from "@/lib/integrations/fanout";
import { getSlackConnectionIdentity } from "@/lib/integrations/nango-slack";
import { enqueueNangoSyncJob } from "@/lib/integrations/nango-sync-queue";
import { resolveRelayfileCredentialWorkspaceId } from "@/lib/integrations/relayfile-integration-push";
import {
  logNangoDbWorkspaceDiagnostic,
} from "@/lib/integrations/nango-db-workspace-diagnostic";
import {
  enqueueIncrementalCloneJob,
  readPriorCloneManifest,
} from "@/lib/integrations/github-incremental-sync-trigger";
import { upsertGithubInstallationIndex } from "@/lib/integrations/github-installation-index";
import {
  getNangoConnectionDetails,
  getNangoSecretKey,
  getProviderConfigKey,
  probeNangoConnectionLiveness,
  triggerNangoSyncs,
} from "@/lib/integrations/nango-service";
import { ensureWorkspaceNangoSyncSchedules } from "@/lib/integrations/nango-sync-subscription-recovery";
import {
  WORKSPACE_INTEGRATION_PROVIDERS,
  type WorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import { reportWorkspaceProviderWebhookHealth } from "@/lib/integrations/provider-status";
import { readIntegrationConnectionScopeFromRecord } from "@/lib/integrations/integration-scope";
import {
  GITHUB_OAUTH_IDENTITY_PROVIDER,
  isGithubOauthIdentityConfigKey,
} from "@/lib/integrations/github-oauth-identity";
import {
  deleteUserIntegration,
  findUserIntegrationByConnection,
  upsertUserIntegration,
} from "@/lib/integrations/user-integrations";
import { logger } from "@/lib/logger";
import { handleRickySlackForward } from "@/lib/ricky/slack/ingress";
import { claimWebhookDelivery, releaseWebhookDelivery } from "@/lib/ricky/webhook-dedup";
import {
  deleteWorkspaceIntegration,
  findAllWorkspaceIntegrationsByInstallation,
  findSlackIntegrationByConnectionId,
  findSlackIntegrationByTeamId,
  findWorkspaceIntegrationByProviderAliasAndConnection,
  findWorkspaceIntegrationByConnection,
  findWorkspaceIntegrationByInstallation,
  getRecentWorkspaceIntegrationDisconnect,
  insertWorkspaceIntegrationIfAbsent,
  recordWorkspaceIntegrationDisconnect,
  replaceWorkspaceIntegrationConnectionIfStale,
  updateWorkspaceIntegrationMetadata,
  upsertWorkspaceIntegration,
} from "@/lib/integrations/workspace-integrations";
import {
  extractSlackConnectionIdentityFromForwardPayload,
  hasSlackConnectionIdentity,
  mergeSlackConnectionIdentity,
  mergeSlackConnectionIdentityMetadata,
} from "@/lib/integrations/slack-identity";
import { forwardSlackToRelay } from "@/lib/integrations/slack-relay-bridge/bridge";
import { createRelaycastPoster } from "@/lib/integrations/slack-relay-bridge/relaycast";
import { createSlackRelayBridgeStore } from "@/lib/integrations/slack-relay-bridge/store";
import {
  bootstrapRegistryFromEnv,
  type NormalizedWebhook,
  type WebhookProvider,
} from "@/lib/integrations/webhook-consumer-registry";
import { computeLinearPath, linearIssueByStatePath } from "@relayfile/adapter-linear/path-mapper";
import { computeFathomPath } from "@relayfile/adapter-fathom/path-mapper";
import { computeGcpPath } from "@relayfile/adapter-gcp/path-mapper";
import {
  directMessagePath as slackDirectMessagePath,
  directMessageThreadReplyPath as slackDirectMessageThreadReplyPath,
  messagePath as slackMessagePath,
  slackChannelsIndexPath,
  threadPath as slackThreadPath,
  threadReplyPath as slackThreadReplyPath,
} from "@relayfile/adapter-slack/path-mapper";
import { readCloudflareWaitUntil } from "@/lib/proactive-runtime/cloudflare-waituntil";
import { resolveAppWorkspaceIdForRuntime } from "@/lib/workspaces/workspace-integration-identity-core";


const NANGO_HMAC_HEADER = "x-nango-hmac-sha256";
const LEGACY_NANGO_SIGNATURE_HEADER = "x-nango-signature";
const GITHUB_EVENT_HEADER = "x-github-event";
const GITHUB_DELIVERY_HEADER = "x-github-delivery";
const GITLAB_DELIVERY_HEADER = "x-gitlab-event-uuid";
const DEFAULT_SAGE_WEBHOOK_URL = "https://sage.agentrelay.com";
const DEFAULT_SAGE_WEBHOOK_URL_DEV = "http://localhost:3777";
const RELAYFILE_FILE_UPDATED_EVENT = "file.updated";
const RELAYFILE_FILE_DELETED_EVENT = "file.deleted";
const RELAYFILE_PRIMARY_CONSUMER_ID = "relayfile-primary";
const LINEAR_ISSUES_SYNC_NAME = "fetch-active-issues";
const LINEAR_COMMENTS_SYNC_NAME = "fetch-comments";
const GITLAB_PROVIDER = "gitlab";
const GITLAB_ISSUES_SYNC_NAME = "fetch-issues";
const GITLAB_MERGE_REQUESTS_SYNC_NAME = "fetch-merge-requests";
const GITLAB_COMMITS_SYNC_NAME = "fetch-commits";
const GITLAB_PIPELINES_SYNC_NAME = "fetch-pipelines";
const GITLAB_DEPLOYMENTS_SYNC_NAME = "fetch-deployments";
const GITLAB_TAGS_SYNC_NAME = "fetch-tags";
const GITLAB_ISSUE_MODEL = "GitLabIssue";
const GITLAB_MERGE_REQUEST_MODEL = "GitLabMergeRequest";
const GITLAB_COMMIT_MODEL = "GitLabCommit";
const GITLAB_PIPELINE_MODEL = "GitLabPipeline";
const GITLAB_PIPELINE_JOB_MODEL = "GitLabPipelineJob";
const GITLAB_DEPLOYMENT_MODEL = "GitLabDeployment";
const GITLAB_TAG_MODEL = "GitLabTag";
type GitLabForwardModel =
  | typeof GITLAB_ISSUE_MODEL
  | typeof GITLAB_MERGE_REQUEST_MODEL
  | typeof GITLAB_COMMIT_MODEL
  | typeof GITLAB_PIPELINE_MODEL
  | typeof GITLAB_PIPELINE_JOB_MODEL
  | typeof GITLAB_DEPLOYMENT_MODEL
  | typeof GITLAB_TAG_MODEL;
const SLACK_MESSAGE_MODEL = "SlackMessage";
const SLACK_CHANNEL_MODEL = "SlackChannel";
const SLACK_USER_MODEL = "SlackUser";
const GOOGLE_MAIL_PROVIDER = "google-mail";
const GOOGLE_CALENDAR_PROVIDER = "google-calendar";
const GRANOLA_PROVIDER = "granola";
const RECALL_PROVIDER = "recall";
const FATHOM_PROVIDER = "fathom";
const MEETING_ACTIONS_PERSONA_SLUG = "meeting-actions";
const QUESTION_CHANNEL_INPUT = "QUESTION_CHANNEL";
const SLACK_CHANNEL_INPUT = "SLACK_CHANNEL";
const HUBSPOT_PROVIDER = "hubspot";
const DOCKER_HUB_PROVIDER = "docker-hub";
const REDDIT_PROVIDER = "reddit";
const DROPBOX_PROVIDER = "dropbox";
const GCP_PROVIDER = "gcp";
const CLOUDFLARE_PROVIDER = "cloudflare";
const GCP_MONITORING_ALERTS_SYNC = "fetch-monitoring-alerts";
const GCP_MONITORING_ALERT_MODEL = "GcpMonitoringAlert";
const CLOUDFLARE_NOTIFICATION_EVENTS_SYNC = "fetch-notification-events";
const CLOUDFLARE_NOTIFICATION_EVENT_MODEL = "CloudflareNotificationEvent";
const HUBSPOT_FORWARD_OBJECTS = [
  {
    objectTypeId: CONTACT_OBJECT_TYPE_ID,
    plural: "contacts",
    model: HUBSPOT_CONTACT_MODEL,
    syncName: "fetch-contacts",
    properties: CONTACT_PROPERTIES,
    includeAssociationChange: false,
  },
  {
    objectTypeId: COMPANY_OBJECT_TYPE_ID,
    plural: "companies",
    model: HUBSPOT_COMPANY_MODEL,
    syncName: "fetch-companies",
    properties: COMPANY_PROPERTIES,
    includeAssociationChange: false,
  },
  {
    objectTypeId: DEAL_OBJECT_TYPE_ID,
    plural: "deals",
    model: HUBSPOT_DEAL_MODEL,
    syncName: "fetch-deals",
    properties: DEAL_PROPERTIES,
    includeAssociationChange: true,
  },
  {
    objectTypeId: TICKET_OBJECT_TYPE_ID,
    plural: "tickets",
    model: HUBSPOT_TICKET_MODEL,
    syncName: "fetch-tickets",
    properties: TICKET_PROPERTIES,
    includeAssociationChange: false,
  },
] as const;
const GOOGLE_MAIL_MESSAGES_SYNC_NAME = "fetch-messages";
const GOOGLE_MAIL_THREADS_SYNC_NAME = "fetch-threads";
const GOOGLE_MAIL_MESSAGE_MODEL = "GoogleMailMessage";
const GOOGLE_MAIL_THREAD_MODEL = "GoogleMailThread";
const GOOGLE_MAIL_WEBHOOK_SYNC_NAMES = [GOOGLE_MAIL_MESSAGES_SYNC_NAME, GOOGLE_MAIL_THREADS_SYNC_NAME] as const;
const GOOGLE_MAIL_RELAYFILE_WRITE_ATTEMPTS = 3;
const GOOGLE_MAIL_PROXY_RETRY_AFTER_MAX_MS = 2_000;
const GOOGLE_CALENDAR_EVENTS_SYNC = "fetch-events";
const GOOGLE_CALENDAR_ACLS_SYNC = "fetch-acls";
const GOOGLE_CALENDAR_LIST_SYNC = "fetch-calendars";
const GOOGLE_CALENDAR_SETTINGS_SYNC = "fetch-settings";
const GRANOLA_NOTES_SYNC = "fetch-notes";
const GRANOLA_FOLDERS_SYNC = "fetch-folders";
const GRANOLA_SYNC_NAMES = [GRANOLA_NOTES_SYNC, GRANOLA_FOLDERS_SYNC] as const;
const RECALL_RECORDINGS_SYNC = "fetch-recordings";
const RECALL_TRANSCRIPTS_SYNC = "fetch-transcripts";
const RECALL_SYNC_NAMES = [RECALL_RECORDINGS_SYNC, RECALL_TRANSCRIPTS_SYNC] as const;
const FATHOM_MEETINGS_SYNC = "fetch-meetings";
const FATHOM_RECORDING_SUMMARIES_SYNC = "fetch-recording-summaries";
const FATHOM_RECORDING_TRANSCRIPTS_SYNC = "fetch-recording-transcripts";
const FATHOM_MEETING_MODEL = "FathomMeeting";
const FATHOM_RECORDING_SUMMARY_MODEL = "FathomRecordingSummary";
const FATHOM_RECORDING_TRANSCRIPT_MODEL = "FathomRecordingTranscript";
const DROPBOX_FILES_SYNC = "fetch-files";
const DROPBOX_FOLDERS_SYNC = "fetch-folders";
const DROPBOX_SHARED_FOLDERS_SYNC = "fetch-shared-folders";
const DROPBOX_SHARED_LINKS_SYNC = "fetch-shared-links";
const DROPBOX_SYNC_NAMES = [
  DROPBOX_FILES_SYNC,
  DROPBOX_FOLDERS_SYNC,
  DROPBOX_SHARED_FOLDERS_SYNC,
  DROPBOX_SHARED_LINKS_SYNC,
] as const;
const NANGO_WEBHOOK_TYPES = ["forward", "auth", "connection.created", "sync"] as const;
const BASE_NANGO_FIELDS = new Set([
  "from",
  "type",
  "providerConfigKey",
  "provider_config_key",
  "connectionId",
  "connection_id",
  "payload",
]);
const REMOVAL_OPERATIONS = new Set([
  "delete",
  "deletion",
  "deleted",
  "disconnect",
  "disconnected",
  "disconnection",
  "remove",
  "removed",
  "revoked",
]);
const SYNC_WORKSPACE_RESOLUTION_ATTEMPTS = 3;
const SYNC_WORKSPACE_RESOLUTION_DELAY_MS = 50;
const CLOUD_WORKSPACE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Maps a Nango providerConfigKey (`from` / `provider_config_key` on the
// envelope) to the canonical workspace_integrations.provider id used by the
// rest of the cloud. Both the new `-relay` keys (current naming convention)
// and selected legacy `-sage` keys are kept so in-flight connections and replays
// from older sync runs keep routing correctly. The remaining `-sage` aliases will be
// retired in a future cleanup PR after the Nango integrations have been
// republished under the new keys and the existing workspace_integrations
// rows have been migrated.
const NANGO_PROVIDER_TO_WORKSPACE_PROVIDER: Record<
  string,
  WorkspaceIntegrationProvider
> = {
  // GitHub
  "github-relay": "github",
  "github-sage": "github", // legacy, kept for in-flight connections
  github: "github",
  "github-app": "github",
  "github-app-oauth": "github",
  // Slack (relayfile). The workspace_integrations row is keyed by `slack`
  // post-migration; `slack-sage` is the legacy provider id retained as an
  // alias so in-flight Nango tokens / external integrations still resolve.
  "slack-relay": "slack",
  "slack-sage": "slack",
  "slack-sage-preview": "slack", // legacy preview app, kept for in-flight connections
  // Slack (separate products — not relayfile integrations)
  "slack-ricky": "slack-ricky",
  "slack-my-senior-dev": "slack-my-senior-dev",
  "slack-nightcto": "slack-nightcto",
  // Notion
  "notion-relay": "notion",
  "notion-sage": "notion", // legacy, kept for in-flight connections
  notion: "notion",
  // HubSpot
  "hubspot-relay": "hubspot",
  hubspot: "hubspot",
  // Linear
  "linear-relay": "linear",
  "linear-sage": "linear", // legacy, kept for in-flight connections
  linear: "linear",
  "linear-ricky": "linear-ricky",
  // GitLab
  "gitlab-relay": "gitlab",
  gitlab: "gitlab",
  // Daytona
  "daytona-relay": "daytona",
  daytona: "daytona",
  // GCP
  "gcp-relay": GCP_PROVIDER,
  gcp: GCP_PROVIDER,
  // Cloudflare
  "cloudflare-relay": CLOUDFLARE_PROVIDER,
  cloudflare: CLOUDFLARE_PROVIDER,
  // Neon
  "neon-relay": "neon",
  "neon-composio-relay": "neon",
  neon: "neon",
  // Jira
  "jira-relay": "jira",
  "jira-sage": "jira", // legacy, kept for in-flight connections
  jira: "jira",
  // Confluence
  "confluence-relay": "confluence",
  confluence: "confluence",
  // Google Mail
  "google-mail-relay": "google-mail",
  "google-mail": "google-mail",
  // Google Calendar
  "google-calendar-relay": "google-calendar",
  "google-calendar": "google-calendar",
  // Granola
  "granola-relay": "granola",
  granola: "granola",
  // Recall
  "recall-relay": RECALL_PROVIDER,
  recall: RECALL_PROVIDER,
  // Fathom
  "fathom-relay": "fathom",
  "fathom-oauth": "fathom",
  fathom: "fathom",
  // Dropbox
  "dropbox-relay": DROPBOX_PROVIDER,
  dropbox: DROPBOX_PROVIDER,
  // Docker Hub
  "docker_hub-composio-relay": DOCKER_HUB_PROVIDER,
  "docker-hub-composio-relay": DOCKER_HUB_PROVIDER,
  "docker-hub": DOCKER_HUB_PROVIDER,
  "reddit-composio-relay": REDDIT_PROVIDER,
  reddit: REDDIT_PROVIDER,
};

const webhookConsumerRegistry = bootstrapRegistryFromEnv();

export type NangoWebhookType = (typeof NANGO_WEBHOOK_TYPES)[number];

export type NangoWebhookEnvelope = {
  from: string;
  type: string;
  providerConfigKey: string;
  connectionId: string | null;
  payload: unknown;
};

export class RelayfilePrimaryWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayfilePrimaryWriteError";
  }
}

function isKnownNangoWebhookType(value: string): value is NangoWebhookType {
  return (NANGO_WEBHOOK_TYPES as readonly string[]).includes(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  return readStringValue(record?.[key]);
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function readRecord(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = record?.[key];
  return isObject(value) ? value : null;
}

function readSyncType(record: Record<string, unknown>): NangoSyncType | undefined {
  const raw = readString(record, "syncType") ?? readString(record, "sync_type");
  const value = raw?.trim().toUpperCase();
  return value === "INCREMENTAL" || value === "INITIAL" || value === "WEBHOOK"
    ? value
    : undefined;
}

function readCheckpointValueObject(value: unknown): NangoCheckpoint | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isObject(value)) {
    return undefined;
  }
  const checkpoint: NangoCheckpoint = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      typeof raw !== "string" &&
      typeof raw !== "number" &&
      typeof raw !== "boolean"
    ) {
      return undefined;
    }
    checkpoint[key] = raw;
  }
  return checkpoint;
}

function readCheckpoints(record: Record<string, unknown>): NangoCheckpointRange | null | undefined {
  const raw = record.checkpoints ?? record.check_points;
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return null;
  }
  if (!isObject(raw)) {
    return undefined;
  }
  const from = readCheckpointValueObject(raw.from ?? null);
  const to = readCheckpointValueObject(raw.to ?? null);
  return from === undefined || to === undefined ? undefined : { from, to };
}

function readResponseResults(
  record: Record<string, unknown>,
): NangoSyncResponseResults | undefined {
  const raw = record.responseResults ?? record.response_results;
  if (!isObject(raw)) {
    return undefined;
  }
  const added = raw.added;
  const updated = raw.updated;
  const deleted = raw.deleted;
  return (
    typeof added === "number" &&
      Number.isInteger(added) &&
      added >= 0 &&
      typeof updated === "number" &&
      Number.isInteger(updated) &&
      updated >= 0 &&
      typeof deleted === "number" &&
      Number.isInteger(deleted) &&
      deleted >= 0
  )
    ? { added, updated, deleted }
    : undefined;
}

function readCheckpointTimestamp(value: unknown): string | null {
  const directValue = readStringValue(value)?.trim();
  if (directValue) {
    return directValue;
  }
  if (!isObject(value)) {
    return null;
  }
  return (
    readString(value, "updatedAtCursor") ??
    readString(value, "updated_at_cursor") ??
    readString(value, "lastModifiedISO") ??
    readString(value, "last_modified_iso") ??
    readString(value, "lastUpdated") ??
    readString(value, "last_updated") ??
    readString(value, "updatedAt") ??
    readString(value, "updated_at") ??
    readString(value, "modifiedAfter") ??
    readString(value, "modified_after") ??
    readString(value, "timestamp")
  )?.trim() || null;
}

function readPayloadModifiedAfter(payload: Record<string, unknown>): string | null {
  return (
    readString(payload, "modifiedAfter") ??
    readString(payload, "modified_after")
  )?.trim() || null;
}

function readNangoSyncModifiedAfter(payload: Record<string, unknown>): string | null {
  const checkpoints = readRecord(payload, "checkpoints");
  const syncType = readSyncType(payload);
  const isInitialSync = syncType === "INITIAL";

  if (isInitialSync) {
    return null;
  }

  if (checkpoints && Object.prototype.hasOwnProperty.call(checkpoints, "from")) {
    if (checkpoints.from === null || checkpoints.from === undefined) {
      return null;
    }
    return readCheckpointTimestamp(checkpoints.from) ?? readPayloadModifiedAfter(payload);
  }

  return readPayloadModifiedAfter(payload);
}

function readSlackUserId(value: unknown): string | null {
  const raw = readStringValue(value);
  const userId = raw?.trim() ?? "";
  return /^[UW][A-Z0-9]+$/u.test(userId) ? userId : null;
}

async function writeBatchToRelayfileOrThrow(
  client: Parameters<typeof writeBatchToRelayfile>[0],
  records: Parameters<typeof writeBatchToRelayfile>[1],
  job: Parameters<typeof writeBatchToRelayfile>[2],
  options?: Parameters<typeof writeBatchToRelayfile>[3] & { materializeContract?: boolean },
): Promise<Awaited<ReturnType<typeof writeBatchToRelayfile>>> {
  const result = options === undefined
    ? await writeBatchToRelayfile(client, records, job)
    : await writeBatchToRelayfile(client, records, job, options as Parameters<typeof writeBatchToRelayfile>[3]);
  if (result.errors > 0) {
    await logger.error("Relayfile provider write completed with errors", {
      area: "nango-webhook",
      provider: job.provider,
      syncName: job.syncName,
      model: job.model,
      workspaceId: job.workspaceId,
      written: result.written,
      deleted: result.deleted,
      errors: result.errors,
    });
    throw new RelayfilePrimaryWriteError(
      `Relayfile provider write failed for ${job.provider}/${job.model}: ${result.errors} error(s)`,
    );
  }
  return result;
}

async function enqueueIntegrationWatchEvent(input: {
  workspaceId: string;
  provider: WorkspaceIntegrationProvider;
  eventType: string;
  connectionId?: string | null;
  deliveryId?: string | null;
  paths?: readonly string[];
  payload?: unknown;
}): Promise<void> {
  try {
    const { dispatchIntegrationWatchEvent } = await import(
      "@/lib/proactive-runtime/integration-watch-dispatcher"
    );
    await dispatchIntegrationWatchEvent(input);
  } catch (error) {
    await logger.error("Integration watch enqueue failed", {
      area: "nango-webhook",
      workspaceId: input.workspaceId,
      provider: input.provider,
      eventType: input.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function buildInlineWatchDeliveryId(input: {
  workspaceId: string;
  provider: WorkspaceIntegrationProvider;
  eventType: string;
  connectionId?: string | null;
  paths?: readonly string[];
  payload?: unknown;
}): string {
  const paths = input.paths?.length ? [...input.paths].sort().join(",") : stableJson(input.payload);
  return [
    "integration-watch",
    input.workspaceId,
    input.provider,
    input.eventType,
    input.connectionId?.trim() || "no-connection",
    paths,
  ].join(":");
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function getHeader(
  headers: Headers | Record<string, unknown>,
  key: string,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(key);
  }

  const normalizedKey = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(headers)) {
    if (entryKey.toLowerCase() !== normalizedKey) {
      continue;
    }

    return typeof value === "string" ? value : null;
  }

  return null;
}

function normalizeProvider(value: string | null | undefined): WorkspaceIntegrationProvider | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return WORKSPACE_INTEGRATION_PROVIDERS.includes(
    normalized as WorkspaceIntegrationProvider,
  )
    ? (normalized as WorkspaceIntegrationProvider)
    : null;
}

function normalizeConnectionId(record: Record<string, unknown>): string | null {
  return readString(record, "connectionId") ?? readString(record, "connection_id");
}

function normalizeProviderConfigKey(record: Record<string, unknown>): string | null {
  return readString(record, "providerConfigKey") ?? readString(record, "provider_config_key");
}

function omitBaseNangoFields(record: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (!BASE_NANGO_FIELDS.has(key)) {
      payload[key] = value;
    }
  }

  return payload;
}

function normalizePayload(record: Record<string, unknown>, type: string): unknown {
  const nestedPayload = record.payload;

  if (type === "forward") {
    return nestedPayload ?? {};
  }

  const topLevelPayload = omitBaseNangoFields(record);
  if (!isObject(nestedPayload)) {
    return topLevelPayload;
  }

  return {
    ...topLevelPayload,
    ...nestedPayload,
  };
}

function isHexDigest(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[a-f0-9]+$/i.test(value);
}

function getHmacSignature(headers: Headers | Record<string, unknown>): string | null {
  return getHeader(headers, NANGO_HMAC_HEADER);
}

function getLegacySignature(headers: Headers | Record<string, unknown>): string | null {
  return getHeader(headers, LEGACY_NANGO_SIGNATURE_HEADER);
}

function getSageWebhookBaseUrl(): string {
  const configured = optionalEnv("SAGE_WEBHOOK_URL");
  if (configured) {
    return trimTrailingSlash(configured);
  }

  return trimTrailingSlash(
    process.env.NODE_ENV === "development"
      ? DEFAULT_SAGE_WEBHOOK_URL_DEV
      : DEFAULT_SAGE_WEBHOOK_URL,
  );
}

function normalizeHeaderRecord(value: Record<string, unknown> | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!value) {
    return headers;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      headers[key] = entry;
      continue;
    }

    if (
      Array.isArray(entry) &&
      entry.every((candidate) => typeof candidate === "string")
    ) {
      headers[key] = entry.join(", ");
      continue;
    }

    if (typeof entry === "number" || typeof entry === "boolean") {
      headers[key] = String(entry);
    }
  }

  return headers;
}

function simplifyGitHubHeaders(
  headers: Headers | Record<string, string>,
): Record<string, string> {
  const simplified: Record<string, string> = {};
  const entries =
    headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers);

  for (const [key, value] of entries) {
    if (key.toLowerCase().startsWith("x-github-")) {
      simplified[key.toLowerCase()] = value;
    }
  }

  return simplified;
}

function readGitHubEventHint(value: unknown): string | null {
  if (!isObject(value)) {
    return null;
  }

  return (
    readString(value, GITHUB_EVENT_HEADER) ??
    readString(value, "event") ??
    readString(value, "eventType") ??
    readString(value, "githubEvent")
  );
}

export function inferGitHubEvent(payload: Record<string, unknown>): string {
  if (isObject(payload.deployment_status)) {
    return "deployment_status";
  }

  if (isObject(payload.check_run)) {
    return "check_run";
  }

  if (isObject(payload.pull_request)) {
    if (isObject(payload.comment)) {
      return "pull_request_review_comment";
    }

    if (isObject(payload.review)) {
      return "pull_request_review";
    }

    return "pull_request";
  }

  if (isObject(payload.issue)) {
    return isObject(payload.comment) ? "issue_comment" : "issues";
  }

  if (isObject(payload.release)) {
    return "release";
  }

  if (isObject(payload.installation)) {
    return Array.isArray(payload.repositories_added) || Array.isArray(payload.repositories_removed)
      ? "installation_repositories"
      : "installation";
  }

  if (typeof payload.after === "string" || isObject(payload.head_commit)) {
    return "push";
  }

  if (typeof payload.zen === "string") {
    return "ping";
  }

  return "unknown";
}

function unwrapProviderForwardPayload(input: unknown): {
  payload: Record<string, unknown> | null;
  headers: Record<string, string>;
  deliveryId: string | null;
} {
  if (!isObject(input)) {
    return {
      payload: null,
      headers: {},
      deliveryId: null,
    };
  }

  const requestRecord = readRecord(input, "request");
  const directHeaders = readRecord(input, "headers");
  const requestHeaders = readRecord(requestRecord, "headers");
  const headers = normalizeHeaderRecord(directHeaders ?? requestHeaders);

  const unwrappedPayload =
    readRecord(input, "body") ??
    readRecord(requestRecord, "body") ??
    (directHeaders || requestHeaders ? readRecord(input, "payload") : null) ??
    (directHeaders || requestHeaders ? readRecord(input, "data") : null) ??
    (directHeaders || requestHeaders ? readRecord(requestRecord, "payload") : null) ??
    input;

  const deliveryId =
    getHeader(headers, GITHUB_DELIVERY_HEADER) ??
    getHeader(headers, GITLAB_DELIVERY_HEADER) ??
    readString(input, "deliveryId") ??
    readString(input, "delivery_id") ??
    readString(requestRecord, "deliveryId") ??
    readString(requestRecord, "delivery_id");

  return {
    payload: unwrappedPayload,
    headers,
    deliveryId,
  };
}

function unwrapGitHubForwardPayload(input: unknown): {
  payload: Record<string, unknown> | null;
  headers: Record<string, string>;
  deliveryId: string | null;
} {
  const forwarded = unwrapProviderForwardPayload(input);

  if (!getHeader(forwarded.headers, GITHUB_EVENT_HEADER)) {
    const requestRecord = isObject(input) ? readRecord(input, "request") : null;
    const hintedEvent =
      readGitHubEventHint(input) ??
      readGitHubEventHint(requestRecord) ??
      readGitHubEventHint(forwarded.payload) ??
      (forwarded.payload ? inferGitHubEvent(forwarded.payload) : "unknown");

    forwarded.headers[GITHUB_EVENT_HEADER] = hintedEvent;
  }

  if (forwarded.deliveryId && !getHeader(forwarded.headers, GITHUB_DELIVERY_HEADER)) {
    forwarded.headers[GITHUB_DELIVERY_HEADER] = forwarded.deliveryId;
  }

  return forwarded;
}

function readGitHubInstallationId(payload: Record<string, unknown> | null): string | null {
  const installation = readRecord(payload, "installation");
  return (
    readString(installation, "id") ??
    readString(payload, "installation_id") ??
    readString(payload, "installationId") ??
    readString(payload, "github_installation_id")
  );
}

async function indexGithubInstallationBestEffort(input: {
  workspaceId: string;
  installationId: string | null;
  payload: Record<string, unknown> | null;
  connectionId?: string | null;
  providerConfigKey?: string | null;
  linkedByUserId?: string | null;
}): Promise<void> {
  if (!input.installationId) return;
  try {
    await upsertGithubInstallationIndex({
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      payload: input.payload ?? {},
      connectionId: input.connectionId ?? null,
      providerConfigKey: input.providerConfigKey ?? null,
      linkedByUserId: input.linkedByUserId ?? null,
      metadata: input.payload ?? {},
    });
  } catch (error) {
    await logger.warn("GitHub installation index update failed; continuing webhook processing", {
      area: "nango-webhook",
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      connectionId: input.connectionId ?? undefined,
      providerConfigKey: input.providerConfigKey ?? undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readForwardAction(payload: Record<string, unknown>): string | null {
  return readString(payload, "action") ?? readString(readRecord(payload, "_webhook"), "action");
}

function isForwardDeletionEvent(eventType: string, payload: Record<string, unknown>): boolean {
  const eventAction = eventType.split(".").pop() ?? "";
  const payloadAction = readForwardAction(payload) ?? "";

  return [eventAction, payloadAction].some((candidate) =>
    candidate ? isRemovalOperation(candidate) : false,
  );
}

function buildLinearForwardFileData(
  normalized: LinearNormalizedWebhook,
): Record<string, unknown> {
  const data = readRecord(normalized.payload, "data");
  if (!data) {
    return normalized.payload;
  }

  const connection = readRecord(normalized.payload, "_connection");
  const webhook = readRecord(normalized.payload, "_webhook");

  return {
    ...data,
    ...(connection ? { _connection: connection } : {}),
    ...(webhook ? { _webhook: webhook } : {}),
  };
}


function recordWithWebhookMetadata(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  eventType: string,
  deleted: boolean,
): Record<string, unknown> {
  return {
    ...record,
    _webhook: {
      eventType,
      action: readForwardAction(payload) ?? fallbackWebhookAction(eventType),
      receivedAt: new Date().toISOString(),
    },
    ...(deleted
      ? {
          _nango_metadata: {
            last_action: "deleted",
            deleted_at: new Date().toISOString(),
          },
        }
      : {}),
  };
}

function fallbackWebhookAction(eventType: string): string {
  const parts = eventType
    .replace(/_/g, ".")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  const membershipAction = parts.find((part) => part === "joined" || part === "left");

  if (membershipAction) {
    const resource = parts.at(-1);
    return resource && resource !== membershipAction ? `${membershipAction}_${resource}` : membershipAction;
  }

  return parts.at(-1) ?? eventType;
}

function githubIntegrationWatchPaths(input: {
  eventType: string;
  path: string;
  payload: Record<string, unknown>;
}): string[] {
  const paths = [input.path];
  if (
    input.eventType.startsWith("pull_request_review.") ||
    input.eventType.startsWith("pull_request_review_comment.")
  ) {
    paths.push(...eventScopedSyncPaths({
      type: `github.${input.eventType}`,
      provider: "github",
      eventType: input.eventType,
      resource: input.payload,
    }));
  }
  return [...new Set(paths)];
}

function makeForwardSyncJob(input: {
  workspaceId: string;
  connectionId: string;
  providerConfigKey: string;
  provider: WorkspaceIntegrationProvider;
  syncName: string;
  model: string;
}) {
  return createWebhookSyncJob({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    provider: input.provider,
    syncName: input.syncName,
    model: input.model,
  });
}

function getLinearWebhookRecordWriterTarget(
  normalized: LinearNormalizedWebhook,
): { syncName: string; model: string } | null {
  switch (normalized.objectType.trim().toLowerCase()) {
    case "issue":
      return { syncName: LINEAR_ISSUES_SYNC_NAME, model: "LinearIssue" };
    case "comment":
      return { syncName: LINEAR_COMMENTS_SYNC_NAME, model: "LinearComment" };
    case "label":
      return { syncName: "fetch-labels", model: "LinearLabel" };
    case "project":
      return { syncName: "fetch-projects", model: "LinearProject" };
    default:
      return null;
  }
}

function readSlackEvent(payload: Record<string, unknown>): Record<string, unknown> | null {
  return readRecord(payload, "event") ?? payload;
}

type RawRows<T> = { rows?: T[] };

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as RawRows<T>;
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function parseSlackChannelInput(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return Array.from(new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  ));
}

function readAgentInputValue(inputValues: unknown, key: string): string | null {
  if (!isObject(inputValues)) {
    return null;
  }
  return readString(inputValues, key);
}

function questionChannelsFromAgentInputs(inputValues: unknown): string[] {
  const questionChannels = parseSlackChannelInput(readAgentInputValue(inputValues, QUESTION_CHANNEL_INPUT));
  if (questionChannels.length > 0) {
    return questionChannels;
  }
  return parseSlackChannelInput(readAgentInputValue(inputValues, SLACK_CHANNEL_INPUT));
}

async function activeMeetingActionsQuestionChannels(workspaceId: string): Promise<Set<string>> {
  const channels = new Set<string>();
  let result: unknown;
  try {
    result = await getDb().execute(sql`
      SELECT a.input_values
      FROM agents a
      INNER JOIN personas p ON p.id = a.persona_id
      WHERE a.workspace_id = ${workspaceId}
        AND a.status = 'active'
        AND p.slug = ${MEETING_ACTIONS_PERSONA_SLUG}
    `);
  } catch (error) {
    await logger.warn("Slack thread reply question channel lookup failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return channels;
  }
  for (const row of rowsOf<{ input_values?: unknown }>(result)) {
    for (const channel of questionChannelsFromAgentInputs(row.input_values)) {
      channels.add(channel);
    }
  }
  return channels;
}

async function isHumanSlackThreadReply(input: {
  workspaceId: string;
  record: Record<string, unknown>;
}): Promise<boolean> {
  const record = input.record;
  const channel = readString(record, "channel");
  const ts = readString(record, "ts");
  const threadTs = readString(record, "thread_ts");
  const text = readString(record, "text");
  if (!channel || !ts || !threadTs || threadTs === ts || !text?.trim()) {
    return false;
  }
  if (readString(record, "bot_id") || readBoolean(record, "is_bot") === true) {
    return false;
  }
  let agentWorkspaceId = input.workspaceId;
  try {
    agentWorkspaceId = await resolveAppWorkspaceIdForRuntime(input.workspaceId);
  } catch (error) {
    await logger.warn("Slack thread reply workspace identity lookup failed", {
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  const questionChannels = await activeMeetingActionsQuestionChannels(agentWorkspaceId);
  return questionChannels.has(channel);
}

function safeTsSegment(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-|-$/g, "");
}

function extractRecordingIdFromQuestionText(text: string): string | null {
  return text.match(/\(recording\s+([^)]+)\)/iu)?.[1]?.trim() ?? null;
}

function isMeetingActionsQuestionText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("reply here; meeting-actions files the issue once answered") &&
    lower.includes("need a human call")
  );
}

async function readSlackThreadParent(input: {
  connectionId: string;
  providerConfigKey: string;
  channel: string;
  threadTs: string;
}): Promise<Record<string, unknown> | null> {
  try {
    const response = await getNangoProxyClient().proxy({
      method: "GET",
      endpoint: "/conversations.replies",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      params: {
        channel: input.channel,
        ts: input.threadTs,
        limit: "1",
      },
    });
    const data = isObject(response.data) ? response.data : null;
    if (data?.ok === false) {
      await logger.warn("Slack thread parent lookup rejected", {
        area: "nango-webhook",
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        channel: input.channel,
        threadTs: input.threadTs,
        error: readString(data, "error") ?? "unknown",
      });
      return null;
    }

    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const parent = messages.find((message): message is Record<string, unknown> => (
      isObject(message) && readString(message, "ts") === input.threadTs
    ));
    return parent ?? null;
  } catch (error) {
    await logger.warn("Slack thread parent lookup failed", {
      area: "nango-webhook",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      channel: input.channel,
      threadTs: input.threadTs,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function writeSlackThreadReplyNote(input: {
  client: {
    writeFile?: (args: {
      workspaceId: string;
      path: string;
      baseRevision: string;
      content: string;
      contentType: string;
      encoding: string;
    }) => Promise<unknown>;
  };
  workspaceId: string;
  connectionId: string;
  providerConfigKey: string;
  record: Record<string, unknown>;
}): Promise<{ path: string; recordingId: string; note: Record<string, unknown> } | null> {
  const channel = readString(input.record, "channel");
  const threadTs = readString(input.record, "thread_ts");
  const answerTs = readString(input.record, "ts");
  if (!channel || !threadTs || !answerTs || !input.client.writeFile) {
    return null;
  }

  const parent = await readSlackThreadParent({
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    channel,
    threadTs,
  });
  const questionText = readString(parent, "text") ?? "";
  if (!isMeetingActionsQuestionText(questionText)) {
    return null;
  }

  const recordingId = extractRecordingIdFromQuestionText(questionText);
  if (!recordingId) {
    await logger.warn("Slack thread reply question lacked recording id", {
      area: "nango-webhook",
      workspaceId: input.workspaceId,
      channel,
      threadTs,
    });
    return null;
  }

  const path =
    `/recall/recordings/thread-reply-${safeTsSegment(recordingId)}-${safeTsSegment(answerTs)}.json`;
  const note = {
    type: "thread_reply",
    recording_id: recordingId,
    question_message_ts: threadTs,
    channel,
    thread_ts: threadTs,
    question_text: questionText,
    answer_text: readString(input.record, "text") ?? "",
    answer_user: readString(input.record, "user") ?? undefined,
    answer_ts: answerTs,
    created_at: new Date().toISOString(),
  };

  await input.client.writeFile({
    workspaceId: input.workspaceId,
    path,
    baseRevision: "*",
    content: `${JSON.stringify(note, null, 2)}\n`,
    contentType: "application/json",
    encoding: "utf-8",
  });

  await logger.info("Slack thread reply note written", {
    area: "nango-webhook",
    workspaceId: input.workspaceId,
    channel,
    threadTs,
    answerTs,
    recordingId,
    path,
  });
  return { path, recordingId, note };
}

async function addSlackThreadReplyReaction(input: {
  connectionId: string;
  providerConfigKey: string;
  record: Record<string, unknown>;
  name: "eyes" | "white_check_mark" | "x";
}): Promise<boolean> {
  const channel = readString(input.record, "channel");
  const timestamp = readString(input.record, "ts");
  if (!channel || !timestamp) {
    return false;
  }

  try {
    const response = await getNangoProxyClient().proxy({
      method: "POST",
      endpoint: "/reactions.add",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      data: {
        channel,
        timestamp,
        name: input.name,
      },
    });
    const data = isObject(response.data) ? response.data : null;
    if (data?.ok === false) {
      await logger.warn("Slack thread reply reaction rejected", {
        area: "nango-webhook",
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        channel,
        ts: timestamp,
        reaction: input.name,
        error: readString(data, "error") ?? "unknown",
      });
      return false;
    }

    await logger.info("Slack thread reply reaction added", {
      area: "nango-webhook",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      channel,
      ts: timestamp,
      threadTs: readString(input.record, "thread_ts") ?? undefined,
      reaction: input.name,
    });
    return true;
  } catch (error) {
    await logger.warn("Slack thread reply reaction failed", {
      area: "nango-webhook",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      channel,
      ts: timestamp,
      reaction: input.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function normalizeSlackForwardRecord(payload: Record<string, unknown>): {
  model: string;
  record: Record<string, unknown>;
} | null {
  const event = readSlackEvent(payload);
  if (!event) {
    return null;
  }

  const eventType = readString(event, "type") ?? readString(payload, "type") ?? "";
  if (eventType === "message" || eventType === "app_mention") {
    const subtype = readString(event, "subtype");
    const changedMessage = subtype === "message_changed"
      ? readRecord(event, "message")
      : null;
    const previousMessage = readRecord(event, "previous_message");
    const source = changedMessage ?? previousMessage ?? event;
    const channel = readString(event, "channel") ?? readString(source, "channel");
    const channelType = readString(source, "channel_type") ?? readString(event, "channel_type");
    const ts =
      readString(source, "ts") ??
      readString(event, "deleted_ts") ??
      readString(event, "event_ts");
    if (!channel || !ts) {
      return null;
    }

    const deleted = subtype === "message_deleted";
    return {
      model: SLACK_MESSAGE_MODEL,
      record: recordWithWebhookMetadata(
        {
          id: `${channel}:${ts}`,
          channel,
          ...(channelType ? { channel_type: channelType } : {}),
          ts,
          text: readString(source, "text") ?? "",
          user: readString(source, "user") ?? readString(event, "user") ?? "",
          bot_id: readString(source, "bot_id") ?? readString(event, "bot_id") ?? "",
          is_bot: readBoolean(source, "is_bot") ?? readBoolean(event, "is_bot") ?? false,
          thread_ts: readString(source, "thread_ts") ?? readString(event, "thread_ts") ?? null,
          reply_count: Number(source.reply_count ?? event.reply_count ?? 0),
          reply_users_count: Number(source.reply_users_count ?? event.reply_users_count ?? 0),
          subtype: subtype ?? undefined,
          edited_ts: readString(readRecord(source, "edited"), "ts") ?? null,
          raw_event: event,
        },
        payload,
        eventType === "app_mention"
          ? "app_mention"
          : deleted
            ? "message.deleted"
            : subtype === "message_changed"
              ? "message.updated"
              : "message.created",
        deleted,
      ),
    };
  }

  if (
    eventType.startsWith("channel_") ||
    eventType.startsWith("group_") ||
    eventType === "member_joined_channel" ||
    eventType === "member_left_channel"
  ) {
    const channelRecord = readRecord(event, "channel");
    const channelId = readString(channelRecord, "id") ?? readString(event, "channel");
    if (!channelId) {
      return null;
    }
    const deleted = eventType === "channel_deleted" || eventType === "group_deleted";
    const archived = deleted || eventType === "channel_archive" || eventType === "group_archive";
    const channelName = readString(channelRecord, "name") ?? readString(event, "name");
    return {
      model: SLACK_CHANNEL_MODEL,
      record: recordWithWebhookMetadata(
        {
          id: channelId,
          ...(channelName ? { name: channelName } : {}),
          is_private: channelRecord?.is_private === true || eventType.startsWith("group_"),
          is_archived: channelRecord?.is_archived === true || archived,
          is_shared: channelRecord?.is_shared === true,
          is_member: channelRecord?.is_member !== false,
          topic: readString(readRecord(channelRecord, "topic"), "value") ?? "",
          purpose: readString(readRecord(channelRecord, "purpose"), "value") ?? "",
          creator: readString(channelRecord, "creator") ?? readString(event, "user") ?? "",
          created: Number(channelRecord?.created ?? 0),
          member_count: Number(channelRecord?.num_members ?? 0),
          raw_event: event,
        },
        payload,
        eventType.replace(/_/g, "."),
        deleted,
      ),
    };
  }

  if (eventType === "team_join" || eventType === "user_change") {
    const user = readRecord(event, "user");
    const userId = readString(user, "id");
    if (!userId) {
      return null;
    }
    const profile = readRecord(user, "profile");
    return {
      model: SLACK_USER_MODEL,
      record: recordWithWebhookMetadata(
        {
          id: userId,
          team_id: readString(user, "team_id") ?? "",
          name: readString(user, "name") ?? "",
          real_name: readString(user, "real_name") ?? readString(profile, "real_name") ?? "",
          display_name: readString(profile, "display_name") ?? "",
          email: readString(profile, "email") ?? "",
          title: readString(profile, "title") ?? "",
          is_bot: user?.is_bot === true,
          is_admin: user?.is_admin === true,
          is_deleted: user?.deleted === true,
          timezone: readString(user, "tz") ?? "",
          updated: Number(user?.updated ?? 0),
          raw_event: event,
        },
        payload,
        eventType.replace(/_/g, "."),
        user?.deleted === true,
      ),

    };
  }

  return null;
}

function slackMessageRecordPaths(record: Record<string, unknown>): string[] {
  const directMessageUserId = readString(record, "dm_user_id");
  if (directMessageUserId) {
    return slackDirectMessageRecordPaths(record, directMessageUserId);
  }

  const channel = readString(record, "channel");
  const ts = readString(record, "ts");
  if (!channel || !ts) {
    return [];
  }

  const channelName =
    readString(record, "channelName") ?? readString(record, "channel_name") ?? undefined;
  const threadTs = readString(record, "thread_ts");
  const replyCount = Number(record.reply_count ?? 0);
  if (threadTs && threadTs !== ts) {
    return [
      slackThreadReplyPath(channel, threadTs, ts, channelName),
      slackThreadReplyWritebackPath(channel, threadTs, channelName),
    ];
  }
  if (threadTs === ts || replyCount > 0) {
    const rootTs = threadTs || ts;
    return [
      slackThreadPath(channel, rootTs, channelName),
      slackThreadReplyWritebackPath(channel, rootTs, channelName),
    ];
  }
  return [slackMessagePath(channel, ts, readString(record, "text") ?? undefined, channelName)];
}

function slackDirectMessageRecordPaths(
  record: Record<string, unknown>,
  userId: string,
): string[] {
  const ts = readString(record, "ts");
  if (!ts) {
    return [];
  }

  const threadTs = readString(record, "thread_ts");
  const replyCount = Number(record.reply_count ?? 0);
  if (threadTs && threadTs !== ts) {
    return [
      slackDirectMessageThreadReplyPath(userId, threadTs, ts),
      slackDirectMessageReplyWritebackPath(userId, threadTs),
    ];
  }
  if (threadTs === ts || replyCount > 0) {
    const rootTs = threadTs || ts;
    return [
      slackDirectMessagePath(userId, rootTs),
      slackDirectMessageReplyWritebackPath(userId, rootTs),
    ];
  }
  return [slackDirectMessagePath(userId, ts)];
}

function slackThreadReplyWritebackPath(
  channel: string,
  threadTs: string,
  channelName?: string,
): string {
  return slackMessagePath(channel, threadTs, undefined, channelName)
    .replace(/\/meta\.json$/u, "/replies/**");
}

function slackDirectMessageReplyWritebackPath(userId: string, threadTs: string): string {
  return slackDirectMessagePath(userId, threadTs).replace(/\/meta\.json$/u, "/replies/**");
}

const slackDirectMessageUserCache = new Map<string, string>();
const slackChannelNameCache = new Map<string, string>();

async function resolveSlackDirectMessageUserId(input: {
  connectionId: string;
  providerConfigKey: string;
  channelId: string;
}): Promise<string | null> {
  if (!input.channelId.startsWith("D")) {
    return null;
  }

  const cacheKey = `${input.connectionId}:${input.channelId}`;
  const cached = slackDirectMessageUserCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await getNangoProxyClient().proxy({
      method: "GET",
      endpoint: "/conversations.info",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      params: { channel: input.channelId },
    }) as { status?: number; data?: unknown };
    const status = response.status ?? 200;
    const data = isObject(response.data) ? response.data : null;
    const channel = readRecord(data, "channel");
    const userId = status >= 200 && status < 300 && data?.ok !== false && channel?.is_im === true
      ? readSlackUserId(channel.user)
      : null;
    if (userId) {
      slackDirectMessageUserCache.set(cacheKey, userId);
    }
    return userId;
  } catch (error) {
    await logger.warn("Slack DM user resolution failed; preserving raw D-channel path", {
      area: "nango-webhook",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      channelId: input.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveSlackChannelName(input: {
  connectionId: string;
  providerConfigKey: string;
  channelId: string;
}): Promise<string | null> {
  if (input.channelId.startsWith("D")) {
    return null;
  }

  const cacheKey = `${input.connectionId}:${input.channelId}`;
  const cached = slackChannelNameCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await getNangoProxyClient().proxy({
      method: "GET",
      endpoint: "/conversations.info",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      params: { channel: input.channelId },
    }) as { status?: number; data?: unknown };
    const status = response.status ?? 200;
    const data = isObject(response.data) ? response.data : null;
    const channel = readRecord(data, "channel");
    const channelName = status >= 200 && status < 300 && data?.ok !== false
      ? readString(channel, "name") ?? readString(channel, "name_normalized") ?? null
      : null;
    if (channelName) {
      slackChannelNameCache.set(cacheKey, channelName);
    }
    return channelName;
  } catch (error) {
    await logger.warn("Slack channel name resolution failed; preserving no-bare write guard", {
      area: "nango-webhook",
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      channelId: input.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function withSlackDirectMessageUser(
  record: Record<string, unknown>,
  input: {
    connectionId: string;
    providerConfigKey: string;
  },
): Promise<Record<string, unknown>> {
  if (readString(record, "channel_type") !== "im") {
    return record;
  }
  const channelId = readString(record, "channel");
  if (!channelId?.startsWith("D")) {
    return record;
  }

  const userId = await resolveSlackDirectMessageUserId({
    ...input,
    channelId,
  });
  if (!userId) {
    return record;
  }

  return {
    ...record,
    dm_user_id: userId,
    source_channel_id: channelId,
  };
}

function isBotAuthoredSlackMessage(
  record: Record<string, unknown>,
  integrationMetadata: unknown,
): boolean {
  const botId = readString(record, "bot_id");
  if (botId) {
    return true;
  }
  if (readBoolean(record, "is_bot") === true) {
    return true;
  }

  const userId = readString(record, "user");
  const metadata = isObject(integrationMetadata) ? integrationMetadata : null;
  const botUserId = readString(metadata, "slackBotUserId");
  return Boolean(userId && botUserId && userId === botUserId);
}

export function readWorkspaceIdFromAuthPayload(payload: Record<string, unknown>): string | null {
  const endUser = readRecord(payload, "endUser") ?? readRecord(payload, "end_user");
  const endUserTags = readRecord(endUser, "tags");
  const payloadTags = readRecord(payload, "tags");
  const candidates = [
    readString(endUser, "id"),
    readString(endUser, "endUserId"),
    readString(endUser, "end_user_id"),
    readString(payload, "endUserId"),
    readString(payload, "end_user_id"),
    readString(payload, "workspaceId"),
    readString(payload, "workspace_id"),
    readString(endUserTags, "end_user_id"),
    readString(endUserTags, "endUserId"),
    readString(endUserTags, "workspaceId"),
    readString(endUserTags, "workspace_id"),
    readString(payloadTags, "end_user_id"),
    readString(payloadTags, "endUserId"),
    readString(payloadTags, "workspaceId"),
    readString(payloadTags, "workspace_id"),
  ];

  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (!normalized) {
      continue;
    }

    if (isValidWorkspaceIdAny(normalized) || CLOUD_WORKSPACE_UUID_PATTERN.test(normalized)) {
      return normalized;
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  const schedule = (globalThis as unknown as Record<
    string,
    (callback: () => void, delayMs: number) => unknown
  >)["set" + "Timeout"];

  return new Promise((resolve) => {
    schedule(resolve, ms);
  });
}

async function resolveWorkspaceIdForSync(
  provider: WorkspaceIntegrationProvider,
  connectionId: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= SYNC_WORKSPACE_RESOLUTION_ATTEMPTS; attempt += 1) {
    let integration: Awaited<
      ReturnType<typeof findWorkspaceIntegrationByConnection>
    >;
    try {
      integration = await findWorkspaceIntegrationByProviderAliasAndConnection(
        provider,
        connectionId,
      );
    } catch (error) {
      logNangoDbWorkspaceDiagnostic({
        callsite: "resolveWorkspaceIdForSync",
        phase: "handler",
        error,
        provider,
        connectionId,
      });
      throw error;
    }
    if (integration) {
      return integration.workspaceId;
    }

    if (attempt < SYNC_WORKSPACE_RESOLUTION_ATTEMPTS) {
      await sleep(SYNC_WORKSPACE_RESOLUTION_DELAY_MS);
    }
  }

  return null;
}

function verifyHexSignature(expected: string, received: string): boolean {
  if (
    !isHexDigest(expected) ||
    !isHexDigest(received) ||
    expected.length !== received.length
  ) {
    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

function verifyLegacyNangoSignature(
  rawBody: string,
  signature: string,
  secretKey: string,
): boolean {
  const rawExpected = createHash("sha256")
    .update(`${secretKey}${rawBody}`)
    .digest("hex");
  if (verifyHexSignature(rawExpected, signature)) {
    return true;
  }

  try {
    const normalizedExpected = createHash("sha256")
      .update(`${secretKey}${JSON.stringify(JSON.parse(rawBody))}`)
      .digest("hex");
    return verifyHexSignature(normalizedExpected, signature);
  } catch {
    return false;
  }
}

export function verifyNangoWebhookSignature(
  rawBody: string,
  headers: Headers | Record<string, unknown>,
  secretKey: string,
): boolean {
  const hmacSignature = getHmacSignature(headers);
  if (hmacSignature) {
    const expected = createHmac("sha256", secretKey).update(rawBody).digest("hex");
    return verifyHexSignature(expected, hmacSignature);
  }

  const legacySignature = getLegacySignature(headers);
  if (legacySignature) {
    return verifyLegacyNangoSignature(rawBody, legacySignature, secretKey);
  }

  return false;
}

export function parseNangoEnvelope(rawBody: string): NangoWebhookEnvelope {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!isObject(parsed)) {
    throw new Error("Nango webhook payload must be an object");
  }

  const type = readString(parsed, "type")?.toLowerCase();
  if (!type) {
    throw new Error("Missing Nango webhook type");
  }

  const from =
    readString(parsed, "from") ??
    readString(parsed, "provider") ??
    readString(readRecord(parsed, "payload"), "from");
  if (!from?.trim()) {
    throw new Error("Missing Nango provider identifier");
  }

  const normalizedProvider = normalizeProvider(from);
  const providerConfigKey =
    normalizeProviderConfigKey(parsed) ??
    (normalizedProvider ? getProviderConfigKey(normalizedProvider) : "");

  return {
    from: from.trim().toLowerCase(),
    type,
    providerConfigKey,
    connectionId: normalizeConnectionId(parsed),
    payload: normalizePayload(parsed, type),
  };
}

export const parseNangoWebhookEnvelope = parseNangoEnvelope;

export async function routeNangoWebhook(envelope: NangoWebhookEnvelope): Promise<void> {
  if (!isKnownNangoWebhookType(envelope.type)) {
    await logger.warn("Nango webhook received with unsupported type", {
      area: "nango-webhook",
      type: envelope.type,
      provider: envelope.from,
      connectionId: envelope.connectionId ?? undefined,
    });
    return;
  }

  switch (envelope.type) {
    case "forward":
      await routeForwardEvent(envelope);
      return;
    case "auth":
    case "connection.created":
      await handleAuthEvent(envelope);
      return;
    case "sync":
      await handleSyncEvent(envelope);
      return;
  }
}

export function isRickySlackForwardEnvelope(
  envelope: Pick<NangoWebhookEnvelope, "from" | "providerConfigKey" | "type">,
): boolean {
  if (envelope.type !== "forward") return false;
  const provider =
    normalizeProvider(envelope.providerConfigKey) ??
    normalizeNangoProviderToWorkspaceProvider(envelope.providerConfigKey) ??
    normalizeProvider(envelope.from) ??
    normalizeNangoProviderToWorkspaceProvider(envelope.from);

  return provider === "slack-ricky" || envelope.providerConfigKey === "slack-ricky";
}

function isSlackProvider(
  value: WorkspaceIntegrationProvider | null,
): boolean {
  return value !== null && value.startsWith("slack");
}

function looksLikeSlackFrom(value: string): boolean {
  return value.trim().toLowerCase().startsWith("slack");
}

function normalizeProviderConfigKeyValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isSlackRelayfileForward(envelope: NangoWebhookEnvelope): boolean {
  const providerConfigKey = normalizeProviderConfigKeyValue(envelope.providerConfigKey);
  const from = normalizeProviderConfigKeyValue(envelope.from);

  return (
    providerConfigKey === "slack-relay" ||
    providerConfigKey === "slack" ||
    (!providerConfigKey && from === "slack-relay")
  );
}

async function hasSlackRelayfileWorkspaceIntegration(envelope: NangoWebhookEnvelope): Promise<boolean> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    return false;
  }

  const payloadIdentity = extractSlackConnectionIdentityFromForwardPayload(envelope.payload);
  const slackStableId = payloadIdentity.teamId ?? payloadIdentity.enterpriseId;
  const integration =
    await findWorkspaceIntegrationByConnection("slack", connectionId) ??
    await findSlackIntegrationByConnectionId(connectionId) ??
    (slackStableId ? await findSlackIntegrationByTeamId(slackStableId) : null);

  return Boolean(integration);
}

async function resolveSlackConnectionMetadata(
  connectionId: string,
  providerConfigKey: string,
  payload: unknown,
) {
  const payloadIdentity = extractSlackConnectionIdentityFromForwardPayload(payload);

  try {
    const authIdentity = await getSlackConnectionIdentity(connectionId, providerConfigKey);
    return mergeSlackConnectionIdentity(authIdentity, payloadIdentity);
  } catch (error) {
    if (hasSlackConnectionIdentity(payloadIdentity)) {
      await logger.warn("Slack identity fallback used from forward payload", {
        area: "nango-webhook",
        connectionId,
        providerConfigKey,
        teamId: payloadIdentity.teamId ?? undefined,
      });
      return payloadIdentity;
    }

    throw error;
  }
}

async function repairSlackIntegrationFromForwardEvent(
  envelope: NangoWebhookEnvelope,
  provider: WorkspaceIntegrationProvider | null,
): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    return;
  }

  const integration = provider && isSlackProvider(provider)
    ? await findWorkspaceIntegrationByConnection(provider, connectionId) ??
      await findSlackIntegrationByConnectionId(connectionId)
    : await findSlackIntegrationByConnectionId(connectionId);
  const payloadIdentity = extractSlackConnectionIdentityFromForwardPayload(envelope.payload);
  const slackStableId = payloadIdentity.teamId ?? payloadIdentity.enterpriseId;
  const resolvedIntegration = integration ??
    (slackStableId ? await findSlackIntegrationByTeamId(slackStableId) : null);

  if (!resolvedIntegration) {
    await logger.warn("Slack forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
      teamId: payloadIdentity.teamId ?? undefined,
      enterpriseId: payloadIdentity.enterpriseId ?? undefined,
    });
    return;
  }

  if (!hasSlackConnectionIdentity(payloadIdentity)) {
    return;
  }

  const mergedMetadata = mergeSlackConnectionIdentityMetadata(
    resolvedIntegration.metadata,
    payloadIdentity,
  );
  if (
    resolvedIntegration.connectionId === connectionId &&
    JSON.stringify(mergedMetadata) === JSON.stringify(resolvedIntegration.metadata)
  ) {
    return;
  }

  await upsertWorkspaceIntegration({
    workspaceId: resolvedIntegration.workspaceId,
    provider: resolvedIntegration.provider,
    connectionId,
    providerConfigKey: resolvedIntegration.providerConfigKey,
    installationId: resolvedIntegration.installationId,
    metadata: mergedMetadata,
  });

  await logger.info("Slack forward webhook repaired workspace integration metadata", {
    area: "nango-webhook",
    workspaceId: resolvedIntegration.workspaceId,
    provider: resolvedIntegration.provider,
    connectionId,
    teamId: payloadIdentity.teamId ?? undefined,
    enterpriseId: payloadIdentity.enterpriseId ?? undefined,
  });
}

function readGoogleForwardHeader(
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  headerName: string,
): string | null {
  return (
    getHeader(headers, headerName) ??
    readString(payload, headerName) ??
    readString(payload, headerName.replace(/-/gu, "_"))
  );
}

function inferGoogleCalendarForwardSyncs(input: {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}): readonly string[] {
  const resourceUri = readGoogleForwardHeader(
    input.payload,
    input.headers,
    "x-goog-resource-uri",
  )?.toLowerCase();

  if (!resourceUri) {
    return [
      GOOGLE_CALENDAR_EVENTS_SYNC,
      GOOGLE_CALENDAR_ACLS_SYNC,
      GOOGLE_CALENDAR_LIST_SYNC,
      GOOGLE_CALENDAR_SETTINGS_SYNC,
    ];
  }

  if (resourceUri.includes("/events")) {
    return [GOOGLE_CALENDAR_EVENTS_SYNC];
  }
  if (resourceUri.includes("/acl")) {
    return [GOOGLE_CALENDAR_ACLS_SYNC];
  }
  if (resourceUri.includes("/calendarlist")) {
    return [GOOGLE_CALENDAR_LIST_SYNC];
  }
  if (resourceUri.includes("/settings")) {
    return [GOOGLE_CALENDAR_SETTINGS_SYNC];
  }

  return [
    GOOGLE_CALENDAR_EVENTS_SYNC,
    GOOGLE_CALENDAR_ACLS_SYNC,
    GOOGLE_CALENDAR_LIST_SYNC,
    GOOGLE_CALENDAR_SETTINGS_SYNC,
  ];
}

type GoogleMailPubSubNotification = {
  emailAddress: string | null;
  historyId: string | null;
};

type GoogleMailHistoryReplayResult =
  | { status: "ok"; nextHistoryId: string; messagesWritten: number; threadsWritten: number }
  | { status: "stale" };

const GOOGLE_MAIL_FORWARD_HISTORY_METADATA_KEYS = [
  "gmailForwardHistoryId",
  "googleMailForwardHistoryId",
  "gmailWatchHistoryId",
  "googleMailWatchHistoryId",
] as const;

function decodeGoogleMailPubSubNotification(payload: unknown): GoogleMailPubSubNotification | null {
  const payloadRecord = isObject(payload) ? payload : null;
  const forwardedPayload = readRecord(payloadRecord, "payload") ?? payloadRecord;
  const messageRecord = readRecord(forwardedPayload, "message");
  const encodedData = readString(messageRecord, "data");
  if (!encodedData) {
    return null;
  }

  try {
    const decoded = Buffer.from(encodedData, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!isObject(parsed)) {
      return null;
    }

    return {
      emailAddress: readString(parsed, "emailAddress"),
      historyId: readString(parsed, "historyId"),
    };
  } catch {
    return null;
  }
}

function readGoogleMailHistoryIdFromMetadata(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) {
    return null;
  }

  for (const key of GOOGLE_MAIL_FORWARD_HISTORY_METADATA_KEYS) {
    const value = readString(metadata, key);
    if (value) {
      return value;
    }
  }

  return (
    readGoogleMailHistoryIdFromMetadata(readRecord(metadata, "metadata")) ??
    readGoogleMailHistoryIdFromMetadata(readRecord(metadata, "connection_config"))
  );
}

async function resolveGoogleMailForwardHistoryId(input: {
  integration: { metadata: Record<string, unknown>; connectionId: string };
  providerConfigKey: string;
}): Promise<string | null> {
  const localHistoryId = readGoogleMailHistoryIdFromMetadata(input.integration.metadata);
  if (localHistoryId) {
    return localHistoryId;
  }

  const details = await getNangoConnectionDetails(
    input.integration.connectionId,
    input.providerConfigKey,
  );
  return readGoogleMailHistoryIdFromMetadata(details?.payload ?? null);
}

function compareGoogleMailHistoryIds(left: string, right: string): number {
  try {
    const leftBigInt = BigInt(left);
    const rightBigInt = BigInt(right);
    if (leftBigInt > rightBigInt) return 1;
    if (leftBigInt < rightBigInt) return -1;
    return 0;
  } catch {
    if (left.length !== right.length) {
      return left.length > right.length ? 1 : -1;
    }
    if (left === right) return 0;
    return left > right ? 1 : -1;
  }
}

function newestGoogleMailHistoryId(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return compareGoogleMailHistoryIds(left, right) >= 0 ? left : right;
}

function isNangoProxyNotFoundError(error: unknown): boolean {
  if (readNangoProxyStatus(error) === 404) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  const payload = isObject(record.payload) ? record.payload : null;
  const nestedError = readRecord(payload, "error");
  const code = nestedError?.code;
  return code === 404 || code === "404";
}

function readNangoProxyStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const record = error as Record<string, unknown>;
  for (const key of ["status", "statusCode"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }
  const response = isObject(record.response) ? record.response : null;
  const responseStatus = response?.status;
  return typeof responseStatus === "number" && Number.isInteger(responseStatus)
    ? responseStatus
    : null;
}

function isRetryableNangoProxyError(error: unknown): boolean {
  const status = readNangoProxyStatus(error);
  return status === 429 || (typeof status === "number" && status >= 500 && status < 600);
}

function readHeaderValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") {
    return null;
  }
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    if (typeof value === "string") {
      return value;
    }
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()] ?? record["Retry-After"];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return null;
}

function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const response = isObject((error as Record<string, unknown>).response)
    ? (error as Record<string, unknown>).response as Record<string, unknown>
    : null;
  const retryAfter = readHeaderValue(response?.headers, "retry-after");
  if (!retryAfter) {
    return null;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const retryAt = Date.parse(retryAfter);
  if (!Number.isFinite(retryAt)) {
    return null;
  }
  return Math.max(0, retryAt - Date.now());
}

async function fetchGoogleMailProxyData(input: {
  endpoint: string;
  connectionId: string;
  providerConfigKey: string;
  params?: Record<string, string>;
}): Promise<unknown> {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await getNangoProxyClient().proxy({
        method: "GET",
        endpoint: input.endpoint,
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        ...(input.params ? { params: input.params } : {}),
      });
      return response?.data;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableNangoProxyError(error)) {
        throw error;
      }
      const delay = Math.min(
        retryAfterMs(error) ?? Math.min(250 * 2 ** (attempt - 1), 2_000),
        GOOGLE_MAIL_PROXY_RETRY_AFTER_MAX_MS,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

function collectGoogleMailHistoryRef(
  value: unknown,
  messageIdsToRefresh: Set<string>,
  messageIdsToDelete: Set<string>,
  threadIdsToRefresh: Set<string>,
): void {
  if (!isObject(value)) {
    return;
  }
  const id = readString(value, "id");
  const threadId = readString(value, "threadId");
  if (id) {
    messageIdsToRefresh.add(id);
    messageIdsToDelete.delete(id);
  }
  if (threadId) {
    threadIdsToRefresh.add(threadId);
  }
}

function collectGoogleMailHistoryChange(
  value: unknown,
  messageIdsToRefresh: Set<string>,
  messageIdsToDelete: Set<string>,
  threadIdsToRefresh: Set<string>,
): void {
  if (!isObject(value)) {
    return;
  }
  collectGoogleMailHistoryRef(
    readRecord(value, "message"),
    messageIdsToRefresh,
    messageIdsToDelete,
    threadIdsToRefresh,
  );
}

function collectGoogleMailHistoryDelete(
  value: unknown,
  messageIdsToRefresh: Set<string>,
  messageIdsToDelete: Set<string>,
  threadIdsToRefresh: Set<string>,
): void {
  const message = isObject(value) ? readRecord(value, "message") : null;
  const id = readString(message, "id");
  const threadId = readString(message, "threadId");
  if (id) {
    messageIdsToDelete.add(id);
    messageIdsToRefresh.delete(id);
  }
  if (threadId) {
    threadIdsToRefresh.add(threadId);
  }
}

function collectGoogleMailHistoryPage(
  historyData: unknown,
  messageIdsToRefresh: Set<string>,
  messageIdsToDelete: Set<string>,
  threadIdsToRefresh: Set<string>,
): string | null {
  if (!isObject(historyData)) {
    return null;
  }

  const history = historyData.history;
  if (!Array.isArray(history)) {
    return readString(historyData, "historyId");
  }

  for (const entry of history) {
    if (!isObject(entry)) continue;

    for (const message of Array.isArray(entry.messages) ? entry.messages : []) {
      collectGoogleMailHistoryRef(message, messageIdsToRefresh, messageIdsToDelete, threadIdsToRefresh);
    }
    for (const added of Array.isArray(entry.messagesAdded) ? entry.messagesAdded : []) {
      collectGoogleMailHistoryChange(added, messageIdsToRefresh, messageIdsToDelete, threadIdsToRefresh);
    }
    for (const labelChange of Array.isArray(entry.labelsAdded) ? entry.labelsAdded : []) {
      collectGoogleMailHistoryChange(labelChange, messageIdsToRefresh, messageIdsToDelete, threadIdsToRefresh);
    }
    for (const labelChange of Array.isArray(entry.labelsRemoved) ? entry.labelsRemoved : []) {
      collectGoogleMailHistoryChange(labelChange, messageIdsToRefresh, messageIdsToDelete, threadIdsToRefresh);
    }
    for (const deleted of Array.isArray(entry.messagesDeleted) ? entry.messagesDeleted : []) {
      collectGoogleMailHistoryDelete(deleted, messageIdsToRefresh, messageIdsToDelete, threadIdsToRefresh);
    }
  }

  return readString(historyData, "historyId");
}

async function fetchGoogleMailMessageRecord(input: {
  messageId: string;
  connectionId: string;
  providerConfigKey: string;
  deletedAt: string;
}): Promise<Record<string, unknown>> {
  try {
    const data = await fetchGoogleMailProxyData({
      endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(input.messageId)}`,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      params: { format: "full" },
    });
    return isObject(data) ? data : { id: input.messageId };
  } catch (error) {
    if (isNangoProxyNotFoundError(error)) {
      return buildDeletionRecord(input.messageId, { deletedAt: input.deletedAt });
    }
    throw error;
  }
}

async function fetchGoogleMailThreadRecord(input: {
  threadId: string;
  connectionId: string;
  providerConfigKey: string;
  deletedAt: string;
}): Promise<Record<string, unknown>> {
  try {
    const data = await fetchGoogleMailProxyData({
      endpoint: `/gmail/v1/users/me/threads/${encodeURIComponent(input.threadId)}`,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      params: { format: "full" },
    });
    return isObject(data) ? data : { id: input.threadId };
  } catch (error) {
    if (isNangoProxyNotFoundError(error)) {
      return buildDeletionRecord(input.threadId, { deletedAt: input.deletedAt });
    }
    throw error;
  }
}

async function replayGoogleMailHistoryToRelayfile(input: {
  workspaceId: string;
  connectionId: string;
  providerConfigKey: string;
  startHistoryId: string;
  webhookHistoryId: string | null;
  eventAt: string;
}): Promise<GoogleMailHistoryReplayResult> {
  const writeOptions = { concurrency: 1 };
  const messageIdsToRefresh = new Set<string>();
  const messageIdsToDelete = new Set<string>();
  const threadIdsToRefresh = new Set<string>();
  let pageToken: string | null = null;
  let nextHistoryId: string | null = input.startHistoryId;

  do {
    let historyData: unknown;
    try {
      historyData = await fetchGoogleMailProxyData({
        endpoint: "/gmail/v1/users/me/history",
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        params: {
          startHistoryId: input.startHistoryId,
          ...(pageToken ? { pageToken } : {}),
        },
      });
    } catch (error) {
      if (isNangoProxyNotFoundError(error)) {
        return { status: "stale" };
      }
      throw error;
    }

    nextHistoryId = newestGoogleMailHistoryId(
      nextHistoryId,
      collectGoogleMailHistoryPage(
        historyData,
        messageIdsToRefresh,
        messageIdsToDelete,
        threadIdsToRefresh,
      ),
    );
    pageToken = isObject(historyData) ? readString(historyData, "nextPageToken") : null;
  } while (pageToken);

  const messageRecords: Record<string, unknown>[] = [];
  for (const messageId of messageIdsToRefresh) {
    messageRecords.push(await fetchGoogleMailMessageRecord({
      messageId,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      deletedAt: input.eventAt,
    }));
  }
  for (const messageId of messageIdsToDelete) {
    messageRecords.push(buildDeletionRecord(messageId, { deletedAt: input.eventAt }));
  }

  const threadRecords: Record<string, unknown>[] = [];
  for (const threadId of threadIdsToRefresh) {
    threadRecords.push(await fetchGoogleMailThreadRecord({
      threadId,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      deletedAt: input.eventAt,
    }));
  }

  const client =
    messageRecords.length > 0 || threadRecords.length > 0
      ? createGitHubRelayfileClient(input.workspaceId)
      : null;

  if (messageRecords.length > 0 && client) {
    await writeGoogleMailBatchToRelayfile(
      client,
      messageRecords,
      makeForwardSyncJob({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        provider: GOOGLE_MAIL_PROVIDER,
        syncName: GOOGLE_MAIL_MESSAGES_SYNC_NAME,
        model: GOOGLE_MAIL_MESSAGE_MODEL,
      }),
      writeOptions,
    );
  }

  if (threadRecords.length > 0 && client) {
    await writeGoogleMailBatchToRelayfile(
      client,
      threadRecords,
      makeForwardSyncJob({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        provider: GOOGLE_MAIL_PROVIDER,
        syncName: GOOGLE_MAIL_THREADS_SYNC_NAME,
        model: GOOGLE_MAIL_THREAD_MODEL,
      }),
      writeOptions,
    );
  }

  return {
    status: "ok",
    nextHistoryId: newestGoogleMailHistoryId(nextHistoryId, input.webhookHistoryId) ?? input.startHistoryId,
    messagesWritten: messageRecords.length,
    threadsWritten: threadRecords.length,
  };
}

class GoogleMailDirectReplayUnavailableError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "GoogleMailDirectReplayUnavailableError";
  }
}

async function writeGoogleMailBatchToRelayfile(
  client: Parameters<typeof writeBatchToRelayfileOrThrow>[0],
  records: Parameters<typeof writeBatchToRelayfileOrThrow>[1],
  job: Parameters<typeof writeBatchToRelayfileOrThrow>[2],
  options: Parameters<typeof writeBatchToRelayfileOrThrow>[3],
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GOOGLE_MAIL_RELAYFILE_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await writeBatchToRelayfileOrThrow(client, records, job, options);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= GOOGLE_MAIL_RELAYFILE_WRITE_ATTEMPTS) {
        break;
      }
      await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
    }
  }
  throw new GoogleMailDirectReplayUnavailableError(
    "Google Mail direct Relayfile replay failed after retries",
    lastError,
  );
}

async function saveGoogleMailForwardHistoryId(input: {
  workspaceId: string;
  connectionId: string;
  historyId: string;
  eventAt: string;
}): Promise<void> {
  await updateWorkspaceIntegrationMetadata({
    workspaceId: input.workspaceId,
    provider: GOOGLE_MAIL_PROVIDER,
    connectionId: input.connectionId,
    update: (metadata) => {
      const current = readGoogleMailHistoryIdFromMetadata(metadata);
      const next = newestGoogleMailHistoryId(current, input.historyId);
      if (!next || next === current) {
        return null;
      }
      return {
        ...metadata,
        gmailForwardHistoryId: next,
        gmailForwardHistoryUpdatedAt: input.eventAt,
      };
    },
  });
}

async function triggerGoogleMailIncrementalSync(input: {
  providerConfigKey: string;
  connectionId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await triggerNangoSyncs({
    providerConfigKey: input.providerConfigKey,
    connectionId: input.connectionId,
    syncs: [...GOOGLE_MAIL_WEBHOOK_SYNC_NAMES],
    syncMode: "incremental",
  });
  if (!result.ok) {
    return {
      ok: false,
      error: `Failed to trigger Google Mail syncs from forward webhook: ${result.status}`,
    };
  }
  return { ok: true };
}

async function triggerGoogleMailIncrementalSyncAndRecord(input: {
  workspaceId: string;
  providerConfigKey: string;
  connectionId: string;
  eventAt: string;
}): Promise<boolean> {
  const result = await triggerGoogleMailIncrementalSync({
    providerConfigKey: input.providerConfigKey,
    connectionId: input.connectionId,
  }).catch((error) => ({
    ok: false as const,
    error:
      error instanceof Error
        ? error.message
        : "Failed to trigger Google Mail syncs from forward webhook",
  }));
  await recordGoogleMailWebhookHealth({
    workspaceId: input.workspaceId,
    healthy: result.ok,
    eventAt: input.eventAt,
    error: result.ok ? null : result.error,
  });
  return result.ok;
}

async function handleGoogleMailForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Google Mail forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(
    GOOGLE_MAIL_PROVIDER,
    connectionId,
  );
  if (!integration) {
    await logger.warn("Google Mail forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(GOOGLE_MAIL_PROVIDER);
  const eventAt = new Date().toISOString();
  const notification = decodeGoogleMailPubSubNotification(envelope.payload);

  try {
    const storedHistoryId = await resolveGoogleMailForwardHistoryId({
      integration,
      providerConfigKey,
    });

    if (!notification?.historyId || !storedHistoryId) {
      await enqueueIntegrationWatchEvent({
        workspaceId: integration.workspaceId,
        provider: GOOGLE_MAIL_PROVIDER,
        eventType: "message.changed",
        connectionId,
        payload: envelope.payload,
      });
      const syncQueued = await triggerGoogleMailIncrementalSyncAndRecord({
        workspaceId: integration.workspaceId,
        providerConfigKey,
        connectionId,
        eventAt,
      });
      await logger.info("Google Mail forward webhook fell back to incremental sync", {
        area: "nango-webhook",
        workspaceId: integration.workspaceId,
        connectionId,
        reason: notification?.historyId ? "missing-history-checkpoint" : "missing-pubsub-history-id",
        syncQueued,
      });
      return;
    }

    if (compareGoogleMailHistoryIds(notification.historyId, storedHistoryId) <= 0) {
      await recordGoogleMailWebhookHealth({
        workspaceId: integration.workspaceId,
        healthy: true,
        eventAt,
        error: null,
      });
      await logger.info("Google Mail forward webhook skipped old history notification", {
        area: "nango-webhook",
        workspaceId: integration.workspaceId,
        connectionId,
        storedHistoryId,
        webhookHistoryId: notification.historyId,
      });
      return;
    }

    await enqueueIntegrationWatchEvent({
      workspaceId: integration.workspaceId,
      provider: GOOGLE_MAIL_PROVIDER,
      eventType: "message.changed",
      connectionId,
      payload: envelope.payload,
    });

    const replayResult = await replayGoogleMailHistoryToRelayfile({
      workspaceId: integration.workspaceId,
      connectionId,
      providerConfigKey,
      startHistoryId: storedHistoryId,
      webhookHistoryId: notification.historyId,
      eventAt,
    });

    if (replayResult.status === "stale") {
      const syncQueued = await triggerGoogleMailIncrementalSyncAndRecord({
        workspaceId: integration.workspaceId,
        providerConfigKey,
        connectionId,
        eventAt,
      });
      await logger.warn("Google Mail forward webhook history checkpoint was stale; triggered incremental sync", {
        area: "nango-webhook",
        workspaceId: integration.workspaceId,
        connectionId,
        storedHistoryId,
        webhookHistoryId: notification.historyId,
        syncQueued,
      });
      return;
    }

    await saveGoogleMailForwardHistoryId({
      workspaceId: integration.workspaceId,
      connectionId,
      historyId: replayResult.nextHistoryId,
      eventAt,
    });
    await recordGoogleMailWebhookHealth({
      workspaceId: integration.workspaceId,
      healthy: true,
      eventAt,
      error: null,
    });

    await logger.info("Google Mail forward webhook ingested directly", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      emailAddress: notification.emailAddress ?? undefined,
      messagesWritten: replayResult.messagesWritten,
      threadsWritten: replayResult.threadsWritten,
      nextHistoryId: replayResult.nextHistoryId,
    });
  } catch (error) {
    if (
      notification?.historyId &&
      (isRetryableNangoProxyError(error) || error instanceof GoogleMailDirectReplayUnavailableError)
    ) {
      try {
        const syncQueued = await triggerGoogleMailIncrementalSyncAndRecord({
          workspaceId: integration.workspaceId,
          providerConfigKey,
          connectionId,
          eventAt,
        });
        await logger.warn("Google Mail forward webhook direct replay failed; triggered incremental sync", {
          area: "nango-webhook",
          workspaceId: integration.workspaceId,
          connectionId,
          reason: error instanceof GoogleMailDirectReplayUnavailableError
            ? "relayfile-write-unavailable"
            : "nango-proxy-unavailable",
          error: error instanceof Error ? error.message : String(error),
          syncQueued,
        });
        return;
      } catch (fallbackError) {
        await recordGoogleMailWebhookHealth({
          workspaceId: integration.workspaceId,
          healthy: false,
          eventAt,
          error:
            fallbackError instanceof Error
              ? fallbackError.message
              : "Failed to process Google Mail forward webhook",
        });
        await logger.warn("Google Mail forward webhook fallback sync failed", {
          area: "nango-webhook",
          workspaceId: integration.workspaceId,
          connectionId,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        return;
      }
    }

    await recordGoogleMailWebhookHealth({
      workspaceId: integration.workspaceId,
      healthy: false,
      eventAt,
      error:
        error instanceof Error
          ? error.message
          : "Failed to process Google Mail forward webhook",
    });
    throw error;
  }
}

async function recordGoogleMailWebhookHealth(input: {
  workspaceId: string;
  healthy: boolean;
  eventAt: string;
  error: string | null;
}): Promise<void> {
  try {
    const ok = await reportWorkspaceProviderWebhookHealth({
      workspaceId: input.workspaceId,
      provider: GOOGLE_MAIL_PROVIDER,
      healthy: input.healthy,
      eventAt: input.eventAt,
      error: input.error,
    });
    if (!ok) {
      await logger.warn("Google Mail webhook health report was not accepted", {
        area: "nango-webhook",
        workspaceId: input.workspaceId,
        healthy: input.healthy,
      });
    }
  } catch (error) {
    await logger.warn("Google Mail webhook health report failed", {
      area: "nango-webhook",
      workspaceId: input.workspaceId,
      healthy: input.healthy,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleGoogleCalendarForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Google Calendar forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(
    GOOGLE_CALENDAR_PROVIDER,
    connectionId,
  );
  if (!integration) {
    await logger.warn("Google Calendar forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  const payload = forwarded.payload ?? {};
  const resourceState = readGoogleForwardHeader(payload, forwarded.headers, "x-goog-resource-state")?.toLowerCase();
  if (resourceState === "sync") {
    await logger.info("Google Calendar forward webhook sync-state handshake ignored", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }

  const syncs = inferGoogleCalendarForwardSyncs({
    payload,
    headers: forwarded.headers,
  });
  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(GOOGLE_CALENDAR_PROVIDER);

  await Promise.all(syncs.map((syncName) =>
    enqueueIntegrationWatchEvent({
      workspaceId: integration.workspaceId,
      provider: GOOGLE_CALENDAR_PROVIDER,
      eventType:
        syncName === GOOGLE_CALENDAR_EVENTS_SYNC
          ? "event.changed"
          : syncName === GOOGLE_CALENDAR_ACLS_SYNC
            ? "acl.changed"
            : syncName === GOOGLE_CALENDAR_LIST_SYNC
              ? "calendar.changed"
              : syncName === GOOGLE_CALENDAR_SETTINGS_SYNC
                ? "setting.changed"
                : "calendar.changed",
      connectionId,
      deliveryId: buildInlineWatchDeliveryId({
        workspaceId: integration.workspaceId,
        provider: GOOGLE_CALENDAR_PROVIDER,
        eventType:
          syncName === GOOGLE_CALENDAR_EVENTS_SYNC
            ? "event.changed"
            : syncName === GOOGLE_CALENDAR_ACLS_SYNC
              ? "acl.changed"
              : syncName === GOOGLE_CALENDAR_LIST_SYNC
                ? "calendar.changed"
                : syncName === GOOGLE_CALENDAR_SETTINGS_SYNC
                  ? "setting.changed"
                  : "calendar.changed",
        connectionId,
        payload,
      }),
      payload,
    }),
  ));
  const result = await triggerNangoSyncs({
    providerConfigKey,
    connectionId,
    syncs: [...syncs],
    syncMode: "incremental",
  });
  if (!result.ok) {
    throw new Error(`Failed to trigger Google Calendar syncs from forward webhook: ${result.status}`);
  }

  await logger.info("Google Calendar forward webhook triggered syncs", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    syncs,
    resourceState: resourceState ?? undefined,
  });
}

export async function routeForwardEvent(envelope: NangoWebhookEnvelope): Promise<void> {
  const provider =
    normalizeProvider(envelope.providerConfigKey) ??
    normalizeNangoProviderToWorkspaceProvider(envelope.providerConfigKey) ??
    normalizeProvider(envelope.from) ??
    normalizeNangoProviderToWorkspaceProvider(envelope.from);

  if (isRickySlackForwardEnvelope(envelope)) {
    await handleRickySlackForward(envelope);
    return;
  }

  if (isSlackProvider(provider) || looksLikeSlackFrom(envelope.from)) {
    await repairSlackIntegrationFromForwardEvent(envelope, provider);
    if (
      isSlackRelayfileForward(envelope) ||
      await hasSlackRelayfileWorkspaceIntegration(envelope)
    ) {
      await handleSlackRelayfileForward(envelope);
      return;
    }
    await forwardToSage(envelope);
    return;
  }

  switch (provider) {
    case "github":
      await handleGitHubForward(envelope);
      return;
    case "notion":
      await handleNotionForward(envelope);
      return;
    case "hubspot":
      await handleHubSpotForward(envelope);
      return;
    case "linear":
      await handleLinearForward(envelope);
      return;
    case "gitlab":
      await handleGitLabForward(envelope);
      return;
    case "daytona":
      await routeDaytonaWebhook({
        connectionId: envelope.connectionId,
        payload: envelope.payload,
      });
      return;
    case "gcp":
      await handleGcpForward(envelope);
      return;
    case CLOUDFLARE_PROVIDER:
      await handleCloudflareForward(envelope);
      return;
    case "jira":
      await handleJiraForward(envelope);
      return;
    case "confluence":
      await handleConfluenceForward(envelope);
      return;
    case "google-mail":
      await handleGoogleMailForward(envelope);
      return;
    case "google-calendar":
      await handleGoogleCalendarForward(envelope);
      return;
    case "granola":
      await handleGranolaForward(envelope);
      return;
    case "recall":
      await handleRecallForward(envelope);
      return;
    case "fathom":
      await handleFathomForward(envelope);
      return;
    case "dropbox":
      await handleDropboxForward(envelope);
      return;
    default:
      await logger.warn("Nango forward webhook received for unknown provider", {
        area: "nango-webhook",
        provider: envelope.from,
        connectionId: envelope.connectionId ?? undefined,
        providerConfigKey: envelope.providerConfigKey || undefined,
      });
  }
}

async function handleGcpForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("GCP forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(
    GCP_PROVIDER,
    connectionId,
  );
  if (!integration) {
    await logger.warn("GCP forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  const normalized = normalizeGcpWebhook(
    forwarded.payload ?? envelope.payload,
    forwarded.headers,
  );
  if (!normalized) {
    await logger.warn("GCP forward webhook could not be normalized", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(GCP_PROVIDER);

  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: GCP_PROVIDER,
    eventType: normalized.eventType,
    connectionId,
    deliveryId: forwarded.deliveryId,
    paths: [normalized.path],
    payload: normalized.payload,
  });

  if (normalized.objectType === "monitoring-alert" && normalized.policyId) {
    const job = makeForwardSyncJob({
      workspaceId: integration.workspaceId,
      connectionId,
      providerConfigKey,
      provider: GCP_PROVIDER,
      syncName: GCP_MONITORING_ALERTS_SYNC,
      model: GCP_MONITORING_ALERT_MODEL,
    });
    const record: Record<string, unknown> = {
      id: normalized.policyId,
      policyId: normalized.policyId,
      displayName: normalized.displayName,
      enabled: true,
      conditionsSummary: normalized.conditionName ?? normalized.displayName,
      firing: normalized.firing,
      lastIncidentTs: normalized.timestamp,
      state: normalized.state,
      ...(normalized.resourceName ? { resourceName: normalized.resourceName } : {}),
      rawPayload: normalized.payload,
    };

    await writeBatchToRelayfileOrThrow(
      createGitHubRelayfileClient(integration.workspaceId),
      [record],
      job,
    );
    return;
  }

  const syncs = normalized.syncNames ? [...normalized.syncNames] : [];
  if (syncs.length === 0) {
    await logger.info("GCP forward webhook normalized without direct write or sync trigger", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      eventType: normalized.eventType,
      objectType: normalized.objectType,
      path: normalized.path,
    });
    return;
  }

  const result = await triggerNangoSyncs({
    providerConfigKey,
    connectionId,
    syncs,
  });
  if (!result.ok) {
    throw new Error(`Failed to trigger GCP syncs from forward webhook: ${result.status}`);
  }

  await logger.info("GCP forward webhook triggered syncs", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    eventType: normalized.eventType,
    objectType: normalized.objectType,
    syncs,
  });
}

async function handleCloudflareForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Cloudflare forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(
    CLOUDFLARE_PROVIDER,
    connectionId,
  );
  if (!integration) {
    await logger.warn("Cloudflare forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  const rawPayload = forwarded.payload ?? envelope.payload;
  if (!isObject(rawPayload)) {
    await logger.warn("Cloudflare forward webhook payload was not an object", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const normalized = normalizeCloudflareWebhook(rawPayload);
  if (!normalized) {
    await logger.warn("Cloudflare forward webhook could not be normalized", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(CLOUDFLARE_PROVIDER);

  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: CLOUDFLARE_PROVIDER,
    eventType: normalized.eventType,
    connectionId,
    deliveryId: forwarded.deliveryId,
    paths: [normalized.path],
    payload: normalized.payload,
  });

  const job = makeForwardSyncJob({
    workspaceId: integration.workspaceId,
    connectionId,
    providerConfigKey,
    provider: CLOUDFLARE_PROVIDER,
    syncName: CLOUDFLARE_NOTIFICATION_EVENTS_SYNC,
    model: CLOUDFLARE_NOTIFICATION_EVENT_MODEL,
  });
  const data = readRecord(normalized.payload, "data");
  const accountId =
    readString(rawPayload, "account_id") ??
    readString(rawPayload, "account_tag") ??
    undefined;
  const severity =
    normalized.state === "resolved"
      ? "low"
      : normalized.alertType.includes("billing") || normalized.alertType.includes("origin_error")
        ? "critical"
        : normalized.alertType.includes("health_check") || normalized.alertType.includes("workers")
          ? "high"
          : "medium";
  const title = `Cloudflare ${normalized.alertType} ${normalized.state ?? "event"}`;
  const record: Record<string, unknown> = {
    id: normalized.objectId,
    source: CLOUDFLARE_PROVIDER,
    kind: "runtime",
    occurred_at: normalized.timestamp,
    severity,
    title,
    url:
      accountId && normalized.policyId
        ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/alerting/v3/policies/${encodeURIComponent(normalized.policyId)}`
        : "https://developers.cloudflare.com/notifications/",
    alert_type: normalized.alertType,
    timestamp: normalized.timestamp,
    ...(accountId ? { account_id: accountId } : {}),
    ...(normalized.alertEvent ? { alert_event: normalized.alertEvent } : {}),
    ...(normalized.correlationId ? { correlation_id: normalized.correlationId } : {}),
    ...(normalized.policyId ? { policy_id: normalized.policyId } : {}),
    ...(normalized.policyName ? { policy_name: normalized.policyName } : {}),
    ...(normalized.state ? { state: normalized.state } : {}),
    ...(normalized.text ? { text: normalized.text } : {}),
    ...(data ? { data } : {}),
  };

  await writeBatchToRelayfileOrThrow(
    createGitHubRelayfileClient(integration.workspaceId),
    [record],
    job,
  );

  await logger.info("Cloudflare forward webhook ingested directly", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    eventType: normalized.eventType,
    path: normalized.path,
    deliveryId: forwarded.deliveryId ?? undefined,
  });
}

async function handleGranolaForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Granola forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(
    GRANOLA_PROVIDER,
    connectionId,
  );
  if (!integration) {
    await logger.warn("Granola forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(GRANOLA_PROVIDER);
  await Promise.all(
    GRANOLA_SYNC_NAMES.map((syncName) =>
      enqueueIntegrationWatchEvent({
        workspaceId: integration.workspaceId,
        provider: GRANOLA_PROVIDER,
        eventType: syncName === GRANOLA_NOTES_SYNC ? "note.changed" : "folder.changed",
        connectionId,
        payload: envelope.payload,
      }),
    ),
  );
  const result = await triggerNangoSyncs({
    providerConfigKey,
    connectionId,
    syncs: [...GRANOLA_SYNC_NAMES],
    syncMode: "incremental",
  });
  if (!result.ok) {
    throw new Error(`Failed to trigger Granola syncs from forward webhook: ${result.status}`);
  }

  await logger.info("Granola forward webhook triggered syncs", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    syncs: GRANOLA_SYNC_NAMES,
  });
}

async function handleRecallForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Recall forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(
    RECALL_PROVIDER,
    connectionId,
  );
  if (!integration) {
    await logger.warn("Recall forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(RECALL_PROVIDER);
  await Promise.all(
    RECALL_SYNC_NAMES.map((syncName) =>
      enqueueIntegrationWatchEvent({
        workspaceId: integration.workspaceId,
        provider: RECALL_PROVIDER,
        eventType: syncName === RECALL_RECORDINGS_SYNC ? "recording.changed" : "transcript.changed",
        connectionId,
        payload: envelope.payload,
      }),
    ),
  );
  const result = await triggerNangoSyncs({
    providerConfigKey,
    connectionId,
    syncs: [...RECALL_SYNC_NAMES],
    syncMode: "incremental",
  });
  if (!result.ok) {
    throw new Error(`Failed to trigger Recall syncs from forward webhook: ${result.status}`);
  }

  await logger.info("Recall forward webhook triggered syncs", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    syncs: RECALL_SYNC_NAMES,
  });
}

async function handleDropboxForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Dropbox forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(
    DROPBOX_PROVIDER,
    connectionId,
  );
  if (!integration) {
    await logger.warn("Dropbox forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(DROPBOX_PROVIDER);
  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  const normalized = normalizeDropboxWebhook(
    forwarded.payload ?? envelope.payload,
    forwarded.headers,
  );
  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: DROPBOX_PROVIDER,
    eventType: normalized.eventType,
    connectionId,
    payload: normalized.payload,
    paths: [
      "/dropbox/files/_index.json",
      "/dropbox/folders/_index.json",
      "/dropbox/shared-folders/_index.json",
      "/dropbox/shared-links/_index.json",
    ],
  });
  const result = await triggerNangoSyncs({
    providerConfigKey,
    connectionId,
    syncs: [...DROPBOX_SYNC_NAMES],
    syncMode: "incremental",
  });
  if (!result.ok) {
    throw new Error(`Failed to trigger Dropbox syncs from forward webhook: ${result.status}`);
  }

  await logger.info("Dropbox forward webhook triggered syncs", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    accountIds: normalized.accountIds,
    syncs: DROPBOX_SYNC_NAMES,
  });
}

async function handleFathomForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Fathom forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(FATHOM_PROVIDER, connectionId);
  if (!integration) {
    await logger.warn("Fathom forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(FATHOM_PROVIDER);
  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  if (!forwarded.payload) {
    await logger.warn("Fathom forward webhook payload was empty after unwrapping", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      providerConfigKey,
    });
    return;
  }

  const normalized = normalizeFathomWebhook(forwarded.payload, forwarded.headers);
  const client = createGitHubRelayfileClient(integration.workspaceId);
  const meetingId = normalized.objectId;
  const maybeSummary = readRecord(normalized.payload, "default_summary");
  const maybeTranscript = normalized.payload["transcript"];
  const paths = [computeFathomPath("meeting", meetingId)];
  if (maybeSummary) {
    paths.push(computeFathomPath("recording-summary", meetingId));
  }
  if (Array.isArray(maybeTranscript)) {
    paths.push(computeFathomPath("recording-transcript", meetingId));
  }
  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: FATHOM_PROVIDER,
    eventType: normalized.eventType,
    connectionId,
    deliveryId: normalized.deliveryId ?? null,
    paths,
    payload: normalized.payload,
  });
  const meetingRecord: Record<string, unknown> = {
    id: meetingId,
    ...normalized.payload,
  };
  const meetingJob = createWebhookSyncJob({
    workspaceId: integration.workspaceId,
    connectionId,
    providerConfigKey,
    provider: FATHOM_PROVIDER,
    syncName: FATHOM_MEETINGS_SYNC,
    model: FATHOM_MEETING_MODEL,
  });
  await writeBatchToRelayfileOrThrow(client, [meetingRecord], meetingJob);

  const eventTimestamp = new Date().toISOString();
  if (maybeSummary) {
    const summaryJob = createWebhookSyncJob({
      workspaceId: integration.workspaceId,
      connectionId,
      providerConfigKey,
      provider: FATHOM_PROVIDER,
      syncName: FATHOM_RECORDING_SUMMARIES_SYNC,
      model: FATHOM_RECORDING_SUMMARY_MODEL,
    });
    await writeBatchToRelayfileOrThrow(
      client,
      [
        {
          id: meetingId,
          recording_id: Number(meetingId),
          created_at: readString(normalized.payload, "created_at") ?? eventTimestamp,
          summary: maybeSummary,
          source_meeting_url: readString(normalized.payload, "url") ?? undefined,
          source_share_url: readString(normalized.payload, "share_url") ?? undefined,
          fetched_at: eventTimestamp,
        },
      ],
      summaryJob,
    );
  }

  if (Array.isArray(maybeTranscript)) {
    const transcriptJob = createWebhookSyncJob({
      workspaceId: integration.workspaceId,
      connectionId,
      providerConfigKey,
      provider: FATHOM_PROVIDER,
      syncName: FATHOM_RECORDING_TRANSCRIPTS_SYNC,
      model: FATHOM_RECORDING_TRANSCRIPT_MODEL,
    });
    await writeBatchToRelayfileOrThrow(
      client,
      [
        {
          id: meetingId,
          recording_id: Number(meetingId),
          created_at: readString(normalized.payload, "created_at") ?? eventTimestamp,
          transcript: maybeTranscript,
          source_meeting_url: readString(normalized.payload, "url") ?? undefined,
          source_share_url: readString(normalized.payload, "share_url") ?? undefined,
          fetched_at: eventTimestamp,
        },
      ],
      transcriptJob,
    );
  }

  await logger.info("Fathom forward webhook ingested directly", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    providerConfigKey,
    eventType: normalized.eventType,
    meetingId,
  });
}

async function handleSlackRelayfileForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const routeStartedAt = Date.now();
  const timings: Record<string, number> = {};
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Slack relayfile forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  let stageStartedAt = Date.now();
  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  const payloadIdentity = extractSlackConnectionIdentityFromForwardPayload(
    forwarded.payload ?? envelope.payload,
  );
  const slackStableId = payloadIdentity.teamId ?? payloadIdentity.enterpriseId;
  const integration =
    await findWorkspaceIntegrationByConnection("slack", connectionId) ??
    await findSlackIntegrationByConnectionId(connectionId) ??
    (slackStableId ? await findSlackIntegrationByTeamId(slackStableId) : null);
  timings.integrationLookupDurationMs = Date.now() - stageStartedAt;
  if (!integration) {
    await logger.error("Slack relayfile forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
      teamId: payloadIdentity.teamId ?? undefined,
      enterpriseId: payloadIdentity.enterpriseId ?? undefined,
    });
    throw new Error(
      `Slack relayfile forward webhook has no matching workspace integration for connection ${connectionId}`,
    );
  }

  if (!forwarded.payload) {
    await logger.warn("Slack relayfile forward webhook payload was not an object", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }

  stageStartedAt = Date.now();
  const normalized = normalizeSlackForwardRecord(forwarded.payload);
  timings.normalizeDurationMs = Date.now() - stageStartedAt;
  if (!normalized) {
    await logger.info("Slack relayfile forward webhook skipped unsupported event", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }
  if (
    normalized.model === SLACK_MESSAGE_MODEL &&
    isBotAuthoredSlackMessage(normalized.record, integration.metadata)
  ) {
    await logger.info("Slack relayfile forward webhook skipped bot-authored message", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      eventType: readString(readRecord(normalized.record, "_webhook"), "eventType") ?? undefined,
    });
    return;
  }

  stageStartedAt = Date.now();
  const relayWorkspaceId = await resolveRelayfileCredentialWorkspaceId(integration.workspaceId);
  timings.relayWorkspaceResolveDurationMs = Date.now() - stageStartedAt;
  const client = createGitHubRelayfileClient(relayWorkspaceId);
  const providerConfigKey =
    integration.providerConfigKey || envelope.providerConfigKey || getProviderConfigKey("slack");
  stageStartedAt = Date.now();
  const preservedRecord = await preserveSlackChannelNameForSparseLifecycleEvent({
    client: client as unknown as {
      readFile?: (workspaceId: string, path: string) => Promise<{ content?: unknown } | string | null>;
    },
    workspaceId: relayWorkspaceId,
    model: normalized.model,
    record: normalized.record,
  });
  timings.preserveChannelNameDurationMs = Date.now() - stageStartedAt;
  stageStartedAt = Date.now();
  const namedRecord = normalized.model === SLACK_MESSAGE_MODEL
    ? await withSlackMessageChannelName({
        client: client as unknown as {
          readFile?: (workspaceId: string, path: string) => Promise<{ content?: unknown } | string | null>;
        },
        workspaceId: relayWorkspaceId,
        connectionId,
        providerConfigKey,
        record: preservedRecord,
      })
    : preservedRecord;
  if (!namedRecord) {
    return;
  }
  const record = normalized.model === SLACK_MESSAGE_MODEL
    ? await withSlackDirectMessageUser(namedRecord, { connectionId, providerConfigKey })
    : namedRecord;
  timings.directMessageResolveDurationMs = Date.now() - stageStartedAt;

  // Idempotency guard. Nango/Hookdeck can redeliver the same Slack forward
  // multiple times; without a claim each redelivery re-runs the human-thread-
  // reply side effects (reaction + note write + RECALL agent wake) AND a fresh
  // relayfile write + integration-watch enqueue, so the agent wakes N times and
  // replies N times (observed: one @mention → 2-3 jokes). Claim ONCE here,
  // before any durable side effect, so the entire handler is idempotent.
  //
  // Key on Slack's per-event `event_id` when present: it is stable across
  // redeliveries of the same event but distinct for a later edit/delete of the
  // same message, so a real `message.updated`/`message.deleted` for an already-
  // seen `ts` is NOT mistaken for a redelivery (it has its own event_id and
  // still passes through). When no event_id survives the forward, fall back to
  // (channel, ts, thread_ts, eventType, subtype) — still distinguishing edits/
  // deletes/different event types for the same ts. Use the durable, cross-
  // isolate dedupe store (the Notion path's in-memory ring does NOT survive
  // across Cloudflare isolates). Release the claim on failure so a transient
  // error still allows redelivery recovery (mirrors the Notion forward path).
  const dedupeEventId = readString(forwarded.payload, "event_id");
  const dedupeTs = readString(record, "ts");
  const dedupeChannel = readString(record, "channel");
  const dedupeThreadTs = readString(record, "thread_ts");
  const dedupeSubtype = readString(record, "subtype");
  const eventType =
    readString(readRecord(record, "_webhook"), "eventType") ??
    normalized.model;
  const slackForwardDedupeId = dedupeEventId
    ? [relayWorkspaceId, "slack", dedupeEventId].join(":")
    : dedupeChannel && dedupeTs
      ? [
          relayWorkspaceId,
          dedupeChannel,
          dedupeTs,
          dedupeThreadTs ?? "",
          eventType,
          dedupeSubtype ?? "",
        ].join(":")
      : null;
  if (
    slackForwardDedupeId &&
    !(await claimWebhookDelivery({ surface: "slack", deliveryId: slackForwardDedupeId }))
  ) {
    await logger.info("Slack relayfile forward redelivery suppressed", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      relayWorkspaceId,
      connectionId,
      channel: dedupeChannel ?? undefined,
      ts: dedupeTs ?? undefined,
      threadTs: dedupeThreadTs ?? undefined,
      eventId: dedupeEventId ?? undefined,
      eventType,
    });
    return;
  }

  let replyReactionAdded = false;
  let threadReplyNotePath: string | null = null;
  try {
    if (
      normalized.model === SLACK_MESSAGE_MODEL &&
      (await isHumanSlackThreadReply({ workspaceId: integration.workspaceId, record }))
    ) {
      stageStartedAt = Date.now();
      replyReactionAdded = await addSlackThreadReplyReaction({
        connectionId,
        providerConfigKey,
        record,
        name: "eyes",
      });
      timings.threadReplyReactionDurationMs = Date.now() - stageStartedAt;

      stageStartedAt = Date.now();
      const threadReplyNote = await writeSlackThreadReplyNote({
        client: client as unknown as {
          writeFile?: (args: {
            workspaceId: string;
            path: string;
            baseRevision: string;
            content: string;
            contentType: string;
            encoding: string;
          }) => Promise<unknown>;
        },
        workspaceId: relayWorkspaceId,
        connectionId,
        providerConfigKey,
        record,
      });
      threadReplyNotePath = threadReplyNote?.path ?? null;
      timings.threadReplyNoteWriteDurationMs = Date.now() - stageStartedAt;

      if (threadReplyNote) {
        stageStartedAt = Date.now();
        await enqueueIntegrationWatchEvent({
          workspaceId: relayWorkspaceId,
          provider: RECALL_PROVIDER,
          eventType: "recording.changed",
          connectionId: relayWorkspaceId,
          deliveryId: forwarded.deliveryId,
          paths: [threadReplyNote.path],
          payload: threadReplyNote.note,
        });
        timings.threadReplyNoteWatchEnqueueDurationMs = Date.now() - stageStartedAt;
      }
    }

    stageStartedAt = Date.now();
    await writeBatchToRelayfileOrThrow(client, [record], makeForwardSyncJob({
      workspaceId: relayWorkspaceId,
      connectionId,
      providerConfigKey,
      provider: "slack",
      syncName: "fetch-channel-history",
      model: normalized.model,
    }), {
      materializeContract: false,
      // Live Slack message forwards preserve the flat Cloud record shape and
      // compute the canonical path here; adapter aux emission is sync-shaped and
      // would also materialize resolved IMs under the raw diagnostic D-channel.
      materializeAuxiliaryFiles: normalized.model !== SLACK_MESSAGE_MODEL,
    });
    timings.relayfileWriteDurationMs = Date.now() - stageStartedAt;
    stageStartedAt = Date.now();
    await enqueueIntegrationWatchEvent({
      workspaceId: relayWorkspaceId,
      provider: "slack",
      eventType,
      connectionId,
      deliveryId: forwarded.deliveryId,
      paths: normalized.model === SLACK_MESSAGE_MODEL ? slackMessageRecordPaths(record) : undefined,
      payload: record,
    });
    timings.watchEnqueueDurationMs = Date.now() - stageStartedAt;
  } catch (error) {
    if (slackForwardDedupeId) {
      // Releasing is best-effort recovery; never let a release failure mask the
      // original error that aborted the forward.
      try {
        await releaseWebhookDelivery({ surface: "slack", deliveryId: slackForwardDedupeId });
      } catch (releaseError) {
        await logger.error("Failed to release Slack webhook delivery claim", {
          area: "nango-webhook",
          workspaceId: integration.workspaceId,
          relayWorkspaceId,
          connectionId,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      }
    }
    throw error;
  }

  let relayBridgeMode: "skipped" | "waitUntil" | "awaited" = "skipped";
  if (normalized.model === SLACK_MESSAGE_MODEL) {
    stageStartedAt = Date.now();
    relayBridgeMode = await scheduleSlackRelayBridge({
      workspaceId: relayWorkspaceId,
      record,
      connectionId,
      deliveryId: forwarded.deliveryId,
    });
    timings.relayBridgeScheduleDurationMs = Date.now() - stageStartedAt;
  }

  await logger.info("Slack relayfile forward timing", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    relayWorkspaceId,
    connectionId,
    providerConfigKey,
    deliveryId: forwarded.deliveryId ?? undefined,
    model: normalized.model,
    eventType,
    channel: readString(record, "channel") ?? undefined,
    ts: readString(record, "ts") ?? undefined,
    threadTs: readString(record, "thread_ts") ?? undefined,
    replyReactionAdded,
    threadReplyNotePath: threadReplyNotePath ?? undefined,
    relayBridgeMode,
    responseDurationMs: Date.now() - routeStartedAt,
    ...timings,
  });

  await logger.info("Slack relayfile forward webhook ingested directly", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    relayWorkspaceId,
    connectionId,
    providerConfigKey,
    model: normalized.model,
  });
}

async function scheduleSlackRelayBridge(input: {
  workspaceId: string;
  record: Record<string, unknown>;
  connectionId: string;
  deliveryId: string | null;
}): Promise<"waitUntil" | "awaited"> {
  const waitUntil = readCloudflareWaitUntil();
  const channel = readString(input.record, "channel");
  const ts = readString(input.record, "ts");
  const startedAt = Date.now();
  const bridgePromise = (async () => {
    try {
      await maybeForwardSlackRelayBridge({
        workspaceId: input.workspaceId,
        record: input.record,
      });
      await logger.info("Slack relay bridge background completed", {
        area: "nango-webhook",
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        deliveryId: input.deliveryId ?? undefined,
        channel: channel ?? undefined,
        ts: ts ?? undefined,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      await logger.error("Slack relay bridge background failed", {
        area: "nango-webhook",
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        deliveryId: input.deliveryId ?? undefined,
        channel: channel ?? undefined,
        ts: ts ?? undefined,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  })();

  if (waitUntil) {
    waitUntil(bridgePromise);
    return "waitUntil";
  }

  await bridgePromise;
  return "awaited";
}

async function maybeForwardSlackRelayBridge(input: {
  workspaceId: string;
  record: Record<string, unknown>;
}): Promise<void> {
  const subtype = readString(input.record, "subtype");
  const deletedAt = readString(readRecord(input.record, "_nango_metadata"), "deleted_at");
  if (subtype || deletedAt) {
    return;
  }

  const slackChannelId = readString(input.record, "channel");
  const slackTs = readString(input.record, "ts");
  if (!slackChannelId || !slackTs) {
    return;
  }

  const outcome = await forwardSlackToRelay(
    {
      workspaceId: input.workspaceId,
      slackChannelId,
      slackTs,
      text: readString(input.record, "text") ?? "",
      slackUserId: readString(input.record, "user") ?? undefined,
    },
    {
      store: createSlackRelayBridgeStore(),
      poster: createRelaycastPoster(),
    },
  );

  await logger.info("Slack relay bridge inbound handled message event", {
    area: "nango-webhook",
    workspaceId: input.workspaceId,
    slackChannelId,
    slackTs,
    status: outcome.status,
    ...(outcome.status === "skipped" ? { reason: outcome.reason } : {}),
  });
}

async function preserveSlackChannelNameForSparseLifecycleEvent(input: {
  client: {
    readFile?: (workspaceId: string, path: string) => Promise<{ content?: unknown } | string | null>;
  };
  workspaceId: string;
  model: string;
  record: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  if (input.model !== SLACK_CHANNEL_MODEL || readString(input.record, "name")) {
    return input.record;
  }
  const channelId = readString(input.record, "id");
  if (!channelId || !input.client.readFile) {
    return input.record;
  }
  const priorName = await readSlackChannelNameFromIndex(input.client, input.workspaceId, channelId);
  return priorName ? { ...input.record, name: priorName } : input.record;
}

async function withSlackMessageChannelName(input: {
  client: {
    readFile?: (workspaceId: string, path: string) => Promise<{ content?: unknown } | string | null>;
  };
  workspaceId: string;
  connectionId: string;
  providerConfigKey: string;
  record: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  if (readString(input.record, "channelName") || readString(input.record, "channel_name")) {
    return input.record;
  }
  const channelId = readString(input.record, "channel");
  if (!channelId || channelId.startsWith("D")) {
    return input.record;
  }
  const priorName = input.client.readFile
    ? await readSlackChannelNameFromIndex(input.client, input.workspaceId, channelId)
    : null;
  if (priorName) {
    return { ...input.record, channelName: priorName };
  }
  const resolvedName = await resolveSlackChannelName({
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    channelId,
  });
  if (resolvedName) {
    return { ...input.record, channelName: resolvedName };
  }

  await logger.warn("Slack relayfile forward missing channel name; skipped write to avoid bare Slack channel path", {
    area: "nango-webhook",
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    channelId,
    ts: readString(input.record, "ts") ?? undefined,
    threadTs: readString(input.record, "thread_ts") ?? undefined,
    eventType: readString(readRecord(input.record, "_webhook"), "eventType") ?? undefined,
  });
  return null;
}

async function readSlackChannelNameFromIndex(
  client: {
    readFile?: (workspaceId: string, path: string) => Promise<{ content?: unknown } | string | null>;
  },
  workspaceId: string,
  channelId: string,
): Promise<string | null> {
  try {
    const file = await client.readFile?.(workspaceId, slackChannelsIndexPath());
    const content =
      typeof file === "string"
        ? file
        : typeof file?.content === "string"
          ? file.content
          : "";
    if (!content) {
      return null;
    }
    const rows = JSON.parse(content) as unknown;
    if (!Array.isArray(rows)) {
      return null;
    }
    for (const row of rows) {
      if (!isObject(row)) continue;
      if (readString(row, "id") === channelId) {
        return readString(row, "title");
      }
    }
  } catch (error) {
    await logger.warn("Slack relayfile forward could not preserve prior channel name", {
      area: "nango-webhook",
      workspaceId,
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

export async function forwardToSage(envelope: NangoWebhookEnvelope): Promise<void> {
  ensureSlackBootstrapDefaultConsumer();

  const outbound = {
    ...envelope,
    from: "slack",
  };

  // Sage identifies Slack forwards by `from === "slack"` and expects the
  // original Nango envelope shape. Keep those top-level fields while adding the
  // normalized registry fields used by fanout consumers.
  const event = {
    ...outbound,
    provider: "slack",
    eventType: "forward",
    payload: isObject(outbound.payload) ? outbound.payload : {},
  } satisfies NormalizedWebhook & NangoWebhookEnvelope;

  await fireWebhookFanout("slack", event);
}

function ensureSlackBootstrapDefaultConsumer(): void {
  if (webhookConsumerRegistry.list("slack").length > 0) {
    return;
  }

  webhookConsumerRegistry.register({
    id: "sage-bootstrap-default",
    provider: "slack",
    kind: "http",
    url: `${getSageWebhookBaseUrl()}/api/webhooks/slack`,
  });
}

async function fireWebhookFanout(
  provider: WebhookProvider,
  event: NormalizedWebhook,
  options: { excludeRelayfilePrimary?: boolean } = {},
): Promise<void> {
  try {
    if (options.excludeRelayfilePrimary) {
      await webhookConsumerRegistry.fanoutExcept(provider, event, [
        RELAYFILE_PRIMARY_CONSUMER_ID,
      ]);
      return;
    }

    await webhookConsumerRegistry.fanout(provider, event);
  } catch (error) {
    await logger.error("Webhook fanout dispatch failed", {
      area: "webhook-fanout",
      provider,
      eventType: event.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleGitHubForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("GitHub forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const forwarded = unwrapGitHubForwardPayload(envelope.payload);
  const installationId = readGitHubInstallationId(forwarded.payload);
  let integration = await findWorkspaceIntegrationByConnection("github", connectionId);
  if (!integration && installationId) {
    const byInstallation = await findAllWorkspaceIntegrationsByInstallation(
      "github",
      installationId,
    );
    if (byInstallation.length > 1) {
      await logger.warn(
        "GitHub forward webhook installation fallback is ambiguous: multiple workspaces share the installation",
        {
          area: "nango-webhook",
          provider: envelope.from,
          connectionId,
          installationId,
          matchingWorkspaceIds: byInstallation.map((row) => row.workspaceId),
          providerConfigKey: envelope.providerConfigKey || undefined,
        },
      );
    }
    integration = byInstallation[0] ?? null;
  }
  if (!integration) {
    await logger.warn("GitHub forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      installationId: installationId ?? undefined,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  if (!forwarded.payload) {
    await logger.warn("GitHub forward webhook payload was not an object", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }

  await indexGithubInstallationBestEffort({
    workspaceId: integration.workspaceId,
    installationId,
    payload: forwarded.payload,
    connectionId,
    providerConfigKey: envelope.providerConfigKey || integration.providerConfigKey,
  });

  const headers = new Headers(forwarded.headers);
  const githubFanout = integrationFanoutRegistry.get<GitHubNormalizedWebhook>("github");
  const normalized = githubFanout.normalizeWebhook({
    headers,
    payload: forwarded.payload,
    connectionId,
  });
  if (!normalized) {
    await logger.error("GitHub forward webhook normalization returned no record without audit support", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      deliveryId: forwarded.deliveryId ?? undefined,
    });
    throw new Error("GitHub fanout normalization suppression requires an event-delivery audit row.");
  }
  if (!githubFanout.shouldWrite(normalized)) {
    await logger.error("GitHub forward webhook fanout suppressed without audit support", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      eventType: normalized.eventType,
      deliveryId: forwarded.deliveryId ?? undefined,
    });
    throw new Error("GitHub fanout suppression requires an event-delivery audit row.");
  }
  const client = createGitHubRelayfileClient(integration.workspaceId);
  const path = githubFanout.pathFor(normalized);
  const data = buildGitHubWebhookFileData(normalized);
  const integrationWatchPaths = githubIntegrationWatchPaths({
    eventType: normalized.eventType,
    path,
    payload: normalized.payload,
  });
  const ingestEnvelope = buildGitHubWebhookIngestData(normalized);
  const headersForIngest = simplifyGitHubHeaders(headers);
  const timestamp = new Date().toISOString();

  const fanoutEvent = {
    ...normalized,
    provider: "github",
    connectionId,
    workspaceId: integration.workspaceId,
    path,
    data,
    deliveryId: forwarded.deliveryId,
    headers: headersForIngest,
    timestamp,
  } satisfies NormalizedWebhook;

  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: "github",
    eventType: normalized.eventType,
    connectionId,
    deliveryId: forwarded.deliveryId,
    paths: integrationWatchPaths,
    // Delivery payload only — the relayfile-stored record (ingest below)
    // stays unenriched so meta.json keeps its canonical unwrapped shape.
    payload: enrichGitHubWatchPayload(data, normalized),
  });
  const recordWriterTarget = getGitHubWebhookRecordWriterTarget(normalized);
  const ingestPromise = recordWriterTarget
    ? writeBatchToRelayfileOrThrow(
        client,
        [
          ingestEnvelope.eventType === RELAYFILE_FILE_DELETED_EVENT
            ? {
                ...data,
                _nango_metadata: {
                  last_action: "deleted",
                  deleted_at: timestamp,
                },
              }
            : data,
        ],
        makeForwardSyncJob({
          workspaceId: integration.workspaceId,
          connectionId,
          providerConfigKey: envelope.providerConfigKey || "github-relay",
          provider: "github",
          syncName: recordWriterTarget.syncName,
          model: recordWriterTarget.model,
        }),
      )
    : client.ingestWebhook({
        workspaceId: integration.workspaceId,
        provider: "github",
        event_type: ingestEnvelope.eventType,
        path,
        data: ingestEnvelope.data,
        delivery_id: forwarded.deliveryId ?? undefined,
        headers: headersForIngest,
        timestamp,
      });
  let relayfilePrimaryWriteError: RelayfilePrimaryWriteError | null = null;
  try {
    await ingestPromise;
  } catch (error) {
    if (!(error instanceof RelayfilePrimaryWriteError)) {
      throw error;
    }
    relayfilePrimaryWriteError = error;
    await logger.error(
      "GitHub forward relayfile primary write failed; continuing webhook fanout",
      {
        area: "nango-webhook",
        workspaceId: integration.workspaceId,
        provider: "github",
        eventType: normalized.eventType,
        connectionId,
        deliveryId: forwarded.deliveryId ?? undefined,
        error: error.message,
      },
    );
  }
  await fireWebhookFanout("github", fanoutEvent, {
    excludeRelayfilePrimary: true,
  });
  if (relayfilePrimaryWriteError) {
    throw relayfilePrimaryWriteError;
  }

  // Side channel: a push to the repo's default branch triggers an incremental
  // clone-sync (git-pull semantics over the changed files). Failure is
  // non-fatal — the legacy ingest above is the durable record. See
  // packages/web/lib/integrations/github-incremental-sync-trigger.ts for the
  // dedupe + manifest semantics.
  //
  // NOTE: out of scope for v1: incremental sync for non-default branches
  // (PRs, feature branches). Out of scope: re-cloning when the org renames
  // the default branch — sage's anti-fab pipeline catches that on the
  // next 30-day staleness sweep.
  if (normalized.eventType === "push") {
    try {
      await maybeTriggerIncrementalSync({
        workspaceId: integration.workspaceId,
        connectionId,
        payload: forwarded.payload,
        deliveryId: forwarded.deliveryId,
        relayfile: client,
      });
    } catch (error) {
      await logger.warn("incremental_sync_trigger_failed", {
        area: "nango-webhook",
        workspaceId: integration.workspaceId,
        connectionId,
        deliveryId: forwarded.deliveryId ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

interface MaybeTriggerIncrementalSyncInput {
  workspaceId: string;
  connectionId: string;
  payload: Record<string, unknown>;
  deliveryId: string | null;
  relayfile: ReturnType<typeof createGitHubRelayfileClient>;
}

async function maybeTriggerIncrementalSync(
  input: MaybeTriggerIncrementalSyncInput,
): Promise<void> {
  const repository = readRecord(input.payload, "repository");
  const repoFullName = readString(repository, "full_name");
  const owner =
    readString(readRecord(repository, "owner"), "login") ??
    repoFullName?.split("/")[0] ??
    null;
  const repo =
    readString(repository, "name") ??
    repoFullName?.split("/")[1] ??
    null;
  const ref = readString(input.payload, "ref");
  const after = readString(input.payload, "after");
  // GitHub provides repository.default_branch on every Repository Webhook
  // event payload. We prefer this over the manifest's stored default
  // branch because the webhook is the canonical source for the current
  // default — but if it's missing we fall back to the manifest.
  const repoDefaultBranch = readString(repository, "default_branch");

  if (!owner || !repo || !ref || !after) {
    await logger.info("incremental_sync_skipped_missing_fields", {
      area: "incremental-sync",
      workspaceId: input.workspaceId,
      hasOwner: Boolean(owner),
      hasRepo: Boolean(repo),
      hasRef: Boolean(ref),
      hasAfter: Boolean(after),
      deliveryId: input.deliveryId ?? undefined,
    });
    return;
  }

  // GitHub push refs come through as "refs/heads/<branch>".
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  if (!branch) {
    // Tag pushes etc. — out of scope.
    await logger.info("incremental_sync_skipped_non_branch_ref", {
      area: "incremental-sync",
      workspaceId: input.workspaceId,
      ref,
      deliveryId: input.deliveryId ?? undefined,
    });
    return;
  }

  const manifest = await readPriorCloneManifest(
    input.relayfile,
    input.workspaceId,
    owner,
    repo,
  );
  if (!manifest) {
    // Repo was never cloned. The full-clone trigger lives elsewhere
    // (sage's bootstrap path / explicit POST /api/v1/github/clone/request)
    // — don't preempt it here.
    await logger.info("incremental_sync_skipped_no_manifest", {
      area: "incremental-sync",
      workspaceId: input.workspaceId,
      owner,
      repo,
      branch,
      deliveryId: input.deliveryId ?? undefined,
    });
    return;
  }

  const defaultBranch = repoDefaultBranch ?? manifest.defaultBranch;
  if (!defaultBranch || branch !== defaultBranch) {
    // Push to a non-default branch is out of scope for v1.
    await logger.info("incremental_sync_skipped_non_default_branch", {
      area: "incremental-sync",
      workspaceId: input.workspaceId,
      owner,
      repo,
      branch,
      defaultBranch: defaultBranch ?? undefined,
      deliveryId: input.deliveryId ?? undefined,
    });
    return;
  }

  if (manifest.headSha === after) {
    // The clone manifest already records this SHA — happens on webhook
    // redeliveries or when the executor finished writing right before this
    // event arrived.
    await logger.info("incremental_sync_skipped_same_sha", {
      area: "incremental-sync",
      workspaceId: input.workspaceId,
      owner,
      repo,
      headSha: after,
      deliveryId: input.deliveryId ?? undefined,
    });
    return;
  }

  await enqueueIncrementalCloneJob({
    workspaceId: input.workspaceId,
    owner,
    repo,
    ref: branch,
    connectionId: input.connectionId,
    baseSha: manifest.headSha,
    deliveryId: input.deliveryId,
  });
}

// Direct ingest: Notion's webhooks update Nango records via the sync's
// `onWebhook` handler, but Nango does NOT fire a `sync` webhook for those
// incremental updates (sync webhooks only fire after a full `exec` cycle).
// Without this handler, webhook-driven Notion edits stay in Nango records
// and never reach workspace fs — the cortical-demo
// `onWrite('/notion/pages/*/content.md')` trigger then never fires.
//
// We mirror Linear's forward path: parse the webhook, pull the freshest
// page from Notion via Nango proxy, and write to workspace fs directly via
// the same record-writer the sync-worker uses. No sync queue, no Nango
// records round-trip — just one webhook → one or two file writes.
//
// Why two files: the merged `fetch-pages` sync emits both NotionPage
// (metadata json) and NotionPageContent (markdown body), and the
// orchestrator's `isCallTranscript` reads the metadata json to filter on
// parent — so a brand-new page needs both files materialized for the
// trigger to fire.
//
// Schema parity: the records emitted here use `buildNotionPageRecord` /
// `buildNotionContentRecord` from `@cloud/core/sync/notion-record-shapes.js`,
// the same helpers the Nango sync imports via the
// `nango-integrations/notion-relay/shared/notion-record-shapes.ts` mirror.
// Both paths therefore emit byte-identical record shapes.
const NOTION_PAGE_DELETE_EVENT = "page.deleted";
const NOTION_MARKDOWN_API_VERSION = "2026-03-11";
const NOTION_SYNC_NAME = "fetch-pages";
const NOTION_PROVIDER = "notion";

const JIRA_PROVIDER = "jira";
const JIRA_ISSUES_SYNC_NAME = "fetch-issues";
const JIRA_PROJECTS_SYNC_NAME = "fetch-projects";
const JIRA_ISSUE_MODEL = "JiraIssue";
const JIRA_PROJECT_MODEL = "JiraProject";

const CONFLUENCE_PROVIDER = "confluence";
const CONFLUENCE_PAGES_SYNC_NAME = "fetch-pages";
const CONFLUENCE_SPACES_SYNC_NAME = "fetch-spaces";
const CONFLUENCE_PAGE_MODEL = "ConfluencePage";
const CONFLUENCE_SPACE_MODEL = "ConfluenceSpace";
// Webhook redelivery window. Notion retries forward webhooks on 5xx (and on
// our own ingest failures). Within this window we treat repeats with the
// same delivery_id (or `entity.id + last_edited_time` fallback) as no-ops.
// Five minutes covers Notion's documented retry pattern (a few retries with
// exponential backoff over ~minutes) without holding state long enough to
// suppress legitimate re-ingests after a real outage.
const NOTION_DEDUPE_TTL_MS = 5 * 60 * 1000;
const NOTION_DEDUPE_MAX_ENTRIES = 1024;
const HUBSPOT_DEDUPE_TTL_MS = 5 * 60 * 1000;
const HUBSPOT_DEDUPE_MAX_ENTRIES = 1024;

interface NotionWebhookEnvelopePayload {
  id?: string;
  // Notion includes `timestamp` on every webhook envelope (ISO-8601 of the
  // event emission). Used as a fallback dedupe component when neither
  // `payload.id` nor `data.last_edited_time` is present — without it, two
  // distinct edits to the same page within the dedupe window would collapse
  // into one suppressed delivery (Codex P2 on PR #486).
  timestamp?: string;
  type?: string;
  entity?: { id?: string; type?: string };
  data?: { last_edited_time?: string };
}

interface NotionApiPage {
  id?: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
  parent?: Record<string, unknown>;
  archived?: boolean;
  in_trash?: boolean;
}

// In-memory dedupe ring. Lambda re-uses warm containers across invocations,
// so this catches the common redelivery-within-seconds pattern. A cold start
// resets state, but at most one duplicate slips through after that — which
// is harmless because the contentHash short-circuit below also catches
// idempotent re-writes (gap 4 / gap 5 belt-and-suspenders).
const recentNotionDeliveries = new Map<string, number>();
const recentHubSpotDeliveries = new Map<string, number>();

function claimRecentDelivery(
  deliveries: Map<string, number>,
  key: string,
  ttlMs: number,
  maxEntries: number,
): boolean {
  const now = Date.now();
  for (const [storedKey, storedAt] of deliveries) {
    if (now - storedAt > ttlMs) {
      deliveries.delete(storedKey);
    }
  }
  if (deliveries.has(key)) {
    return false;
  }
  deliveries.set(key, now);
  if (deliveries.size > maxEntries) {
    // Drop the oldest insertion order entry. Map preserves insertion order.
    const oldestKey = deliveries.keys().next().value;
    if (oldestKey !== undefined) {
      deliveries.delete(oldestKey);
    }
  }
  return true;
}

function claimNotionDelivery(key: string): boolean {
  return claimRecentDelivery(
    recentNotionDeliveries,
    key,
    NOTION_DEDUPE_TTL_MS,
    NOTION_DEDUPE_MAX_ENTRIES,
  );
}

function claimHubSpotDelivery(key: string): boolean {
  return claimRecentDelivery(
    recentHubSpotDeliveries,
    key,
    HUBSPOT_DEDUPE_TTL_MS,
    HUBSPOT_DEDUPE_MAX_ENTRIES,
  );
}

// Release a claim. Called when ingest fails after the claim was taken so
// that a Notion/Nango redelivery (which is the standard recovery path for
// 5xx responses) can re-attempt the same key. Without this, an exception
// after the claim leaves the key in the dedupe map for the full TTL — any
// retry within five minutes is silently suppressed and the update is lost
// until the next 12h sync (Codex P2 on PR #486).
function releaseNotionDelivery(key: string): void {
  recentNotionDeliveries.delete(key);
}

function releaseHubSpotDelivery(key: string): void {
  recentHubSpotDeliveries.delete(key);
}

// Test seam — never call from production code. Resets the in-memory dedupe
// ring so each test case starts from a clean slate.
export function __resetNotionForwardDedupeForTests(): void {
  recentNotionDeliveries.clear();
  cachedNangoClient = null;
}

export function __resetHubSpotForwardDedupeForTests(): void {
  recentHubSpotDeliveries.clear();
  cachedNangoClient = null;
}

// Cached Nango client — instantiated once per Lambda warm container. The
// `@nangohq/node` SDK creates HTTPS agents and small bookkeeping internally,
// so re-instantiating per webhook (the previous behavior) was paying that
// cost on the hot path. The secret key is stable across invocations, so a
// single instance is correct.
let cachedNangoClient: NangoProxyClient | null = null;

interface NangoProxyClient {
  proxy(input: {
    method: string;
    endpoint: string;
    connectionId: string;
    providerConfigKey: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    data?: unknown;
    retries?: number;
  }): Promise<{ data?: unknown }>;
}

function getNangoProxyClient(): NangoProxyClient {
  if (cachedNangoClient) {
    return cachedNangoClient;
  }
  const secretKey = getNangoSecretKey();
  if (!secretKey) {
    throw new Error("NANGO_SECRET_KEY is not configured");
  }
  const host = process.env.NANGO_HOST?.trim() || "https://api.nango.dev";
  cachedNangoClient = new Nango({ secretKey, host }) as unknown as NangoProxyClient;
  return cachedNangoClient;
}

async function fetchNotionPageViaNango(input: {
  pageId: string;
  connectionId: string;
  providerConfigKey: string;
}): Promise<NotionApiPage | null> {
  const nango = getNangoProxyClient();
  try {
    const response = await nango.proxy({
      method: "GET",
      endpoint: `/v1/pages/${encodeURIComponent(input.pageId)}`,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      retries: 3,
    });
    return (response?.data as NotionApiPage | undefined) ?? null;
  } catch (error) {
    await logger.warn("Notion forward webhook page fetch failed", {
      area: "nango-webhook",
      pageId: input.pageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function fetchNotionMarkdownViaNango(input: {
  pageId: string;
  connectionId: string;
  providerConfigKey: string;
}): Promise<string | null> {
  const nango = getNangoProxyClient();
  try {
    const response = await nango.proxy({
      method: "GET",
      endpoint: `/v1/pages/${encodeURIComponent(input.pageId)}/markdown`,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      headers: { "Notion-Version": NOTION_MARKDOWN_API_VERSION },
      retries: 3,
    });
    const data = response?.data as { markdown?: unknown } | undefined;
    return typeof data?.markdown === "string" ? (data.markdown as string) : null;
  } catch (error) {
    await logger.warn("Notion forward webhook markdown fetch failed", {
      area: "nango-webhook",
      pageId: input.pageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Look up a Notion database's title via the proxy. Used to enrich
// `NotionPageRecord.database_title` so adapter-notion's by-database alias
// gate passes for webhook-driven page updates. Without this, a webhook
// update on a database-rooted page would re-write the canonical record
// without `database_title`, and adapter-notion's prior-state diff would
// interpret the missing field as "no longer a database page" and DELETE
// the existing `/notion/pages/by-database/<db>/<page>.json` alias.
async function fetchNotionDatabaseTitleViaNango(input: {
  databaseId: string;
  connectionId: string;
  providerConfigKey: string;
}): Promise<string> {
  const nango = getNangoProxyClient();
  try {
    const response = await nango.proxy({
      method: "GET",
      endpoint: `/v1/databases/${encodeURIComponent(input.databaseId)}`,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      retries: 3,
    });
    const data = response?.data as { title?: unknown } | undefined;
    if (!Array.isArray(data?.title)) return "";
    return (data.title as unknown[])
      .map((fragment) => {
        if (
          fragment !== null &&
          typeof fragment === "object" &&
          !Array.isArray(fragment) &&
          typeof (fragment as Record<string, unknown>)["plain_text"] === "string"
        ) {
          return (fragment as Record<string, unknown>)["plain_text"] as string;
        }
        return "";
      })
      .join("")
      .trim();
  } catch (error) {
    await logger.warn("Notion forward webhook database title lookup failed", {
      area: "nango-webhook",
      databaseId: input.databaseId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

type HubSpotForwardObjectConfig = (typeof HUBSPOT_FORWARD_OBJECTS)[number];

function hashForwardPayload(payload: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = String(payload);
  }
  return createHash("sha256").update(serialized ?? "", "utf8").digest("hex");
}

function parseHubSpotRawObject(
  data: unknown,
  fallbackId: string,
): HubSpotRawObject | null {
  if (!isObject(data)) return null;
  const id = readString(data, "id") ?? fallbackId;
  if (!id) return null;
  return {
    ...(data as Record<string, unknown>),
    id,
  } as HubSpotRawObject;
}

function makeHubSpotProxyGetClient(input: {
  connectionId: string;
  providerConfigKey: string;
}): HubSpotAssociationClient {
  const nango = getNangoProxyClient();
  return {
    async get(config: Parameters<HubSpotAssociationClient["get"]>[0]) {
      const response = await nango.proxy({
        method: "GET",
        endpoint: config.endpoint,
        connectionId: input.connectionId,
        providerConfigKey: input.providerConfigKey,
        params: config.params,
        retries: config.retries,
      });
      return { data: response.data };
    },
  };
}

async function fetchHubSpotObjectViaNango(input: {
  object: HubSpotForwardObjectConfig;
  objectId: string;
  connectionId: string;
  providerConfigKey: string;
}): Promise<HubSpotRawObject | null> {
  const nango = getNangoProxyClient();
  const params: Record<string, string> = {
    properties: input.object.properties,
  };
  if (input.object.model === HUBSPOT_DEAL_MODEL) {
    params.associations = "companies,contacts";
  }

  try {
    const response = await nango.proxy({
      method: "GET",
      endpoint: `/crm/v3/objects/${input.object.plural}/${encodeURIComponent(input.objectId)}`,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      params,
      retries: 3,
    });
    return parseHubSpotRawObject(response?.data, input.objectId);
  } catch (error) {
    await logger.warn("HubSpot forward webhook object fetch failed", {
      area: "nango-webhook",
      objectType: input.object.plural,
      objectId: input.objectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function buildHubSpotForwardRecord(input: {
  object: HubSpotForwardObjectConfig;
  raw: HubSpotRawObject;
  associationClient: HubSpotAssociationClient;
}): Promise<Record<string, unknown>> {
  switch (input.object.model) {
    case HUBSPOT_CONTACT_MODEL:
      return { ...buildHubSpotContactRecord(input.raw) };
    case HUBSPOT_COMPANY_MODEL:
      return { ...buildHubSpotCompanyRecord(input.raw) };
    case HUBSPOT_DEAL_MODEL:
      return { ...(await buildHubSpotDealRecord(input.raw, input.associationClient)) };
    case HUBSPOT_TICKET_MODEL:
      return { ...buildHubSpotTicketRecord(input.raw) };
  }
  throw new Error("Unsupported HubSpot forward model");
}

function hubSpotObjectPath(
  object: HubSpotForwardObjectConfig,
  objectId: string,
): string {
  return `/hubspot/${object.plural}/${encodeURIComponent(objectId)}.json`;
}

// Best-effort read of the existing NotionPageContent file's hash. Used to
// short-circuit a write when the body is unchanged (gap 4: concurrent-write
// race vs the 12h sync exec). Returns null on any failure — missing file,
// JSON parse error, network error — and the caller falls through to a
// normal write. We chose contentHash dedupe over `baseRevision` retry
// because:
//
//   1. NotionPageContent already carries `contentHash` in its schema, so
//      this is just reading what the writer already produces.
//   2. The webhook hot path issues at most two writes; one extra read per
//      write is cheap.
//   3. The sync's writes and the webhook's writes share the same hashing
//      function, so a sync run that landed milliseconds before us produces
//      the same hash for the same body — no retry loop required.
async function readExistingContentHash(input: {
  client: { readFile: (workspaceId: string, path: string) => Promise<{ content?: unknown } | null> };
  workspaceId: string;
  pageId: string;
}): Promise<string | null> {
  try {
    const file = await input.client.readFile(
      input.workspaceId,
      `/notion/pages/${input.pageId}/content.md`,
    );
    // The content file is plain markdown — recompute its hash with the same
    // function the writer uses. We can't just read the metadata.json's hash
    // because the metadata file doesn't carry one.
    if (!file || typeof (file as { content?: unknown }).content !== "string") {
      return null;
    }
    const content = (file as { content: string }).content;
    return createHash("sha256").update(content, "utf8").digest("hex");
  } catch {
    return null;
  }
}

async function readExistingPageRecordHash(input: {
  client: { readFile: (workspaceId: string, path: string) => Promise<{ content?: unknown } | null> };
  workspaceId: string;
  pageId: string;
}): Promise<string | null> {
  try {
    const file = await input.client.readFile(
      input.workspaceId,
      `/notion/pages/${input.pageId}.json`,
    );
    if (!file || typeof (file as { content?: unknown }).content !== "string") {
      return null;
    }
    const content = (file as { content: string }).content;
    return createHash("sha256").update(content, "utf8").digest("hex");
  } catch {
    return null;
  }
}

function hashNotionPageRecord(record: NotionPageRecord): string {
  return createHash("sha256")
    .update(JSON.stringify(record), "utf8")
    .digest("hex");
}

function buildNotionDeletePair(input: {
  workspaceId: string;
  connectionId: string;
  providerConfigKey: string;
  pageId: string;
  deletedAt?: string;
}): {
  pageJob: ReturnType<typeof createWebhookSyncJob>;
  contentJob: ReturnType<typeof createWebhookSyncJob>;
  record: Record<string, unknown>;
} {
  return {
    pageJob: createWebhookSyncJob({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      provider: NOTION_PROVIDER,
      syncName: NOTION_SYNC_NAME,
      model: NOTION_PAGE_MODEL,
    }),
    contentJob: createWebhookSyncJob({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      provider: NOTION_PROVIDER,
      syncName: NOTION_SYNC_NAME,
      model: NOTION_PAGE_CONTENT_MODEL,
    }),
    record: buildDeletionRecord(input.pageId, { deletedAt: input.deletedAt }),
  };
}

function collectHubSpotForwardEventTypes(payload: unknown): string[] {
  const rawEvents = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload["events"])
      ? payload["events"]
      : isObject(payload) && Array.isArray(payload["body"])
        ? payload["body"]
        : isObject(payload) && isObject(payload["body"]) && Array.isArray(payload["body"]["events"])
          ? payload["body"]["events"]
          : [payload];
  const types = new Set<string>();
  for (const rawEvent of rawEvents) {
    if (!isObject(rawEvent)) continue;
    const type = readString(rawEvent, "subscriptionType");
    if (type) {
      types.add(type);
    }
  }
  return [...types];
}

async function handleHubSpotForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("HubSpot forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(
    HUBSPOT_PROVIDER,
    connectionId,
  );
  if (!integration) {
    await logger.warn("HubSpot forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const deliveryKey = `${connectionId}:${envelope.providerConfigKey || integration.providerConfigKey || ""}:${hashForwardPayload(envelope.payload)}`;
  if (!claimHubSpotDelivery(deliveryKey)) {
    await logger.info("HubSpot forward webhook redelivery suppressed", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(HUBSPOT_PROVIDER);
  const client = createGitHubRelayfileClient(integration.workspaceId);

  try {
    await ingestHubSpotForwardEvent({
      payload: envelope.payload,
      eventTypes: collectHubSpotForwardEventTypes(envelope.payload),
      integration,
      connectionId,
      providerConfigKey,
      client,
    });
  } catch (error) {
    releaseHubSpotDelivery(deliveryKey);
    throw error;
  }
}

async function ingestHubSpotForwardEvent(input: {
  payload: unknown;
  eventTypes: string[];
  integration: { workspaceId: string };
  connectionId: string;
  providerConfigKey: string;
  client: ReturnType<typeof createGitHubRelayfileClient>;
}): Promise<void> {
  const { payload, eventTypes, integration, connectionId, providerConfigKey, client } = input;
  const eventType = eventTypes.length === 1 ? eventTypes[0] : "hubspot.forward";
  const associationClient = makeHubSpotProxyGetClient({ connectionId, providerConfigKey });
  let changed = 0;

  for (const object of HUBSPOT_FORWARD_OBJECTS) {
    const { upsertIds, deleteIds } = extractHubspotWebhookObjectIds(
      payload,
      object.objectTypeId,
      { includeAssociationChange: object.includeAssociationChange },
    );
    if (upsertIds.length === 0 && deleteIds.length === 0) {
      continue;
    }

    const job = createWebhookSyncJob({
      workspaceId: integration.workspaceId,
      connectionId,
      providerConfigKey,
      provider: HUBSPOT_PROVIDER,
      syncName: object.syncName,
      model: object.model,
    });

    if (deleteIds.length > 0) {
      const records = deleteIds.map((id: string) =>
        buildDeletionRecord(id, { deletedAt: new Date().toISOString() }),
      );
      await enqueueIntegrationWatchEvent({
        workspaceId: integration.workspaceId,
        provider: HUBSPOT_PROVIDER,
        eventType,
        connectionId,
        paths: deleteIds.map((id: string) => hubSpotObjectPath(object, id)),
        payload: records,
      });
      await writeBatchToRelayfileOrThrow(client, records, job);
      changed += records.length;
    }

    const records: Record<string, unknown>[] = [];
    const paths = upsertIds.map((id: string) => hubSpotObjectPath(object, id));
    for (const id of upsertIds) {
      const raw = await fetchHubSpotObjectViaNango({
        object,
        objectId: id,
        connectionId,
        providerConfigKey,
      });
      if (!raw) {
        continue;
      }
      records.push(await buildHubSpotForwardRecord({ object, raw, associationClient }));
    }

    if (records.length > 0) {
      await enqueueIntegrationWatchEvent({
        workspaceId: integration.workspaceId,
        provider: HUBSPOT_PROVIDER,
        eventType,
        connectionId,
        paths,
        payload: records.length === 1 ? records[0] : records,
      });
      await writeBatchToRelayfileOrThrow(client, records, job);
      changed += records.length;
    }
  }

  await logger.info("HubSpot forward webhook ingested directly", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    eventTypes,
    changed,
  });
}

async function handleNotionForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Notion forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection("notion", connectionId);
  if (!integration) {
    await logger.warn("Notion forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const payload =
    isObject(envelope.payload) ? (envelope.payload as NotionWebhookEnvelopePayload) : ({} as NotionWebhookEnvelopePayload);
  const eventType = typeof payload.type === "string" ? payload.type : "";
  const pageId = typeof payload.entity?.id === "string" ? payload.entity.id : "";
  const entityType = typeof payload.entity?.type === "string" ? payload.entity.type : "";
  const deliveryId = typeof payload.id === "string" ? payload.id : "";
  const envelopeTimestamp = typeof payload.timestamp === "string" ? payload.timestamp : "";
  const lastEditedHint =
    isObject(payload.data) && typeof payload.data["last_edited_time"] === "string"
      ? (payload.data["last_edited_time"] as string)
      : "";

  if (!pageId) {
    await logger.warn("Notion forward webhook missing entity.id", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      eventType,
    });
    return;
  }

  // Defensive: only react to page events. If the Nango integration's webhook
  // routing is misconfigured, database/comment/block events could land here.
  if (entityType && entityType !== "page") {
    return;
  }

  // Idempotency: Notion retries forward webhooks on 5xx. Build a key that's
  // unique enough to identify a single delivery without collapsing distinct
  // edits.
  // - First choice: `payload.id` (Notion's per-delivery uuid — globally
  //   unique, always preferred when present).
  // - Fallback: combine entity id + event type + the freshest unique-ish
  //   hints we have (`data.last_edited_time` and the envelope's `timestamp`).
  //   Including BOTH avoids the failure mode where a payload missing
  //   `last_edited_time` collapses every same-(pageId,eventType) edit
  //   within the TTL into one suppressed delivery (Codex P2 on PR #486).
  // - If even the fallback components are all empty, we genuinely can't
  //   distinguish redeliveries from new edits — better to over-process than
  //   to lose updates, so we skip dedupe and let the contentHash short-circuit
  //   in the write path absorb any actual redelivery cost.
  let dedupeKey: string | null;
  if (deliveryId) {
    dedupeKey = `did:${deliveryId}`;
  } else if (lastEditedHint || envelopeTimestamp) {
    dedupeKey = `ent:${pageId}:${eventType}:${lastEditedHint}:${envelopeTimestamp}`;
  } else {
    dedupeKey = null;
  }

  if (dedupeKey !== null && !claimNotionDelivery(dedupeKey)) {
    await logger.info("Notion forward webhook redelivery suppressed", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      pageId,
      eventType,
      deliveryId: deliveryId || undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey || integration.providerConfigKey || getProviderConfigKey("notion");
  const client = createGitHubRelayfileClient(integration.workspaceId);

  // Wrap the durable work so that any failure releases the dedupe claim —
  // otherwise a transient error that triggers a Notion/Nango redelivery
  // would be silently suppressed for the full TTL, and the update would be
  // lost until the next 12h sync (Codex P2 on PR #486).
  try {
    await ingestNotionForwardEvent({
      eventType,
      pageId,
      eventTimestamp: envelopeTimestamp || lastEditedHint || undefined,
      integration,
      connectionId,
      providerConfigKey,
      client,
    });
  } catch (error) {
    if (dedupeKey !== null) {
      releaseNotionDelivery(dedupeKey);
    }
    throw error;
  }
}

async function ingestNotionForwardEvent(input: {
  eventType: string;
  pageId: string;
  eventTimestamp?: string;
  integration: { workspaceId: string };
  connectionId: string;
  providerConfigKey: string;
  client: ReturnType<typeof createGitHubRelayfileClient>;
}): Promise<void> {
  const { eventType, pageId, eventTimestamp, integration, connectionId, providerConfigKey, client } = input;

  // Hard-delete event: emit deletion records for both models. Uses
  // `buildDeletionRecord` so the synthetic `_nango_metadata` envelope
  // construction stays in record-writer (gap 3 — was previously hand-built
  // here, coupling this handler to record-writer's internal
  // `isDeletedNangoRecord` discriminator).
  if (eventType === NOTION_PAGE_DELETE_EVENT) {
    const { pageJob, contentJob, record } = buildNotionDeletePair({
      workspaceId: integration.workspaceId,
      connectionId,
      providerConfigKey,
      pageId,
      deletedAt: eventTimestamp,
    });
    await enqueueIntegrationWatchEvent({
      workspaceId: integration.workspaceId,
      provider: NOTION_PROVIDER,
      eventType,
      connectionId,
      deliveryId: buildInlineWatchDeliveryId({
        workspaceId: integration.workspaceId,
        provider: NOTION_PROVIDER,
        eventType,
        connectionId,
        paths: [`/notion/pages/${pageId}.json`],
        payload: record,
      }),
      paths: [`/notion/pages/${pageId}.json`],
      payload: record,
    });
    const pageResult = await writeBatchToRelayfileOrThrow(client, [record], pageJob);
    if (pageResult.deleted === 0 && pageResult.written === 0) {
      await logger.info("Notion forward webhook delete skipped stale page tombstone", {
        area: "nango-webhook",
        workspaceId: integration.workspaceId,
        connectionId,
        pageId,
      });
      return;
    }
    await writeBatchToRelayfileOrThrow(client, [record], contentJob);
    await logger.info("Notion forward webhook removed page from workspace fs", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      pageId,
    });
    return;
  }

  // Non-delete: the Notion API is the source of truth. Page fetch happens
  // first because we need its `archived` / `in_trash` flag to decide between
  // the soft-delete branch and the write branch. After that the markdown
  // fetch parallelizes with whatever else we need (gap 8).
  const page = await fetchNotionPageViaNango({ pageId, connectionId, providerConfigKey });
  if (!page) {
    await logger.warn("Notion forward webhook could not load page; skipping write", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      pageId,
      eventType,
    });
    return;
  }

  // Skip the blocks/preview fetch entirely. `content_preview` is not read by
  // anything in the production cloud (only the fetch-pages sync writes it,
  // and only test fixtures ever read it). Leaving it as "" here keeps the
  // schema aligned and lets the scheduled sync backfill the field. This drops
  // one of the three serial round
  // trips on the hot path (gap 8).
  //
  // For database-rooted pages we ALSO need to enrich `database_title` so
  // adapter-notion emits the `/notion/pages/by-database/` alias. If the
  // page parent is a database, look up the title via Nango proxy; do this
  // sequentially before the parallel-fetch block so the record we hand to
  // `buildNotionPageRecord` already carries the field. Skipping this
  // lookup (and writing the record with `database_title` undefined) would
  // cause adapter-notion's prior-state diff to delete an existing
  // by-database alias for unchanged pages.
  const parentForLookup = extractNotionParentInfo(page.parent ?? undefined);
  let databaseTitleForRecord = "";
  if (parentForLookup.parent_type === "database" && parentForLookup.parent_id) {
    databaseTitleForRecord = await fetchNotionDatabaseTitleViaNango({
      databaseId: parentForLookup.parent_id,
      connectionId,
      providerConfigKey,
    });
  }

  // Run the markdown fetch in parallel with the existing-hash reads so the
  // hot path is one network round-trip + one or two cheap relayfile reads.
  const pageRecord = buildNotionPageRecord({
    id: page.id ?? pageId,
    url: page.url ?? null,
    last_edited_time: page.last_edited_time ?? null,
    properties: page.properties ?? null,
    parent: page.parent ?? null,
    content_preview: "",
    database_title: databaseTitleForRecord || undefined,
    archived: page.archived === true,
    in_trash: page.in_trash === true,
  });
  const newPageHash = hashNotionPageRecord(pageRecord);
  const watchDeliveryId = buildInlineWatchDeliveryId({
    workspaceId: integration.workspaceId,
    provider: NOTION_PROVIDER,
    eventType,
    connectionId,
    paths: [`/notion/pages/${pageId}.json`],
    payload: pageRecord,
  });

  const pageJob = createWebhookSyncJob({
    workspaceId: integration.workspaceId,
    connectionId,
    providerConfigKey,
    provider: NOTION_PROVIDER,
    syncName: NOTION_SYNC_NAME,
    model: NOTION_PAGE_MODEL,
  });

  if (page.archived === true || page.in_trash === true) {
    await enqueueIntegrationWatchEvent({
      workspaceId: integration.workspaceId,
      provider: NOTION_PROVIDER,
      eventType,
      connectionId,
      deliveryId: watchDeliveryId,
      paths: [`/notion/pages/${pageId}.json`],
      payload: pageRecord,
    });
    const existingPageHash = await readExistingPageRecordHash({
      client: client as unknown as { readFile: (workspaceId: string, path: string) => Promise<{ content?: unknown } | null> },
      workspaceId: integration.workspaceId,
      pageId,
    }).catch(() => null);

    let wrotePage = false;
    if (existingPageHash === null || existingPageHash !== newPageHash) {
      await writeBatchToRelayfileOrThrow(client, [pageRecord], pageJob);
      wrotePage = true;
    }

    await logger.info("Notion forward webhook preserved archived page metadata", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      pageId,
      eventType,
      wrotePage,
    });
    return;
  }

  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: NOTION_PROVIDER,
    eventType,
    connectionId,
    deliveryId: watchDeliveryId,
    paths: [`/notion/pages/${pageId}.json`],
    payload: pageRecord,
  });

  const [markdownResult, existingPageHashResult, existingContentHashResult] = await Promise.allSettled([
    fetchNotionMarkdownViaNango({ pageId, connectionId, providerConfigKey }),
    readExistingPageRecordHash({
      client: client as unknown as { readFile: (workspaceId: string, path: string) => Promise<{ content?: unknown } | null> },
      workspaceId: integration.workspaceId,
      pageId,
    }),
    readExistingContentHash({
      client: client as unknown as { readFile: (workspaceId: string, path: string) => Promise<{ content?: unknown } | null> },
      workspaceId: integration.workspaceId,
      pageId,
    }),
  ]);
  const markdown =
    markdownResult.status === "fulfilled" ? markdownResult.value : null;
  const existingPageHash =
    existingPageHashResult.status === "fulfilled" ? existingPageHashResult.value : null;
  const existingContentHash =
    existingContentHashResult.status === "fulfilled" ? existingContentHashResult.value : null;

  let wrotePage = false;
  if (existingPageHash !== null && existingPageHash === newPageHash) {
    // No metadata diff vs what is already on disk — sync run may have just
    // landed identical content. Skip the write to avoid clobbering whatever
    // `baseRevision` the sync produced.
  } else {
    await writeBatchToRelayfileOrThrow(client, [pageRecord], pageJob);
    wrotePage = true;
  }

  let wroteContent = false;
  if (markdown !== null) {
    const newContentHash = createHash("sha256")
      .update(markdown, "utf8")
      .digest("hex");
    if (existingContentHash !== null && existingContentHash === newContentHash) {
      // Body unchanged — skip.
    } else {
      const contentRecord: NotionPageContentRecord = buildNotionContentRecord({
        pageId: pageRecord.id,
        markdown,
        contentHash: newContentHash,
        lastEditedTime: pageRecord.last_edited_time,
      });
      const contentJob = createWebhookSyncJob({
        workspaceId: integration.workspaceId,
        connectionId,
        providerConfigKey,
        provider: NOTION_PROVIDER,
        syncName: NOTION_SYNC_NAME,
        model: NOTION_PAGE_CONTENT_MODEL,
      });
      await writeBatchToRelayfileOrThrow(client, [contentRecord], contentJob);
      wroteContent = true;
    }
  }

  await logger.info("Notion forward webhook ingested directly", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    pageId,
    eventType,
    wrotePage,
    wroteContent,
  });
}

function linearForwardWatchPaths(
  normalized: LinearNormalizedWebhook,
  data: Record<string, unknown>,
): string[] {
  const humanReadable =
    readString(data, "identifier") ?? readString(data, "title") ?? undefined;
  const canonicalPath = computeLinearPath(
    normalized.objectType,
    normalized.objectId,
    humanReadable,
  );
  const paths = new Set<string>([canonicalPath]);

  if (normalized.objectType.trim().toLowerCase() === "issue") {
    const identifier = readString(data, "identifier");
    const state = isObject(data.state) ? data.state : null;
    const newStateName =
      readString(state, "name") ??
      readString(data, "state_name") ??
      null;
    if (identifier && newStateName) {
      try {
        paths.add(linearIssueByStatePath(newStateName, identifier));
      } catch {
        // slug error — skip alias path
      }
    }

    const webhookMeta = isObject(data._webhook) ? data._webhook : null;
    const previousData = isObject(webhookMeta?.previousData)
      ? (webhookMeta?.previousData as Record<string, unknown>)
      : null;
    const prevState = isObject(previousData?.state) ? (previousData?.state as Record<string, unknown>) : null;
    const oldStateName =
      readString(previousData, "state_name") ??
      readString(prevState, "name") ??
      null;
    const oldIdentifier = readString(previousData, "identifier") ?? identifier;
    if (oldIdentifier && oldStateName && oldStateName !== newStateName) {
      try {
        paths.add(linearIssueByStatePath(oldStateName, oldIdentifier));
      } catch {
        // slug error — skip old alias path
      }
    }
  }

  return [...paths];
}

async function handleLinearForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Linear forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection("linear", connectionId);
  if (!integration) {
    await logger.warn("Linear forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  if (!forwarded.payload) {
    await logger.warn("Linear forward webhook payload was not an object", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }

  const normalized = normalizeLinearWebhook(forwarded.payload, forwarded.headers);
  const linearAgentWebhookPath = linearAgentWebhookEventPath(
    normalized.eventType,
    normalized.objectId,
  );

  if (linearAgentWebhookPath && normalized.eventType.startsWith("AgentSessionEvent.")) {
    await tryDispatchLinearAgentWebhookWatch({
      workspaceId: integration.workspaceId,
      connectionId,
      deliveryId: forwarded.deliveryId,
      normalized,
    });
    return;
  }

  if (linearAgentWebhookPath && normalized.eventType === "OAuthApp.revoked") {
    await recordWorkspaceIntegrationDisconnect({
      workspaceId: integration.workspaceId,
      provider: "linear",
      connectionId,
      providerConfigKey: integration.providerConfigKey ?? envelope.providerConfigKey ?? null,
    });
    await deleteWorkspaceIntegration(
      integration.workspaceId,
      "linear",
      integration.name ?? null,
    );
    await tryDispatchLinearAgentWebhookWatch({
      workspaceId: integration.workspaceId,
      connectionId,
      deliveryId: forwarded.deliveryId,
      normalized,
    });
    await logger.info("Linear OAuth app revocation removed workspace integration", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }

  if (
    linearAgentWebhookPath &&
    (normalized.eventType.startsWith("AppUserNotification.") ||
      normalized.eventType.startsWith("PermissionChange."))
  ) {
    await tryDispatchLinearAgentWebhookWatch({
      workspaceId: integration.workspaceId,
      connectionId,
      deliveryId: forwarded.deliveryId,
      normalized,
    });
    await logger.info("Linear operational agent webhook acknowledged without Relayfile write", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      type: normalized.objectType,
      action: normalized.eventType.split(".").pop() ?? undefined,
    });
    return;
  }

  const client = createGitHubRelayfileClient(integration.workspaceId);
  const path = computeLinearPath(normalized.objectType, normalized.objectId);
  const fileEventType = isLinearForwardDeletionEvent(normalized)
    ? RELAYFILE_FILE_DELETED_EVENT
    : RELAYFILE_FILE_UPDATED_EVENT;
  const data = buildLinearForwardFileData(normalized);
  const timestamp = new Date().toISOString();

  if (
    fileEventType === RELAYFILE_FILE_UPDATED_EVENT &&
    !hasCompleteLinearForwardData(normalized.objectType, data)
  ) {
    await logger.info("Linear forward webhook skipped direct file write because payload is incomplete", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      objectType: normalized.objectType,
      objectId: normalized.objectId,
      eventType: normalized.eventType,
    });
    return;
  }

  const isLinearDeletion = fileEventType === RELAYFILE_FILE_DELETED_EVENT;
  const recordWriterTarget = getLinearWebhookRecordWriterTarget(normalized);
  const ingestPromise = recordWriterTarget
    ? writeBatchToRelayfileOrThrow(
        client,
        [
          isLinearDeletion
            ? {
                ...data,
                _nango_metadata: {
                  last_action: "deleted",
                  deleted_at: timestamp,
                },
              }
            : data,
        ],
        makeForwardSyncJob({
          workspaceId: integration.workspaceId,
          connectionId,
          providerConfigKey: envelope.providerConfigKey || "linear-relay",
          provider: "linear",
          syncName: recordWriterTarget.syncName,
          model: recordWriterTarget.model,
        }),
      )
    : client.ingestWebhook({
        workspaceId: integration.workspaceId,
        provider: "linear",
        event_type: fileEventType,
        path,
        data: isLinearDeletion
          ? data
          : {
              ...data,
              content: `${JSON.stringify(data, null, 2)}\n`,
              contentType: "application/json; charset=utf-8",
            },
        delivery_id: forwarded.deliveryId ?? undefined,
        headers: forwarded.headers,
        timestamp,
      });

  await ingestPromise;
  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: "linear",
    eventType: normalized.eventType,
    connectionId,
    deliveryId: forwarded.deliveryId,
    paths: linearForwardWatchPaths(normalized, data),
    payload: data,
  });
  await fireWebhookFanout(
    "linear",
    {
      ...normalized,
      provider: "linear",
      connectionId,
      workspaceId: integration.workspaceId,
      path,
      data,
      deliveryId: forwarded.deliveryId,
      headers: forwarded.headers,
      timestamp,
    },
    { excludeRelayfilePrimary: true },
  );
}

async function handleGitLabForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("GitLab forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection("gitlab", connectionId);
  if (!integration) {
    await logger.warn("GitLab forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  if (!forwarded.payload) {
    await logger.warn("GitLab forward webhook payload was not an object", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }

  const normalized = normalizeGitLabForwardPayload(forwarded.payload);
  if (!normalized) {
    await logger.info("GitLab forward webhook skipped — unsupported event shape", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      objectKind: readString(forwarded.payload, "object_kind") ?? undefined,
      eventType: readString(forwarded.payload, "event_type") ?? undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey(GITLAB_PROVIDER);
  const client = createGitHubRelayfileClient(integration.workspaceId);
  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: "gitlab",
    eventType: normalized.eventType,
    connectionId,
    deliveryId: forwarded.deliveryId,
    payload:
      normalized.records.length === 1
        ? normalized.records[0]
        : normalized.records,
  });
  await writeBatchToRelayfileOrThrow(
    client,
    normalized.records,
    makeForwardSyncJob({
      workspaceId: integration.workspaceId,
      connectionId,
      providerConfigKey,
      provider: GITLAB_PROVIDER,
      syncName: gitLabSyncNameForModel(normalized.model),
      model: normalized.model,
    }),
  );
  if (normalized.triggerSyncs?.length) {
    const result = await triggerNangoSyncs({
      providerConfigKey,
      connectionId,
      syncs: normalized.triggerSyncs,
      syncMode: "incremental",
    });
    if (!result.ok) {
      throw new Error(`Failed to trigger GitLab forward follow-up syncs: ${result.status}`);
    }
  }

  await fireWebhookFanout(
    "gitlab",
    {
      provider: "gitlab",
      connectionId,
      workspaceId: integration.workspaceId,
      eventType: normalized.eventType,
      payload: forwarded.payload,
      data:
        normalized.records.length === 0
          ? forwarded.payload
          : normalized.records.length === 1
            ? normalized.records[0]
            : normalized.records,
      deliveryId: forwarded.deliveryId,
      headers: forwarded.headers,
      timestamp: new Date().toISOString(),
    },
    { excludeRelayfilePrimary: true },
  );

  await logger.info("GitLab forward webhook ingested directly", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    model: normalized.model,
    eventType: normalized.eventType,
    records: normalized.records.length,
    deliveryId: forwarded.deliveryId ?? undefined,
  });
}

// Jira forward webhooks land here once `routeForwardEvent` has resolved the
// provider to "jira". The Atlassian webhook envelope carries an event-name
// string (e.g. `jira:issue_updated`, `project_created`, `comment_created`)
// plus the relevant entity inline (`issue`, `project`, `comment`). We extract
// that entity into the same record shape `writeJiraRecord` expects when the
// `fetch-issues` / `fetch-projects` sync produces it, then dispatch through
// `writeBatchToRelayfile` so the path-mapper and semantics stay in lockstep
// with the sync-worker. No Nango proxy fetch is needed because Jira embeds
// the full entity in the webhook payload (unlike Notion, whose webhooks are
// sparse and require a follow-up `pages/{id}` GET).
async function handleJiraForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Jira forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection("jira", connectionId);
  if (!integration) {
    await logger.warn("Jira forward webhook received with no matching workspace integration", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  if (!forwarded.payload) {
    await logger.warn("Jira forward webhook payload was not an object", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }

  const normalized = normalizeJiraForwardPayload(forwarded.payload);
  if (!normalized) {
    await logger.info("Jira forward webhook skipped — unsupported event shape", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      webhookEvent: readString(forwarded.payload, "webhookEvent") ?? undefined,
      issueEventTypeName:
        readString(forwarded.payload, "issue_event_type_name") ?? undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey("jira");
  const client = createGitHubRelayfileClient(integration.workspaceId);

  const syncName = jiraSyncNameForModel(normalized.model);
  const job = createWebhookSyncJob({
    workspaceId: integration.workspaceId,
    connectionId,
    providerConfigKey,
    provider: JIRA_PROVIDER,
    syncName,
    model: normalized.model,
  });

  const record = normalized.isDelete
    ? {
        ...normalized.record,
        _nango_metadata: {
          last_action: "deleted",
          deleted_at:
            readString(normalized.record, "updated") ??
            readString(readRecord(normalized.record, "fields"), "updated") ??
            readString(normalized.record, "updated_at") ??
            new Date().toISOString(),
        },
      }
    : normalized.record;

  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: "jira",
    eventType: normalized.webhookEvent,
    connectionId,
    deliveryId: forwarded.deliveryId,
    payload: record,
  });
  await writeBatchToRelayfileOrThrow(client, [record], job);

  await fireWebhookFanout(
    "jira",
    {
      provider: "jira",
      connectionId,
      workspaceId: integration.workspaceId,
      eventType: normalized.webhookEvent,
      payload: record,
      data: record,
      deliveryId: forwarded.deliveryId,
      headers: forwarded.headers,
      timestamp: new Date().toISOString(),
    },
    { excludeRelayfilePrimary: true },
  );

  await logger.info("Jira forward webhook ingested directly", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    model: normalized.model,
    webhookEvent: normalized.webhookEvent,
    objectId: normalized.id,
    deleted: normalized.isDelete,
    deliveryId: forwarded.deliveryId ?? undefined,
  });
}

// Confluence forward webhooks: payload shape is
// `{ event: "page_created" | ..., page?: {...}, space?: {...} }` (Atlassian
// Cloud webhooks) or `{ webhookEvent: ... }` (Server/Data Center). We use the
// same entity-in-envelope strategy as Jira and dispatch through the
// `writeConfluenceRecord` writer via `writeBatchToRelayfile`.
async function handleConfluenceForward(envelope: NangoWebhookEnvelope): Promise<void> {
  const connectionId = envelope.connectionId?.trim() ?? "";
  if (!connectionId) {
    await logger.warn("Confluence forward webhook received without a connection id", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    return;
  }

  const integration = await findWorkspaceIntegrationByConnection(
    "confluence",
    connectionId,
  );
  if (!integration) {
    await logger.warn(
      "Confluence forward webhook received with no matching workspace integration",
      {
        area: "nango-webhook",
        provider: envelope.from,
        connectionId,
        providerConfigKey: envelope.providerConfigKey || undefined,
      },
    );
    return;
  }

  const forwarded = unwrapProviderForwardPayload(envelope.payload);
  if (!forwarded.payload) {
    await logger.warn("Confluence forward webhook payload was not an object", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
    });
    return;
  }

  const normalized = normalizeConfluenceForwardPayload(forwarded.payload);
  if (!normalized) {
    await logger.info("Confluence forward webhook skipped — unsupported event shape", {
      area: "nango-webhook",
      workspaceId: integration.workspaceId,
      connectionId,
      event:
        readString(forwarded.payload, "event") ??
        readString(forwarded.payload, "webhookEvent") ??
        undefined,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    integration.providerConfigKey ||
    getProviderConfigKey("confluence");
  const client = createGitHubRelayfileClient(integration.workspaceId);

  const syncName = confluenceSyncNameForModel(normalized.model);
  const job = createWebhookSyncJob({
    workspaceId: integration.workspaceId,
    connectionId,
    providerConfigKey,
    provider: CONFLUENCE_PROVIDER,
    syncName,
    model: normalized.model,
  });

  const record = normalized.isDelete
    ? {
        ...normalized.record,
        _nango_metadata: {
          last_action: "deleted",
          deleted_at:
            readString(normalized.record, "lastModified") ??
            readString(normalized.record, "last_modified") ??
            readString(normalized.record, "updated_at") ??
            new Date().toISOString(),
        },
      }
    : normalized.record;

  await enqueueIntegrationWatchEvent({
    workspaceId: integration.workspaceId,
    provider: "confluence",
    eventType: normalized.event,
    connectionId,
    deliveryId: forwarded.deliveryId,
    payload: record,
  });
  await writeBatchToRelayfileOrThrow(client, [record], job);

  await fireWebhookFanout(
    "confluence",
    {
      provider: "confluence",
      connectionId,
      workspaceId: integration.workspaceId,
      eventType: normalized.event,
      payload: record,
      data: record,
      deliveryId: forwarded.deliveryId,
      headers: forwarded.headers,
      timestamp: new Date().toISOString(),
    },
    { excludeRelayfilePrimary: true },
  );

  await logger.info("Confluence forward webhook ingested directly", {
    area: "nango-webhook",
    workspaceId: integration.workspaceId,
    connectionId,
    model: normalized.model,
    event: normalized.event,
    objectId: normalized.id,
    deleted: normalized.isDelete,
    deliveryId: forwarded.deliveryId ?? undefined,
  });
}

export interface NormalizedGitLabForward {
  model: GitLabForwardModel;
  records: Record<string, unknown>[];
  triggerSyncs?: string[];
  eventType: string;
}

export function normalizeGitLabForwardPayload(
  payload: Record<string, unknown>,
): NormalizedGitLabForward | null {
  const objectKind = (readString(payload, "object_kind") ?? readString(payload, "event_type") ?? "")
    .trim()
    .toLowerCase();
  const project = readRecord(payload, "project");
  const projectId = readString(project, "id") ?? readString(payload, "project_id");
  const projectPath =
    readString(project, "path_with_namespace") ??
    readString(project, "pathWithNamespace") ??
    readString(payload, "project_path");
  const attributes = readRecord(payload, "object_attributes");

  if (objectKind === "issue") {
    if (!attributes || !projectId) return null;
    const id = readString(attributes, "id");
    const iid = readString(attributes, "iid");
    if (!id || !iid) return null;
    const eventType = gitLabObjectEventType("issue", attributes);
    return {
      model: GITLAB_ISSUE_MODEL,
      eventType,
      records: [
        recordWithWebhookMetadata(
          {
            ...attributes,
            id,
            iid,
            project_id: projectId,
            ...(projectPath ? { project_path: projectPath } : {}),
            state: normalizeGitLabIssueState(attributes),
          },
          payload,
          eventType,
          isGitLabDeleteEvent(eventType),
        ),
      ],
    };
  }

  if (objectKind === "merge_request") {
    if (!attributes || !projectId) return null;
    const id = readString(attributes, "id");
    const iid = readString(attributes, "iid");
    if (!id || !iid) return null;
    const eventType = gitLabObjectEventType("merge_request", attributes);
    return {
      model: GITLAB_MERGE_REQUEST_MODEL,
      eventType,
      records: [
        recordWithWebhookMetadata(
          {
            ...attributes,
            id,
            iid,
            project_id: projectId,
            ...(projectPath ? { project_path: projectPath } : {}),
            state: normalizeGitLabMergeRequestState(attributes),
          },
          payload,
          eventType,
          isGitLabDeleteEvent(eventType),
        ),
      ],
    };
  }

  if (objectKind === "push") {
    const commits = payload.commits;
    if (!Array.isArray(commits) || !projectId) return null;
    const records = commits
      .filter(isObject)
      .map((commit) => {
        const id = readString(commit, "id");
        if (!id) return null;
        const committedAt =
          readString(commit, "timestamp") ??
          readString(commit, "committed_date") ??
          readString(commit, "created_at");
        return recordWithWebhookMetadata(
          {
            ...commit,
            id,
            project_id: projectId,
            ...(projectPath ? { project_path: projectPath } : {}),
            ...(committedAt ? { updated_at: committedAt } : {}),
            web_url: readString(commit, "url") ?? readString(commit, "web_url") ?? undefined,
          },
          payload,
          "push",
          false,
        );
      })
      .filter((record): record is Record<string, unknown> => Boolean(record));
    const totalCommitsCount = Number(readString(payload, "total_commits_count") ?? "");
    const triggerSyncs =
      Number.isFinite(totalCommitsCount) && totalCommitsCount > records.length
        ? [GITLAB_COMMITS_SYNC_NAME]
        : undefined;
    return records.length > 0
      ? {
          model: GITLAB_COMMIT_MODEL,
          eventType: "push",
          records,
          ...(triggerSyncs ? { triggerSyncs } : {}),
        }
      : null;
  }

  if (objectKind === "pipeline") {
    if (!attributes || !projectId) return null;
    const id = readString(attributes, "id");
    if (!id) return null;
    const status = readString(attributes, "status") ?? readString(attributes, "state");
    const eventType = status ? `pipeline.${status.toLowerCase()}` : "pipeline.update";
    return {
      model: GITLAB_PIPELINE_MODEL,
      eventType,
      records: [
        recordWithWebhookMetadata(
          {
            ...attributes,
            id,
            project_id: projectId,
            ...(projectPath ? { project_path: projectPath } : {}),
            ...(status ? { status } : {}),
            updated_at:
              readString(attributes, "updated_at") ??
              readString(attributes, "updatedAt") ??
              readString(attributes, "finished_at") ??
              readString(attributes, "created_at") ??
              undefined,
          },
          payload,
          eventType,
          false,
        ),
      ],
    };
  }

  if (objectKind === "deployment") {
    const deployment = attributes ?? payload;
    if (!projectId) return null;
    const id = readString(deployment, "id") ?? readString(deployment, "deployment_id");
    if (!id) return null;
    const status = readString(deployment, "status") ?? readString(deployment, "state");
    const eventType = status ? `deployment.${status.toLowerCase()}` : "deployment.update";
    return {
      model: GITLAB_DEPLOYMENT_MODEL,
      eventType,
      records: [
        recordWithWebhookMetadata(
          {
            ...deployment,
            id,
            project_id: projectId,
            ...(projectPath ? { project_path: projectPath } : {}),
            ...(status ? { status } : {}),
            updated_at:
              readString(deployment, "updated_at") ??
              readString(deployment, "updatedAt") ??
              readString(deployment, "status_changed_at") ??
              readString(deployment, "statusChangedAt") ??
              readString(deployment, "finished_at") ??
              readString(deployment, "created_at") ??
              undefined,
          },
          payload,
          eventType,
          isGitLabDeleteEvent(eventType),
        ),
      ],
    };
  }

  if (objectKind === "build" || objectKind === "job") {
    if (!projectId) return null;
    const id = readString(payload, "build_id") ?? readString(payload, "id");
    const pipelineId = readString(payload, "pipeline_id");
    if (!id || !pipelineId) return null;
    const status =
      readString(payload, "build_status") ??
      readString(payload, "status") ??
      readString(payload, "state");
    const eventType = status ? `${objectKind}.${status.toLowerCase()}` : `${objectKind}.update`;
    const finishedAt = readString(payload, "build_finished_at") ?? readString(payload, "finished_at");
    const ref = readString(payload, "ref") ?? undefined;
    return {
      model: GITLAB_PIPELINE_JOB_MODEL,
      eventType,
      records: [
        recordWithWebhookMetadata(
          {
            id,
            pipeline_id: pipelineId,
            project_id: projectId,
            ...(projectPath ? { project_path: projectPath } : {}),
            name: readString(payload, "build_name") ?? readString(payload, "name") ?? undefined,
            stage: readString(payload, "build_stage") ?? readString(payload, "stage") ?? undefined,
            ...(status ? { status } : {}),
            ref,
            tag: readBoolean(payload, "tag") ?? undefined,
            created_at: readString(payload, "build_created_at") ?? readString(payload, "created_at") ?? undefined,
            started_at: readString(payload, "build_started_at") ?? readString(payload, "started_at") ?? undefined,
            finished_at: finishedAt ?? undefined,
            updated_at:
              finishedAt ??
              readString(payload, "build_started_at") ??
              readString(payload, "started_at") ??
              readString(payload, "build_created_at") ??
              readString(payload, "created_at") ??
              undefined,
            web_url: readString(payload, "build_url") ?? readString(payload, "web_url") ?? undefined,
          },
          payload,
          eventType,
          isGitLabDeleteEvent(eventType),
        ),
      ],
      triggerSyncs: [GITLAB_PIPELINES_SYNC_NAME],
    };
  }

  if (objectKind === "tag_push") {
    if (!projectId) return null;
    const rawRef = readString(payload, "ref");
    if (!rawRef) return null;
    const ref = normalizeGitLabTagRef(rawRef);
    const eventType = isZeroSha(readString(payload, "after"))
      ? "tag_push.delete"
      : "tag_push.update";
    return {
      model: GITLAB_TAG_MODEL,
      eventType,
      records: [
        recordWithWebhookMetadata(
          {
            id: `${projectId}:${ref}`,
            ref,
            name: ref,
            project_id: projectId,
            ...(projectPath ? { project_path: projectPath } : {}),
            target: readString(payload, "checkout_sha") ?? readString(payload, "after") ?? undefined,
            updated_at: readString(payload, "updated_at") ?? undefined,
          },
          payload,
          eventType,
          isGitLabDeleteEvent(eventType),
        ),
      ],
    };
  }

  return null;
}

function normalizeGitLabTagRef(ref: string): string {
  return ref.replace(/^refs\/tags\//u, "");
}

function isZeroSha(value: string | null): boolean {
  return Boolean(value && /^0{40}$/u.test(value));
}

function gitLabObjectEventType(
  objectType: "issue" | "merge_request",
  attributes: Record<string, unknown>,
): string {
  const action = readString(attributes, "action")?.toLowerCase();
  if (action) {
    return `${objectType}.${action}`;
  }
  const state = readString(attributes, "state")?.toLowerCase();
  if (state === "merged") return `${objectType}.merge`;
  if (state === "closed") return `${objectType}.close`;
  if (state === "opened") return `${objectType}.open`;
  return `${objectType}.update`;
}

function isGitLabDeleteEvent(eventType: string): boolean {
  return /(?:^|\.)(delete|deleted|destroy|destroyed|remove|removed)$/u.test(
    eventType.toLowerCase(),
  );
}

function normalizeGitLabIssueState(attributes: Record<string, unknown>): string | undefined {
  const action = readString(attributes, "action")?.toLowerCase();
  const state = readString(attributes, "state")?.toLowerCase();
  if (action === "close") return "closed";
  if (action === "open" || action === "reopen") return "opened";
  return state || undefined;
}

function normalizeGitLabMergeRequestState(attributes: Record<string, unknown>): string | undefined {
  const action = readString(attributes, "action")?.toLowerCase();
  const state = readString(attributes, "state")?.toLowerCase();
  if (action === "merge") return "merged";
  if (action === "close") return "closed";
  if (action === "open" || action === "reopen") return "opened";
  return state || undefined;
}

function gitLabSyncNameForModel(model: NormalizedGitLabForward["model"]): string {
  if (model === GITLAB_MERGE_REQUEST_MODEL) return GITLAB_MERGE_REQUESTS_SYNC_NAME;
  if (model === GITLAB_COMMIT_MODEL) return GITLAB_COMMITS_SYNC_NAME;
  if (model === GITLAB_PIPELINE_MODEL) return GITLAB_PIPELINES_SYNC_NAME;
  if (model === GITLAB_PIPELINE_JOB_MODEL) return GITLAB_PIPELINES_SYNC_NAME;
  if (model === GITLAB_DEPLOYMENT_MODEL) return GITLAB_DEPLOYMENTS_SYNC_NAME;
  if (model === GITLAB_TAG_MODEL) return GITLAB_TAGS_SYNC_NAME;
  return GITLAB_ISSUES_SYNC_NAME;
}

interface NormalizedJiraForward {
  model: typeof JIRA_ISSUE_MODEL | typeof JIRA_PROJECT_MODEL;
  id: string;
  record: Record<string, unknown>;
  isDelete: boolean;
  webhookEvent: string;
}

// Pull the relevant entity out of a Jira webhook envelope and tag it with the
// model + delete flag the writer needs. Recognized event-name keywords:
//   issue / comment / worklog  → JiraIssue (record = `issue`)
//   project                    → JiraProject (record = `project`)
// `issue_deleted` / `project_deleted` route to the deletion branch so
// `writeProviderRecord` sees the synthetic `_nango_metadata` envelope.
function normalizeJiraForwardPayload(
  payload: Record<string, unknown>,
): NormalizedJiraForward | null {
  const webhookEvent = (
    readString(payload, "webhookEvent") ??
    readString(payload, "webhook_event") ??
    readString(payload, "issue_event_type_name") ??
    ""
  )
    .trim()
    .toLowerCase();
  const jiraEventName = webhookEvent.split(":").pop() ?? webhookEvent;

  const isDelete =
    jiraEventName === "issue_deleted" || jiraEventName === "project_deleted";

  // Comments arrive nested under `comment` but the relayfile path-mapper
  // treats them as `JiraIssue` with `issue` context. The Nango sync emits
  // them as the same `JiraIssue` model. To keep parity we forward the parent
  // issue when present; if not, the comment alone is enough to derive an id
  // for the deletion path.
  if (jiraEventName.startsWith("project_")) {
    const project = readRecord(payload, "project");
    if (!project) return null;
    const id = readString(project, "id") ?? readString(project, "key");
    if (!id) return null;
    return {
      model: JIRA_PROJECT_MODEL,
      id,
      record: project,
      isDelete,
      webhookEvent,
    };
  }

  // Issue / comment / worklog all carry the parent `issue` record.
  if (
    jiraEventName.startsWith("issue_") ||
    jiraEventName.startsWith("comment_") ||
    jiraEventName.startsWith("worklog_")
  ) {
    const issue = readRecord(payload, "issue");
    if (!issue) return null;
    const id = readString(issue, "id") ?? readString(issue, "key");
    if (!id) return null;
    return {
      model: JIRA_ISSUE_MODEL,
      id,
      record: issue,
      // A comment_deleted webhook fires on the parent issue, not the issue
      // itself — treat as an update so the path-mapper rewrites the parent
      // issue's file (comments are not separately materialized today).
      isDelete,
      webhookEvent,
    };
  }

  return null;
}

function jiraSyncNameForModel(
  model: NormalizedJiraForward["model"],
): string {
  return model === JIRA_PROJECT_MODEL
    ? JIRA_PROJECTS_SYNC_NAME
    : JIRA_ISSUES_SYNC_NAME;
}

export interface NormalizedConfluenceForward {
  model: typeof CONFLUENCE_PAGE_MODEL | typeof CONFLUENCE_SPACE_MODEL;
  id: string;
  record: Record<string, unknown>;
  isDelete: boolean;
  event: string;
}

export function normalizeConfluenceForwardPayload(
  payload: Record<string, unknown>,
): NormalizedConfluenceForward | null {
  const event = (
    readString(payload, "event") ??
    readString(payload, "webhookEvent") ??
    readString(payload, "type") ??
    ""
  )
    .trim()
    .toLowerCase();

  const resourceEventMatch = event.match(
    /^(page|blogpost|content|space)_(created|updated|removed|deleted|trashed|restored|moved|archived)$/,
  );
  if (!resourceEventMatch) return null;

  const resourceType = resourceEventMatch[1];
  const isDelete =
    event.endsWith("_removed") ||
    event.endsWith("_deleted");

  if (resourceType === "space") {
    const space = readRecord(payload, "space");
    if (!space) return null;
    // `computeConfluencePath` prefers `key` over `id` for spaces, mirroring
    // the writer. Either is acceptable as the deletion id.
    const id = readString(space, "key") ?? readString(space, "id");
    if (!id) return null;
    return {
      model: CONFLUENCE_SPACE_MODEL,
      id,
      record: space,
      isDelete,
      event,
    };
  }

  if (
    resourceType === "page" ||
    resourceType === "blogpost" ||
    resourceType === "content"
  ) {
    const page = readRecord(payload, "page") ?? readRecord(payload, "content");
    if (!page) return null;
    const id = readString(page, "id");
    if (!id) return null;
    return {
      model: CONFLUENCE_PAGE_MODEL,
      id,
      record: normalizeConfluencePageForwardRecord(page, event),
      isDelete,
      event,
    };
  }

  return null;
}

function normalizeConfluencePageForwardRecord(
  page: Record<string, unknown>,
  event: string,
): Record<string, unknown> {
  const action = event.split("_").at(-1) ?? event;
  const record = {
    ...page,
    _webhook: {
      ...(readRecord(page, "_webhook") ?? {}),
      eventType: event,
      action,
    },
  };
  if (readString(record, "status")) {
    return record;
  }
  if (event.endsWith("_trashed")) {
    return { ...record, status: "trashed" };
  }
  if (event.endsWith("_archived")) {
    return { ...record, status: "archived" };
  }
  if (event.endsWith("_restored")) {
    return { ...record, status: "current" };
  }
  return record;
}

function confluenceSyncNameForModel(
  model: NormalizedConfluenceForward["model"],
): string {
  return model === CONFLUENCE_SPACE_MODEL
    ? CONFLUENCE_SPACES_SYNC_NAME
    : CONFLUENCE_PAGES_SYNC_NAME;
}

function isLinearForwardDeletionEvent(normalized: LinearNormalizedWebhook): boolean {
  return isForwardDeletionEvent(normalized.eventType, normalized.payload);
}

function linearAgentWebhookDispatchPaths(normalized: LinearNormalizedWebhook): string[] {
  const primaryPath = linearAgentWebhookEventPath(
    normalized.eventType,
    normalized.objectId,
  );
  if (!primaryPath) {
    return [];
  }
  const paths = new Set<string>([primaryPath]);
  if (normalized.eventType.startsWith("AgentSessionEvent.")) {
    const payload = isObject(normalized.payload) ? normalized.payload : null;
    const agentActivity = readRecord(payload, "agentActivity");
    const commentId =
      readString(agentActivity, "id") ??
      readString(agentActivity, "activityId") ??
      readString(agentActivity, "activity_id") ??
      normalized.objectId;
    if (commentId) {
      paths.add(linearCommentPath(commentId));
    }
  }
  return [...paths];
}

async function dispatchLinearAgentWebhookWatch(input: {
  workspaceId: string;
  connectionId: string;
  deliveryId?: string | null;
  normalized: LinearNormalizedWebhook;
}): Promise<void> {
  const paths = linearAgentWebhookDispatchPaths(input.normalized);
  if (paths.length === 0) {
    return;
  }
  await enqueueIntegrationWatchEvent({
    workspaceId: input.workspaceId,
    provider: "linear",
    eventType: input.normalized.eventType,
    connectionId: input.connectionId,
    deliveryId: input.deliveryId,
    paths,
    payload: input.normalized.payload,
  });
}

async function tryDispatchLinearAgentWebhookWatch(input: {
  workspaceId: string;
  connectionId: string;
  deliveryId?: string | null;
  normalized: LinearNormalizedWebhook;
}): Promise<void> {
  try {
    await dispatchLinearAgentWebhookWatch(input);
  } catch (error) {
    await logger.error("Linear agent webhook integration watch dispatch failed", {
      area: "nango-webhook",
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      deliveryId: input.deliveryId ?? undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function hasCompleteLinearForwardData(
  objectType: string,
  data: Record<string, unknown>,
): boolean {
  const normalizedType = objectType.trim().toLowerCase();

  if (normalizedType === "issue") {
    return (
      typeof data.id === "string" &&
      typeof data.identifier === "string" &&
      typeof data.title === "string" &&
      isObject(data.state) &&
      typeof data.priority === "number" &&
      typeof data.url === "string" &&
      typeof data.createdAt === "string" &&
      typeof data.updatedAt === "string"
    );
  }

  if (normalizedType === "comment") {
    return (
      typeof data.id === "string" &&
      (isObject(data.issue) ||
        typeof data.issueId === "string" ||
        typeof data.issue_id === "string") &&
      typeof data.createdAt === "string" &&
      typeof data.updatedAt === "string"
    );
  }

  return true;
}

function isRemovalOperation(operation: string): boolean {
  const normalized = operation.toLowerCase();
  return (
    REMOVAL_OPERATIONS.has(normalized) ||
    /(^|[.:_-])(delete|deleted|deletion|remove|removed|removal|disconnect|disconnected|disconnection|revoke|revoked)($|[.:_-])/.test(normalized)
  );
}

function normalizeNangoProviderToWorkspaceProvider(
  nangoProvider: string | null | undefined,
): WorkspaceIntegrationProvider | null {
  if (!nangoProvider) return null;

  const normalized = nangoProvider.trim().toLowerCase();
  const mapped = NANGO_PROVIDER_TO_WORKSPACE_PROVIDER[normalized];
  if (mapped) {
    return mapped;
  }

  if (
    normalized === "github-app-oauth" ||
    normalized === "github-app" ||
    normalized.startsWith("github-")
  ) {
    return "github";
  }

  if (normalized.startsWith("slack")) {
    // The relayfile slack integration's Nango config-key is `slack-relay`
    // and its workspace_integrations provider id is `slack` (with
    // `slack-sage` retained as a legacy alias). Any unrecognized `slack-*`
    // config key (other than the dedicated my-senior-dev / nightcto
    // products) routes to the relayfile slack id.
    if (normalized.includes("relay") || normalized.includes("sage")) {
      return "slack";
    }
    if (
      normalized.includes("my-senior-dev") ||
      normalized.includes("myseniordev")
    ) {
      return "slack-my-senior-dev";
    }
    if (normalized.includes("nightcto") || normalized.includes("night-cto")) {
      return "slack-nightcto";
    }
  }

  return null;
}

/**
 * Auth lifecycle for the github-oauth-relay user-identity connection.
 * Persistence model is user_integrations-only under the `github-oauth`
 * provider id; see github-oauth-identity.ts for why this never touches
 * workspace_integrations or the `github` provider.
 */
async function handleGithubOauthIdentityAuthEvent(
  envelope: NangoWebhookEnvelope,
  payload: Record<string, unknown>,
): Promise<void> {
  const operation = (readString(payload, "operation") ?? "unknown").toLowerCase();
  const success = readBoolean(payload, "success");

  if (!envelope.connectionId) {
    await logger.warn("github-oauth identity auth webhook received without a connection id", {
      area: "nango-webhook",
      provider: GITHUB_OAUTH_IDENTITY_PROVIDER,
      operation,
    });
    return;
  }

  const existing = await findUserIntegrationByConnection(
    GITHUB_OAUTH_IDENTITY_PROVIDER,
    envelope.connectionId,
  );

  if (isRemovalOperation(operation)) {
    if (existing) {
      await deleteUserIntegration(existing.userId, GITHUB_OAUTH_IDENTITY_PROVIDER, existing.name ?? null);
    }
    return;
  }

  if (success === false) {
    await logger.warn("github-oauth identity auth webhook reported a failed operation", {
      area: "nango-webhook",
      provider: GITHUB_OAUTH_IDENTITY_PROVIDER,
      connectionId: envelope.connectionId,
      operation,
    });
    return;
  }

  const scopeFromPayload = readIntegrationConnectionScopeFromRecord(payload);
  const userId = existing?.userId ?? scopeFromPayload?.userId;
  if (!userId) {
    await logger.warn("github-oauth identity auth webhook could not be mapped to a user", {
      area: "nango-webhook",
      provider: GITHUB_OAUTH_IDENTITY_PROVIDER,
      connectionId: envelope.connectionId,
      operation,
    });
    return;
  }

  const providerConfigKey = envelope.providerConfigKey ?? existing?.providerConfigKey ?? null;
  const at = new Date().toISOString();
  const metadata = writeProviderReadiness(
    Object.keys(payload).length > 0 ? payload : existing?.metadata ?? {},
    {
      oauthConnectedAt: at,
      lastAuthAt: at,
      connectionId: envelope.connectionId,
      providerConfigKey: providerConfigKey ?? undefined,
      updatedAt: at,
    },
  );

  await upsertUserIntegration({
    userId,
    provider: GITHUB_OAUTH_IDENTITY_PROVIDER,
    name: existing?.name ?? null,
    connectionId: envelope.connectionId,
    providerConfigKey,
    installationId: null,
    metadata,
  });

  await logger.info("github-oauth identity auth webhook updated user integration", {
    area: "nango-webhook",
    userId,
    provider: GITHUB_OAUTH_IDENTITY_PROVIDER,
    connectionId: envelope.connectionId,
    operation,
  });
}

export async function handleAuthEvent(envelope: NangoWebhookEnvelope): Promise<void> {
  const payload = isObject(envelope.payload) ? envelope.payload : {};
  const providerFromPayload = readString(payload, "provider");

  // User-identity auth (github-oauth-relay) MUST short-circuit before the
  // generic provider normalization: `normalizeNangoProviderToWorkspaceProvider`
  // maps every `github-*` config key to the `github` workspace provider, which
  // would persist the identity connection as a deployer-user `github` row and
  // collide with the deploy/token-mint provider id. Identity connections only
  // ever live in user_integrations under the `github-oauth` provider.
  if (isGithubOauthIdentityConfigKey(envelope.providerConfigKey)) {
    await handleGithubOauthIdentityAuthEvent(envelope, payload);
    return;
  }

  const provider = normalizeProvider(envelope.providerConfigKey)
    ?? normalizeNangoProviderToWorkspaceProvider(envelope.providerConfigKey)
    ?? normalizeProvider(envelope.from)
    ?? normalizeNangoProviderToWorkspaceProvider(envelope.from)
    ?? normalizeNangoProviderToWorkspaceProvider(providerFromPayload);
  const operation = (readString(payload, "operation") ?? "unknown").toLowerCase();
  const success = readBoolean(payload, "success");

  if (!provider) {
    await logger.warn("Nango auth webhook received for unknown provider", {
      area: "nango-webhook",
      provider: envelope.from,
      providerConfigKey: envelope.providerConfigKey,
      payloadProvider: providerFromPayload,
      connectionId: envelope.connectionId ?? undefined,
      operation,
    });
    return;
  }

  if (!envelope.connectionId) {
    await logger.warn("Nango auth webhook received without a connection id", {
      area: "nango-webhook",
      provider,
      operation,
    });
    return;
  }

  if (success === false) {
    await logger.warn("Nango auth webhook reported a failed operation", {
      area: "nango-webhook",
      provider,
      connectionId: envelope.connectionId,
      operation,
    });
    return;
  }

  const existingIntegration = await findWorkspaceIntegrationByConnection(
    provider,
    envelope.connectionId,
  );
  const existingUserIntegration = existingIntegration
    ? null
    : await findUserIntegrationByConnection(provider, envelope.connectionId);

  if (isRemovalOperation(operation)) {
    if (existingIntegration) {
      await recordWorkspaceIntegrationDisconnect({
        workspaceId: existingIntegration.workspaceId,
        provider,
        connectionId: envelope.connectionId,
        providerConfigKey:
          existingIntegration.providerConfigKey ?? envelope.providerConfigKey ?? null,
      });
      await deleteWorkspaceIntegration(
        existingIntegration.workspaceId,
        provider,
        existingIntegration.name ?? null,
      );
    } else if (existingUserIntegration) {
      await deleteUserIntegration(
        existingUserIntegration.userId,
        provider,
        existingUserIntegration.name ?? null,
      );
    } else {
      await logger.warn("Nango auth removal webhook had no matching workspace integration", {
        area: "nango-webhook",
        provider,
        connectionId: envelope.connectionId,
        operation,
      });
    }
    return;
  }

  const scopeFromPayload = readIntegrationConnectionScopeFromRecord(payload);
  if (existingUserIntegration || scopeFromPayload?.scope.kind === "deployer_user") {
    const userId = existingUserIntegration?.userId ?? scopeFromPayload?.userId;
    if (!userId) {
      await logger.warn("Nango auth webhook could not be mapped to a deployer user", {
        area: "nango-webhook",
        provider,
        connectionId: envelope.connectionId,
        operation,
      });
      return;
    }

    const providerConfigKey =
      envelope.providerConfigKey ||
      existingUserIntegration?.providerConfigKey ||
      getProviderConfigKey(provider);
    const details = await getNangoConnectionDetails(
      envelope.connectionId,
      providerConfigKey,
    );
    const at = new Date().toISOString();
    const metadata = writeProviderReadiness(
      details?.payload ??
        (Object.keys(payload).length > 0 ? payload : existingUserIntegration?.metadata ?? {}),
      {
        oauthConnectedAt: at,
        lastAuthAt: at,
        connectionId: envelope.connectionId,
        providerConfigKey,
        updatedAt: at,
        initialSync: {
          state: "queued",
          enqueuedAt: at,
          startedAt: null,
          completedAt: null,
          failedAt: null,
          lastError: null,
          syncName: null,
          model: null,
          modifiedAfter: null,
        },
      },
    );

    await upsertUserIntegration({
      userId,
      provider,
      name: existingUserIntegration?.name ?? null,
      connectionId: envelope.connectionId,
      providerConfigKey,
      installationId: details?.installationId ?? existingUserIntegration?.installationId ?? null,
      metadata,
    });

    await logger.info("Nango auth webhook updated user integration", {
      area: "nango-webhook",
      userId,
      provider,
      connectionId: envelope.connectionId,
      operation,
    });
    return;
  }

  const workspaceId = existingIntegration?.workspaceId ?? readWorkspaceIdFromAuthPayload(payload);
  if (!workspaceId) {
    await logger.warn("Nango auth webhook could not be mapped to a workspace", {
      area: "nango-webhook",
      provider,
      connectionId: envelope.connectionId,
      operation,
    });
    return;
  }

  const providerConfigKey =
    envelope.providerConfigKey ||
    existingIntegration?.providerConfigKey ||
    getProviderConfigKey(provider);
  const details = await getNangoConnectionDetails(
    envelope.connectionId,
    providerConfigKey,
  );
  if (!details?.payload) {
    await logger.warn("Nango auth webhook skipped workspace integration write: connection was not verified upstream", {
      area: "nango-webhook",
      workspaceId,
      provider,
      connectionId: envelope.connectionId,
      providerConfigKey,
      operation,
    });
    return;
  }

  const verifiedWorkspaceId = readWorkspaceIdFromAuthPayload(details.payload);
  if (!verifiedWorkspaceId || verifiedWorkspaceId !== workspaceId) {
    await logger.warn("Nango auth webhook skipped workspace integration write: verified connection workspace mismatch", {
      area: "nango-webhook",
      workspaceId,
      verifiedWorkspaceId: verifiedWorkspaceId ?? undefined,
      provider,
      connectionId: envelope.connectionId,
      providerConfigKey,
      operation,
    });
    return;
  }

  let metadata = details.payload;

  if (isSlackProvider(provider)) {
    try {
      const slackMetadata = await resolveSlackConnectionMetadata(
        envelope.connectionId,
        providerConfigKey,
        payload,
      );
      metadata = mergeSlackConnectionIdentityMetadata(metadata, slackMetadata);
    } catch (error) {
      await logger.warn("Nango auth webhook could not enrich Slack integration metadata", {
        area: "nango-webhook",
        workspaceId,
        provider,
        connectionId: envelope.connectionId,
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const integrationName = existingIntegration?.name ?? (
    scopeFromPayload?.scope.kind === "workspace_service_account"
      ? scopeFromPayload.scope.name
      : null
  );
  const authConnectedAt = new Date().toISOString();
  const metadataWithReadiness = integrationName
    ? writeProviderReadiness(metadata, {
      oauthConnectedAt: authConnectedAt,
      lastAuthAt: authConnectedAt,
      connectionId: envelope.connectionId,
      providerConfigKey,
      updatedAt: authConnectedAt,
      initialSync: {
        state: "queued",
        enqueuedAt: authConnectedAt,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        lastError: null,
        syncName: null,
        model: null,
        modifiedAfter: null,
      },
    })
    : metadata;

  await upsertWorkspaceIntegration({
    workspaceId,
    provider,
    name: integrationName,
    connectionId: envelope.connectionId,
    providerConfigKey,
    installationId: details?.installationId ?? existingIntegration?.installationId ?? null,
    metadata: metadataWithReadiness,
  });
  if (provider === "github") {
    await indexGithubInstallationBestEffort({
      workspaceId,
      installationId: details?.installationId ?? existingIntegration?.installationId ?? null,
      payload: details.payload,
      connectionId: envelope.connectionId,
      providerConfigKey,
    });
  }
  if (!integrationName) {
    await markProviderOAuthConnected({
      workspaceId,
      provider,
      connectionId: envelope.connectionId,
      providerConfigKey,
    });
  }
  await ensureWorkspaceNangoSyncSchedules({
    workspaceId,
    provider,
    connectionId: envelope.connectionId,
    providerConfigKey,
    source: "auth",
  });

  await logger.info("Nango auth webhook updated workspace integration", {
    area: "nango-webhook",
    workspaceId,
    provider,
    connectionId: envelope.connectionId,
    operation,
  });
}

type MissingWorkspaceIntegrationSelfHealResult = {
  workspaceId: string | null;
  disposition: "continue" | "ack";
};

async function selfHealMissingWorkspaceIntegration(input: {
  provider: WorkspaceIntegrationProvider;
  connectionId: string;
  providerConfigKey: string;
  syncName: string;
}): Promise<MissingWorkspaceIntegrationSelfHealResult> {
  const { provider, connectionId, providerConfigKey, syncName } = input;

  let details: Awaited<ReturnType<typeof getNangoConnectionDetails>> = null;
  try {
    details = await getNangoConnectionDetails(connectionId, providerConfigKey);
  } catch (error) {
    await logger.warn(
      "Nango sync webhook self-heal could not fetch connection details",
      {
        area: "nango-webhook",
        provider,
        connectionId,
        providerConfigKey,
        syncName,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { workspaceId: null, disposition: "continue" };
  }

  if (!details?.payload) {
    return { workspaceId: null, disposition: "continue" };
  }

  const recoveredWorkspaceId = readWorkspaceIdFromAuthPayload(details.payload);
  if (!recoveredWorkspaceId) {
    await logger.warn(
      "Nango sync webhook self-heal could not recover workspaceId from connection details",
      {
        area: "nango-webhook",
        provider,
        connectionId,
        providerConfigKey,
        syncName,
      },
    );
    return { workspaceId: null, disposition: "continue" };
  }

  const recentDisconnect = await getRecentWorkspaceIntegrationDisconnect({
    workspaceId: recoveredWorkspaceId,
    provider,
    connectionId,
  });
  if (recentDisconnect) {
    await logger.warn(
      "Nango sync webhook self-heal skipped: connection was explicitly disconnected",
      {
        area: "nango-webhook",
        provider,
        connectionId,
        providerConfigKey,
        syncName,
        workspaceId: recoveredWorkspaceId,
        disconnectedAt: recentDisconnect.disconnectedAt.toISOString(),
        disconnectExpiresAt: recentDisconnect.expiresAt.toISOString(),
      },
    );
    return { workspaceId: null, disposition: "ack" };
  }

  // Self-heal must be atomic: a separate read-then-upsert leaves a window
  // where the auth webhook (or a concurrent self-heal) can write the real
  // (workspaceId, provider) row between our check and our write, after
  // which the upsert's conflict-update path overwrites the live row's
  // connectionId/installationId with our possibly-stale values. Push the
  // insert-if-absent decision down to the database so we never observe an
  // intermediate state. On conflict we still need to know whether the
  // existing row points at a different (newer) connection so we can bail
  // out of the replay path — which the helper hands back atomically.
  try {
    const result = await insertWorkspaceIntegrationIfAbsent({
      workspaceId: recoveredWorkspaceId,
      provider,
      connectionId,
      providerConfigKey,
      installationId: details.installationId ?? null,
      metadata: details.payload,
    });

    if (!result.inserted) {
      const existing = result.existing;
      if (existing && existing.connectionId !== connectionId) {
        // Conflict: the row points at a different connectionId than the
        // webhook. Before refusing, probe upstream to see if the existing
        // connection is still alive. If Nango returns 404 the row is
        // pointing at a deleted connection — a stale binding that nothing
        // upstream can ever sync. Atomically replace it with the new
        // connectionId so the workspace can keep receiving records.
        //
        // The replacement is gated by a compare-and-swap on the existing
        // connectionId so two racing self-heals can't clobber each other:
        // the second writer will see `existing.connectionId` already updated
        // and bail out with the standard mismatch warning.
        const liveness = await probeNangoConnectionLiveness(
          existing.connectionId,
          existing.providerConfigKey ?? providerConfigKey,
        );
        // Reconcile the binding when the bound connection is definitively gone
        // (Nango 404), OR when it is unverifiable ("unknown": Nango 5xx / stale
        // secret / probe error) AND the connection that just delivered this
        // sync webhook is itself confirmed alive by Nango.
        //
        // A bound connection id that Nango cannot resolve must not silently
        // drop records indefinitely. This stranded the neon mount for ~2 days:
        // the workspace was bound to a dead connection id while a different,
        // live connection ran the syncs; the bound id probed "unknown" (not
        // "gone"), so self-heal skipped forever and the VFS never materialized.
        // We never replace a bound connection that Nango confirms is "alive".
        let incomingLiveness: "alive" | "gone" | "unknown" | null = null;
        if (liveness === "unknown") {
          incomingLiveness = await probeNangoConnectionLiveness(
            connectionId,
            providerConfigKey,
          );
        }
        const shouldReplaceStaleBinding =
          liveness === "gone" ||
          (liveness === "unknown" && incomingLiveness === "alive");
        if (shouldReplaceStaleBinding) {
          const replaced = await replaceWorkspaceIntegrationConnectionIfStale({
            workspaceId: recoveredWorkspaceId,
            provider,
            connectionId,
            providerConfigKey,
            installationId: details.installationId ?? null,
            metadata: details.payload,
            expectedConnectionId: existing.connectionId,
          });
          if (replaced) {
            await logger.info(
              "Nango sync webhook self-heal replaced stale workspace_integrations row",
              {
                area: "nango-webhook",
                event: "nango-sync-binding-reconciled",
                provider,
                workspaceId: recoveredWorkspaceId,
                connectionId,
                replacedConnectionId: existing.connectionId,
                replacedLiveness: liveness,
                incomingLiveness,
                providerConfigKey,
                syncName,
              },
            );
            return { workspaceId: recoveredWorkspaceId, disposition: "continue" };
          }
          // CAS lost — another writer updated the row between the probe
          // and the replace. Fall through to the standard skip path so we
          // don't trample whatever they wrote.
        }
        // We are about to DROP this sync page's records: the workspace is bound
        // to a different connection we could not supersede. Logged at error
        // (not warn) so it surfaces/pages instead of silently losing data for
        // days, as happened with the neon mount.
        await logger.error(
          "Nango sync webhook dropped records: workspace bound to a different unresolvable connection",
          {
            area: "nango-webhook",
            event: "nango-sync-binding-mismatch-dropped",
            provider,
            workspaceId: recoveredWorkspaceId,
            connectionId,
            currentConnectionId: existing.connectionId,
            existingLiveness: liveness,
            incomingLiveness,
            providerConfigKey,
            syncName,
          },
        );
        return { workspaceId: null, disposition: "continue" };
      }
      // Same connection already present — nothing to write, but the row
      // exists, so proceed to enqueue the sync as if we had self-healed.
    }
  } catch (error) {
    await logger.warn(
      "Nango sync webhook self-heal failed to upsert workspace integration",
      {
        area: "nango-webhook",
        provider,
        connectionId,
        providerConfigKey,
        syncName,
        workspaceId: recoveredWorkspaceId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { workspaceId: null, disposition: "continue" };
  }

  await logger.info(
    "Nango sync webhook self-healed missing workspace_integrations row",
    {
      area: "nango-webhook",
      provider,
      connectionId,
      providerConfigKey,
      syncName,
      workspaceId: recoveredWorkspaceId,
    },
  );

  // A recovered row means the auth-webhook path (the only schedule starter)
  // never ran for this connection — start the schedules here too, or the
  // workspace only ever sees the single sync that triggered the self-heal.
  await ensureWorkspaceNangoSyncSchedules({
    workspaceId: recoveredWorkspaceId,
    provider,
    connectionId,
    providerConfigKey,
    source: "self-heal",
  });

  return { workspaceId: recoveredWorkspaceId, disposition: "continue" };
}

// neon-composio-relay is served by Composio but its records share the generated
// neon-relay Nango model registry (there is no neon-composio-relay:* registry
// entry). Normalize only for the isGeneratedNangoProviderModel guard so the
// already-supported neon-composio-relay sync (provider map + test predate this
// change) is not newly rejected by that guard; the enqueued job keeps its
// original providerConfigKey.
function providerConfigKeyForGeneratedRegistry(providerConfigKey: string): string {
  if (providerConfigKey === "neon-composio-relay") {
    return "neon-relay";
  }
  return providerConfigKey;
}

export async function handleSyncEvent(envelope: NangoWebhookEnvelope): Promise<void> {
  const payload = isObject(envelope.payload) ? envelope.payload : {};
  const syncName =
    readString(payload, "syncName") ??
    readString(payload, "sync_name") ??
    "unknown";
  const success = readBoolean(payload, "success");
  const model = readString(payload, "model") ?? "";
  const syncType = readSyncType(payload);
  const checkpoints = readCheckpoints(payload);
  const responseResults = readResponseResults(payload);
  const modifiedAfter = readNangoSyncModifiedAfter(payload);
  const connectionId = envelope.connectionId?.trim() ?? "";
  const provider =
    normalizeProvider(envelope.providerConfigKey) ??
    normalizeNangoProviderToWorkspaceProvider(envelope.providerConfigKey) ??
    normalizeProvider(envelope.from) ??
    normalizeNangoProviderToWorkspaceProvider(envelope.from);
  const providerConfigKey =
    envelope.providerConfigKey || (provider ? getProviderConfigKey(provider) : "");
  let workspaceId =
    provider && connectionId
      ? await resolveWorkspaceIdForSync(provider, connectionId)
      : null;

  // Self-heal: when the connect-time row is missing AND the auth webhook
  // never arrived (or arrived with stripped tags), resolve the workspaceId
  // from Nango directly and create the row before enqueueing the sync.
  // This is the safety net for the orphaned-connection failure mode where
  // Nango holds records but the cloud has no mapping.
  if (
    !workspaceId &&
    provider &&
    connectionId &&
    providerConfigKey
  ) {
    const selfHeal = await selfHealMissingWorkspaceIntegration({
      provider,
      connectionId,
      providerConfigKey,
      syncName,
    });
    workspaceId = selfHeal.workspaceId;
    if (!workspaceId && selfHeal.disposition === "ack") {
      return;
    }
  }

  if (success === false) {
    if (provider && workspaceId) {
      await markProviderInitialSyncFailed({
        workspaceId,
        provider,
        error: `Nango reported a failed sync for ${syncName}`,
        providerConfigKey,
        syncName,
        model,
        modifiedAfter,
      });
    }
    await logger.warn("Nango sync webhook reported a failed sync", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId: envelope.connectionId ?? undefined,
      providerConfigKey: envelope.providerConfigKey || undefined,
      syncName,
    });
    return;
  }

  if (!provider || !connectionId) {
    await logger.warn("Nango sync webhook could not determine provider or connection", {
      area: "nango-webhook",
      provider: envelope.from,
      connectionId: connectionId || undefined,
      providerConfigKey: envelope.providerConfigKey || undefined,
      syncName,
      model,
    });
    return;
  }

  const generatedRegistryProviderConfigKey = providerConfigKeyForGeneratedRegistry(providerConfigKey);
  if (!isGeneratedNangoProviderModel({ providerConfigKey: generatedRegistryProviderConfigKey, syncName, model })) {
    await logger.warn("Nango sync webhook ignored unknown provider/sync/model", {
      area: "nango-webhook",
      provider,
      connectionId,
      providerConfigKey,
      syncName,
      model,
      source: "nango-integrations/.nango/nango.json",
    });
    return;
  }

  if (!workspaceId) {
    // Unresolvable workspace must be retried by the ingress queue instead of
    // acknowledged as a successful webhook. Returning here drops this sync
    // page's records permanently.
    await logger.error("Nango sync webhook dropped records: could not resolve workspace", {
      area: "nango-webhook",
      event: "nango-sync-workspace-unresolved-dropped",
      provider,
      connectionId,
      providerConfigKey,
      syncName,
      model,
    });
    throw new Error(
      `Nango sync webhook could not resolve workspace for ${provider}/${connectionId}/${syncName}/${model}`,
    );
  }

  try {
    await markProviderInitialSyncQueued({
      workspaceId,
      provider,
      providerConfigKey,
      syncName,
      model,
      modifiedAfter,
    });
  } catch (error) {
    logNangoDbWorkspaceDiagnostic({
      callsite: "markProviderInitialSyncQueued",
      phase: "handler",
      error,
      provider,
      connectionId,
      providerConfigKey,
      workspaceId,
      syncName,
    });
    throw error;
  }
  await enqueueNangoSyncJob({
    type: "nango_sync",
    provider,
    connectionId,
    providerConfigKey,
    syncName,
    model,
    modifiedAfter,
    ...(syncType ? { syncType } : {}),
    ...(checkpoints !== undefined ? { checkpoints } : {}),
    ...(responseResults ? { responseResults } : {}),
    cursor: null,
    workspaceId,
  });

  await logger.info("Nango sync job enqueued", {
    area: "nango-webhook",
    provider,
    connectionId,
    providerConfigKey,
    syncName,
    model,
    workspaceId,
  });
}
