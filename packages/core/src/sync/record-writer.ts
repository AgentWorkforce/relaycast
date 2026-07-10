// Canonical record-write helpers. The aux-file / alias / index helpers that
// used to be imported here moved into each adapter's `emitXAuxiliaryFiles`
// in Phase 2 (relayfile-adapters#78/#79/#80/#81/#82/#83). What remains here
// is the canonical-path mapper surface used by `writeXRecord`/`writeProvider
// Record` plus each provider's `LAYOUT.md` builder for `writeCommonLayouts`.
import { githubLayoutPromptFile } from "@relayfile/adapter-github";
import {
  buildGitLabProjectsIndexFile,
  buildGitLabRootIndexFile,
  computeMetadataPath as computeGitLabMetadataPath,
  computePipelineJobPath as computeGitLabPipelineJobPath,
  gitLabByIdAliasPath,
  gitLabByRefAliasPath,
  gitLabByStatusAliasPath,
  gitLabByTitleAliasPath,
  gitLabLayoutPromptFile,
  gitLabProjectPrefix,
  gitLabProjectResourceIndexPath,
  gitLabProjectsIndexPath,
  type GitLabProjectIndexRow,
  type GitLabIndexedResourceType,
} from "@relayfile/adapter-gitlab";
import {
  computeGitHubPath,
  githubByIdAliasPath,
  githubIssuePath,
  githubPullRequestPath,
  githubRepositoryMetadataPath,
  normalizeNangoGitHubModel,
} from "@relayfile/adapter-github/path-mapper";
import { linearLayoutPromptFile } from "@relayfile/adapter-linear";
import {
  computeLinearPath,
  LINEAR_PATH_ROOT,
  linearByUuidAliasPath,
  linearCommentsIndexPath,
  normalizeNangoLinearModel,
} from "@relayfile/adapter-linear/path-mapper";
import {
  computeJiraPath,
  normalizeJiraObjectType,
  type JiraPathObjectType,
} from "@relayfile/adapter-jira/path-mapper";
import {
  confluencePageByIdAliasPath,
  confluencePagePath,
  confluencePagesIndexPath,
  confluenceSpacePath,
  normalizeConfluenceObjectType as adapterNormalizeConfluenceObjectType,
  type ConfluencePathObjectType,
} from "@relayfile/adapter-confluence/path-mapper";
import { confluenceLayoutPromptFile } from "@relayfile/adapter-confluence/layout-prompt";
import {
  notionDatabaseMetadataPath,
  notionLayoutPromptFile,
  notionStandalonePageContentPath,
  notionStandalonePagePath,
  notionUserPath,
  normalizeNangoNotionModel,
  type NotionPathObjectType,
} from "@relayfile/adapter-notion";
import {
  channelMetadataPath,
  computeSlackPath,
  directMessagePath,
  directMessageThreadReplyPath,
  messagePath,
  threadPath,
  threadReplyPath,
  userMetadataPath,
} from "@relayfile/adapter-slack/path-mapper";
import { slackLayoutPromptFile } from "@relayfile/adapter-slack";
import {
  telegramLayoutPromptFile,
  emitTelegramAuxiliaryFiles,
  resources as telegramResources,
  syncRecordBucketing as telegramRecordBucketing,
} from "@relayfile/adapter-telegram";
import {
  telegramBotConfigPath,
  telegramCallbackQueryPath,
  telegramChatMetadataPath,
  telegramInlineQueryPath,
  telegramMessagePath,
  telegramReactionPath,
  telegramThreadMessagePath,
  telegramUpdatePath,
} from "@relayfile/adapter-telegram/path-mapper";
import { jiraLayoutPromptFile } from "@relayfile/adapter-jira";
import { xLayoutPromptFile } from "@relayfile/adapter-x";
import {
  dockerHubLayoutPromptFile,
  emitDockerHubAuxiliaryFiles,
} from "@relayfile/adapter-docker-hub";
import {
  redditLayoutPromptFile,
  emitRedditAuxiliaryFiles,
  resources as redditResources,
} from "@relayfile/adapter-reddit";
import {
  computeXPath,
  xSearchResultPath,
} from "@relayfile/adapter-x/path-mapper";
import { computeDockerHubPath } from "@relayfile/adapter-docker-hub/path-mapper";
import { computeRedditPathFromModel } from "@relayfile/adapter-reddit/path-mapper";
import type { FileSemantics } from "@relayfile/sdk";
import { buildLinearSyncSemantics } from "./linear-semantics.js";
import type { NangoSyncJob } from "./nango-sync-job.js";
import { errorLogFields } from "../observability/error-cause.js";
import { resources as confluenceResources } from "@relayfile/adapter-confluence";
import { resources as githubResources } from "@relayfile/adapter-github";
import { resources as gitLabResources } from "@relayfile/adapter-gitlab";
import {
  resources as hubspotResources,
  hubspotLayoutPromptFile,
} from "@relayfile/adapter-hubspot";
import {
  granolaLayoutPromptFile,
  resources as granolaResources,
} from "@relayfile/adapter-granola";
import {
  fathomLayoutPromptFile,
  resources as fathomResources,
} from "@relayfile/adapter-fathom";
import {
  dropboxLayoutPromptFile,
  resources as dropboxResources,
} from "@relayfile/adapter-dropbox";
import {
  layoutPromptFile as daytonaLayoutPromptFile,
  resources as daytonaResources,
} from "@relayfile/adapter-daytona";
import {
  layoutPromptFile as gcpLayoutPromptFile,
} from "@relayfile/adapter-gcp";
import { readOnlyResources as gcpResources } from "@relayfile/adapter-gcp/resources";
import {
  layoutPromptFile as cloudflareLayoutPromptFile,
} from "@relayfile/adapter-cloudflare";
import { resources as cloudflareResources } from "@relayfile/adapter-cloudflare/resources";
import {
  layoutPromptFile as neonLayoutPromptFile,
} from "@relayfile/adapter-neon";
import { readOnlyResources as neonResources } from "@relayfile/adapter-neon/resources";
import {
  computeHubSpotPath,
  normalizeNangoHubSpotModel,
} from "@relayfile/adapter-hubspot/path-mapper";
import { computeGranolaPath } from "@relayfile/adapter-granola/path-mapper";
import { computeFathomPath } from "@relayfile/adapter-fathom/path-mapper";
import { computeDropboxPath } from "@relayfile/adapter-dropbox/path-mapper";
import {
  computeGcpPath,
  normalizeNangoGcpModel,
} from "@relayfile/adapter-gcp/path-mapper";
import {
  computeCloudflarePath,
  normalizeNangoCloudflareModel,
} from "@relayfile/adapter-cloudflare/path-mapper";
import {
  computeNeonPath,
  normalizeNangoNeonModel,
} from "@relayfile/adapter-neon/path-mapper";
import { resources as jiraResources } from "@relayfile/adapter-jira";
import { resources as linearResources } from "@relayfile/adapter-linear";
import { resources as notionResources } from "@relayfile/adapter-notion";
import { resources as slackResources } from "@relayfile/adapter-slack";
import {
  assertLayoutDiscoveryConsistency,
  writeDiscoveryArtifacts,
  type AdapterResourceConfig,
} from "./discovery-emitter.js";
import {
  googleMailStableProjection,
  isGoogleMailStableDedupEnabled,
  stableJson,
  type GoogleMailStableModel,
} from "./google-mail-stable-dedup.js";

// The canonical adapter registry (`ADAPTERS`) and `resolveAdapter` live near
// the bottom of this file (search for `const ADAPTERS`) because the registry
// entries' `emitAuxiliaryFiles` closures reference the per-adapter
// `writeXAuxiliaryFiles` wrappers defined later. `resolveAdapter` is a hoisted
// function declaration, so the layout / discovery code above can call it.
//
// `resourcesForProvider(provider)` is preserved as a thin shim over
// `resolveAdapter` so the discovery producer keeps identical
// resources-or-empty semantics (slack-* → slack, x/unknown → []).
function resourcesForProvider(
  provider: string,
): readonly AdapterResourceConfig[] {
  return resolveAdapter(provider)?.resources ?? [];
}

export const WRITE_CONCURRENCY = 10;
const BULK_WRITE_BUSY_RETRY_MAX_ATTEMPTS = 6;
const BULK_WRITE_BUSY_RETRY_BASE_DELAY_MS = 500;
const BULK_WRITE_BUSY_RETRY_MAX_DELAY_MS = 30_000;
// Keep in-step retries below the CF Workflow page-step timeout; the workflow
// can still retry the whole page if Relayfile remains busy beyond this window.
const BULK_WRITE_BUSY_RETRY_DEADLINE_MS = 240_000;
const BULK_WRITE_BUSY_RETRYABLE_CODES = new Set(["workspace_busy", "queue_full"]);
const GOOGLE_MAIL_PROVIDER = "google-mail";
const GOOGLE_CALENDAR_PROVIDER = "google-calendar";
const GRANOLA_PROVIDER = "granola";
const RECALL_PROVIDER = "recall";
const FATHOM_PROVIDER = "fathom";
const DOCKER_HUB_PROVIDER = "docker-hub";
const REDDIT_PROVIDER = "reddit";
const DROPBOX_PROVIDER = "dropbox";
const DAYTONA_PROVIDER = "daytona";
const GCP_PROVIDER = "gcp";
const CLOUDFLARE_PROVIDER = "cloudflare";
const NEON_PROVIDER = "neon";
const TELEGRAM_PROVIDER = "telegram";
const GOOGLE_MAIL_PROVIDER_ALIASES = new Set([GOOGLE_MAIL_PROVIDER, "google-mail-relay"]);
const GOOGLE_CALENDAR_PROVIDER_ALIASES = new Set([GOOGLE_CALENDAR_PROVIDER, "google-calendar-relay"]);
const GRANOLA_PROVIDER_ALIASES = new Set([GRANOLA_PROVIDER, "granola-relay"]);
const RECALL_PROVIDER_ALIASES = new Set([RECALL_PROVIDER, "recall-relay"]);
const FATHOM_PROVIDER_ALIASES = new Set([FATHOM_PROVIDER, "fathom-relay", "fathom-oauth"]);
const DOCKER_HUB_PROVIDER_ALIASES = new Set([
  DOCKER_HUB_PROVIDER,
  "docker-hub-composio-relay",
  "docker_hub-composio-relay",
]);
const REDDIT_PROVIDER_ALIASES = new Set([
  REDDIT_PROVIDER,
  "reddit-composio-relay",
]);
const DROPBOX_PROVIDER_ALIASES = new Set([DROPBOX_PROVIDER, "dropbox-relay"]);
const GCP_PROVIDER_ALIASES = new Set([GCP_PROVIDER, "gcp-relay"]);
const CLOUDFLARE_PROVIDER_ALIASES = new Set([
  CLOUDFLARE_PROVIDER,
  "cloudflare-relay",
]);
const NEON_PROVIDER_ALIASES = new Set([NEON_PROVIDER, "neon-relay", "neon-composio-relay"]);
const TELEGRAM_PROVIDER_ALIASES = new Set([TELEGRAM_PROVIDER, "telegram-relay"]);

function isGoogleMailProvider(provider: string): boolean {
  return GOOGLE_MAIL_PROVIDER_ALIASES.has(provider);
}

function isGoogleCalendarProvider(provider: string): boolean {
  return GOOGLE_CALENDAR_PROVIDER_ALIASES.has(provider);
}

function isGranolaProvider(provider: string): boolean {
  return GRANOLA_PROVIDER_ALIASES.has(provider);
}

function isRecallProvider(provider: string): boolean {
  return RECALL_PROVIDER_ALIASES.has(provider);
}

function isFathomProvider(provider: string): boolean {
  return FATHOM_PROVIDER_ALIASES.has(provider);
}

function isDockerHubProvider(provider: string): boolean {
  return DOCKER_HUB_PROVIDER_ALIASES.has(provider);
}

function isRedditProvider(provider: string): boolean {
  return REDDIT_PROVIDER_ALIASES.has(provider);
}

function isDropboxProvider(provider: string): boolean {
  return DROPBOX_PROVIDER_ALIASES.has(provider);
}

function isGcpProvider(provider: string): boolean {
  return GCP_PROVIDER_ALIASES.has(provider);
}

function isCloudflareProvider(provider: string): boolean {
  return CLOUDFLARE_PROVIDER_ALIASES.has(provider);
}

function isNeonProvider(provider: string): boolean {
  return NEON_PROVIDER_ALIASES.has(provider);
}

function isTelegramProvider(provider: string): boolean {
  return TELEGRAM_PROVIDER_ALIASES.has(provider);
}

function recallLayoutPromptFile(): { path: string; content: string; contentType?: string } {
  return {
    path: "/recall/LAYOUT.md",
    content: [
      "# Recall",
      "",
      "Recall recordings are synced under `/recall/recordings/{id}.json`.",
      "",
      "Discovery schema: `/discovery/recall/recordings/.schema.json`.",
      "",
      "Each recording file carries the raw Recall payload plus `transcript_text` when a transcript is available.",
      "",
    ].join("\n"),
    contentType: "text/markdown; charset=utf-8",
  };
}

const RECALL_RESOURCES: readonly AdapterResourceConfig[] = [
  {
    name: "recordings",
    path: "/recall/recordings",
    pathPattern: /^\/recall\/recordings\/([^/]+)\.json$/,
    idPattern: /^([^/]+)\.json$/,
    schema: "discovery/recall/recordings/.schema.json",
    createExample: "discovery/recall/recordings/.create.example.json",
  },
];

const GOOGLE_MAIL_RESOURCES: readonly AdapterResourceConfig[] = [
  {
    name: "labels",
    path: "/google-mail/labels",
    pathPattern: /^\/google-mail\/labels(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-mail/labels/.schema.json",
    createExample: "discovery/google-mail/labels/.create.example.json",
  },
  {
    name: "filters",
    path: "/google-mail/filters",
    pathPattern: /^\/google-mail\/filters(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-mail/filters/.schema.json",
    createExample: "discovery/google-mail/filters/.create.example.json",
  },
  {
    name: "send-as",
    path: "/google-mail/send-as",
    pathPattern: /^\/google-mail\/send-as(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-mail/send-as/.schema.json",
    createExample: "discovery/google-mail/send-as/.create.example.json",
  },
  {
    name: "messages",
    path: "/google-mail/messages",
    pathPattern: /^\/google-mail\/messages(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-mail/messages/.schema.json",
    createExample: "discovery/google-mail/messages/.create.example.json",
  },
  {
    name: "threads",
    path: "/google-mail/threads",
    pathPattern: /^\/google-mail\/threads(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-mail/threads/.schema.json",
    createExample: "discovery/google-mail/threads/.create.example.json",
  },
  {
    name: "watch-renewals",
    path: "/google-mail/watch-renewals",
    pathPattern: /^\/google-mail\/watch-renewals(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-mail/watch-renewals/.schema.json",
    createExample: "discovery/google-mail/watch-renewals/.create.example.json",
  },
];

const GOOGLE_CALENDAR_RESOURCES: readonly AdapterResourceConfig[] = [
  {
    name: "calendars",
    path: "/google-calendar/calendars",
    pathPattern: /^\/google-calendar\/calendars(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-calendar/calendars/.schema.json",
    createExample: "discovery/google-calendar/calendars/.create.example.json",
  },
  {
    name: "settings",
    path: "/google-calendar/settings",
    pathPattern: /^\/google-calendar\/settings(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-calendar/settings/.schema.json",
    createExample: "discovery/google-calendar/settings/.create.example.json",
  },
  {
    name: "colors",
    path: "/google-calendar/colors/{colorType}",
    sampleIndexPath: "/google-calendar/colors",
    pathPattern: /^\/google-calendar\/colors\/[^/]+(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-calendar/colors/{colorType}/.schema.json",
    createExample: "discovery/google-calendar/colors/{colorType}/.create.example.json",
  },
  {
    name: "events",
    path: "/google-calendar/calendars/{calendarId}/events",
    sampleIndexPath: "/google-calendar/events",
    pathPattern: /^\/google-calendar\/calendars\/[^/]+\/events(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-calendar/calendars/{calendarId}/events/.schema.json",
    createExample:
      "discovery/google-calendar/calendars/{calendarId}/events/.create.example.json",
  },
  {
    name: "acls",
    path: "/google-calendar/calendars/{calendarId}/acls",
    sampleIndexPath: "/google-calendar/acls",
    pathPattern: /^\/google-calendar\/calendars\/[^/]+\/acls(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-calendar/calendars/{calendarId}/acls/.schema.json",
    createExample:
      "discovery/google-calendar/calendars/{calendarId}/acls/.create.example.json",
  },
  {
    name: "watch-renewals",
    path: "/google-calendar/watch-renewals",
    pathPattern: /^\/google-calendar\/watch-renewals(?:\/[^/]+(?:\.json)?)?$/,
    idPattern: /^[A-Za-z0-9_.:+@-]+$/,
    schema: "discovery/google-calendar/watch-renewals/.schema.json",
    createExample: "discovery/google-calendar/watch-renewals/.create.example.json",
  },
];

const DOCKER_HUB_RESOURCES: readonly AdapterResourceConfig[] = [
  {
    name: "repositories",
    path: "/docker-hub/repositories",
    pathPattern: /^\/docker-hub\/repositories\/[^/]+\/[^/]+\.json$/,
    idPattern: /^[A-Za-z0-9_.:/@-]+$/,
    schema: "discovery/docker-hub/repositories/.schema.json",
    createExample: "discovery/docker-hub/repositories/.create.example.json",
  },
  {
    name: "tags",
    path: "/docker-hub/repositories/{namespace}/{repository}/tags",
    sampleIndexPath: "/docker-hub/tags",
    pathPattern: /^\/docker-hub\/repositories\/[^/]+\/[^/]+\/tags\/[^/]+\.json$/,
    idPattern: /^[A-Za-z0-9_.:/@-]+$/,
    schema:
      "discovery/docker-hub/repositories/{namespace}/{repository}/tags/.schema.json",
    createExample:
      "discovery/docker-hub/repositories/{namespace}/{repository}/tags/.create.example.json",
  },
  {
    name: "webhooks",
    path: "/docker-hub/repositories/{namespace}/{repository}/webhooks",
    sampleIndexPath: "/docker-hub/webhooks",
    pathPattern: /^\/docker-hub\/repositories\/[^/]+\/[^/]+\/webhooks\/[^/]+\.json$/,
    idPattern: /^[A-Za-z0-9_.:/@-]+$/,
    schema:
      "discovery/docker-hub/repositories/{namespace}/{repository}/webhooks/.schema.json",
    createExample:
      "discovery/docker-hub/repositories/{namespace}/{repository}/webhooks/.create.example.json",
  },
];

function googleMailLayoutPromptFile(): {
  path: string;
  contentType: string;
  content: string;
} {
  return {
    path: "/google-mail/LAYOUT.md",
    contentType: "text/markdown; charset=utf-8",
    content: `# Google Mail Mount Layout

Canonical records are JSON files under \`/google-mail\`.

Read these schemas before writeback:
- \`discovery/google-mail/labels/.schema.json\`
- \`discovery/google-mail/filters/.schema.json\`
- \`discovery/google-mail/send-as/.schema.json\`
- \`discovery/google-mail/messages/.schema.json\`
- \`discovery/google-mail/threads/.schema.json\`
- \`discovery/google-mail/watch-renewals/.schema.json\`
`,
  };
}

function googleCalendarLayoutPromptFile(): {
  path: string;
  contentType: string;
  content: string;
} {
  return {
    path: "/google-calendar/LAYOUT.md",
    contentType: "text/markdown; charset=utf-8",
    content: `# Google Calendar Mount Layout

Canonical records are JSON files under \`/google-calendar\`.

Read these schemas before writeback:
- \`discovery/google-calendar/calendars/.schema.json\`
- \`discovery/google-calendar/settings/.schema.json\`
- \`discovery/google-calendar/colors/{colorType}/.schema.json\`
- \`discovery/google-calendar/calendars/{calendarId}/events/.schema.json\`
- \`discovery/google-calendar/calendars/{calendarId}/acls/.schema.json\`
- \`discovery/google-calendar/watch-renewals/.schema.json\`
`,
  };
}

export type RecordWriteOutcome = "written" | "deleted" | "skipped";

export interface RelayfileWriteClient {
  readFile?(
    workspaceId: string,
    path: string,
    correlationId?: string,
    signal?: AbortSignal,
  ): Promise<{ content?: string; revision?: string } | string>;
  listTree?(
    workspaceId: string,
    options?: {
      path?: string;
      depth?: number;
      limit?: number;
      cursor?: string | null;
      correlationId?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    entries?: Array<{
      path?: string;
      name?: string;
      type?: string;
      kind?: string;
    }>;
  }>;
  writeFile(input: {
    workspaceId: string;
    path: string;
    content: string;
    contentType: string;
    encoding: "utf-8";
    baseRevision: "*";
    semantics?: FileSemantics;
  }): Promise<unknown>;
  bulkWrite?(input: {
    workspaceId: string;
    // The published SDK currently types this as upsert-only, but its runtime
    // transport forwards each file object verbatim. Keep this local transport
    // wide enough for Relayfile's backward-compatible per-file `op` extension.
    files: any[];
    correlationId?: string;
    signal?: AbortSignal;
  }): Promise<{
    written: number;
    errorCount?: number;
    errors: Array<{ path: string; code: string; message: string }>;
    // Relayfile returns the content-identity-deduped files separately from
    // `written`; both count toward "accounted for" when reconciling the batch.
    dedupedFiles?: Array<{ path: string }>;
    correlationId?: string;
  }>;
  deleteFile(input: {
    workspaceId: string;
    path: string;
    baseRevision: "*" | string;
  }): Promise<unknown>;
}

type BulkWriteMutation =
  | {
      op?: "upsert";
      path: string;
      dependsOn?: string[];
      content: string;
      contentType?: string;
      encoding: "utf-8" | "base64";
      semantics?: FileSemantics;
    }
  | {
      op: "delete";
      path: string;
      dependsOn?: string[];
      baseRevision: "*" | string;
    };

export interface BatchWriteResult {
  written: number;
  deleted: number;
  errors: number;
  checkpointOffset?: number;
  errorSamples?: BulkWriteErrorSample[];
}

export interface BulkWriteErrorSample {
  path: string;
  code: string;
  message: string;
  ownerOffsets: number[];
}

export interface BatchWriteOptions {
  concurrency?: number;
  materializeContract?: boolean;
  materializeAuxiliaryFiles?: boolean;
  startOffset?: number;
  shouldCheckpoint?: (nextOffset: number) => boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function readId(record: Record<string, unknown>, key = "id"): string {
  return readString(record, key)?.trim() ?? "";
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readFirstString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = readString(record, key)?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function readNestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isObject(value) ? value : null;
}

async function readTextFile(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<string | undefined> {
  if (!client.readFile) {
    return undefined;
  }

  try {
    const value = await client.readFile(workspaceId, path);
    if (typeof value === "string") {
      return value;
    }
    return value !== null && typeof value.content === "string"
      ? value.content
      : undefined;
  } catch {
    return undefined;
  }
}

async function readFileRevision(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<string | null> {
  if (!client.readFile) {
    return null;
  }
  try {
    const value = await client.readFile(workspaceId, path);
    if (typeof value === "string") {
      return null;
    }
    return value !== null &&
      typeof value.revision === "string" &&
      value.revision.length > 0
      ? value.revision
      : null;
  } catch (error) {
    if (isNotFoundLikeError(error)) {
      return null;
    }
    throw error;
  }
}

async function readJsonArray<T extends Record<string, unknown>>(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<T[]> {
  const content = await readTextFile(client, workspaceId, path);
  if (!content) {
    return [];
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is T => isObject(item))
      : [];
  } catch {
    return [];
  }
}

async function readRequiredJsonArray<T extends Record<string, unknown>>(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<T[] | null> {
  if (!client.readFile) {
    return null;
  }

  let content: string | undefined;
  try {
    const value = await client.readFile(workspaceId, path);
    content =
      typeof value === "string"
        ? value
        : value !== null && typeof value.content === "string"
          ? value.content
          : undefined;
  } catch (error) {
    if (isNotFoundLikeError(error)) {
      return null;
    }
    throw error;
  }

  if (!content?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("expected JSON array");
    }
    return parsed.filter((item): item is T => isObject(item));
  } catch (error) {
    throw new Error(`Invalid JSON array in ${path}: ${String(error)}`);
  }
}

async function readJsonObjectFile(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  const content = await readTextFile(client, workspaceId, path);
  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const PROVIDER_TIMESTAMP_KEYS = [
  "updated_at",
  "updatedAt",
  "last_edited_time",
  "lastEditedTime",
  "modified_at",
  "modifiedAt",
  "last_modified",
  "lastModified",
  "updated",
  "timestamp",
  "event_time",
  "eventTime",
  "closed_at",
  "closedAt",
  "merged_at",
  "mergedAt",
  "archived_at",
  "archivedAt",
  "completed_at",
  "completedAt",
  "resolved_at",
  "resolvedAt",
  "deleted_at",
  "deletedAt",
] as const;

async function isStaleProviderRecord(input: {
  client: RelayfileWriteClient;
  workspaceId: string;
  path: string;
  additionalPaths?: readonly string[];
  additionalRecords?: readonly (Record<string, unknown> | null | undefined)[];
  incoming: Record<string, unknown>;
}): Promise<boolean> {
  if (!input.client.readFile) {
    return false;
  }

  const incomingMs = extractProviderTimestampMs(input.incoming);
  if (incomingMs === null) {
    return false;
  }

  const records: Array<Record<string, unknown> | null | undefined> = [
    ...(input.additionalRecords ?? []),
  ];
  const paths = new Set([input.path, ...(input.additionalPaths ?? [])]);
  for (const path of paths) {
    records.push(await readJsonObjectFile(input.client, input.workspaceId, path));
  }

  return isStaleAgainstAnyProviderRecord(input.incoming, records);
}

function isStaleAgainstProviderRecord(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): boolean {
  const incomingMs = extractProviderTimestampMs(incoming);
  if (incomingMs === null) {
    return false;
  }

  const existingPayload = readNestedRecord(existing, "payload") ?? existing;
  const existingMs = extractProviderTimestampMs(existingPayload);
  return existingMs !== null && incomingMs < existingMs;
}

function isStaleAgainstAnyProviderRecord(
  incoming: Record<string, unknown>,
  existingRecords: readonly (Record<string, unknown> | null | undefined)[],
): boolean {
  return existingRecords.some(
    (existing) => existing !== null && existing !== undefined && isStaleAgainstProviderRecord(incoming, existing),
  );
}

function extractProviderTimestampMs(record: Record<string, unknown>): number | null {
  const value = findProviderTimestamp(record, 0, new Set());
  if (value === null) {
    const version = readNestedRecord(record, "version");
    const versionCreatedAt = version ? readFirstString(version, "createdAt", "created_at") : null;
    return versionCreatedAt ? parseProviderTimestampMs(versionCreatedAt) : null;
  }
  return parseProviderTimestampMs(value);
}

function findProviderTimestamp(
  record: Record<string, unknown>,
  depth: number,
  seen: Set<Record<string, unknown>>,
): string | number | null {
  if (seen.has(record) || depth > 4) {
    return null;
  }
  seen.add(record);

  for (const key of PROVIDER_TIMESTAMP_KEYS) {
    const raw = record[key];
    const value = typeof raw === "string" || typeof raw === "number" ? raw : null;
    if (value !== null && parseProviderTimestampMs(value) !== null) {
      return value;
    }
  }

  for (const value of Object.values(record)) {
    if (isObject(value)) {
      const nested = findProviderTimestamp(value, depth + 1, seen);
      if (nested !== null) {
        return nested;
      }
    }
  }

  return null;
}

function parseProviderTimestampMs(value: string | number): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value > 10_000_000_000 ? value : value * 1000;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/u.test(trimmed)) {
    return parseProviderTimestampMs(Number(trimmed));
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function readProviderTimestampString(
  record: Record<string, unknown>,
  ...fallbackKeys: string[]
): string | null {
  for (const key of [...PROVIDER_TIMESTAMP_KEYS, ...fallbackKeys]) {
    const raw = record[key];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (typeof raw === "number") {
      const parsed = parseProviderTimestampMs(raw);
      if (parsed !== null) return new Date(parsed).toISOString();
    }
  }
  return null;
}

async function writeManagedFile(input: {
  client: RelayfileWriteClient;
  workspaceId: string;
  path: string;
  content: string;
  contentType: string;
}): Promise<void> {
  const existing = await readTextFile(input.client, input.workspaceId, input.path);
  if (existing === input.content) {
    return;
  }

  await input.client.writeFile({
    workspaceId: input.workspaceId,
    path: input.path,
    content: input.content,
    contentType: input.contentType,
    encoding: "utf-8",
    baseRevision: "*",
  });
}

async function deleteManagedFile(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<void> {
  const currentRevision = await readFileRevision(client, workspaceId, path);
  if (!currentRevision && client.readFile) {
    const existing = await readTextFile(client, workspaceId, path);
    if (existing === undefined) {
      return;
    }
  }
  try {
    await client.deleteFile({
      workspaceId,
      path,
      baseRevision: currentRevision ?? "*",
    });
  } catch (error) {
    if (!isNotFoundLikeError(error)) {
      throw error;
    }
  }
}

function isNotFoundLikeError(error: unknown): boolean {
  if (!isObject(error)) {
    return false;
  }
  const response = isObject(error.response) ? error.response : undefined;
  const status = error.status ?? error.statusCode ?? response?.status;
  return status === 404;
}

export function stripNangoMetadata(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...record };
  delete payload._nango_metadata;
  return payload;
}

const JIRA_DUPLICATE_WEBHOOK_KEYS = new Set(["changelog", "issue", "user"]);

function looksLikeJiraUserRecord(value: Record<string, unknown>): boolean {
  return (
    hasOwn(value, "accountId") ||
    hasOwn(value, "account_id") ||
    hasOwn(value, "emailAddress") ||
    hasOwn(value, "email_address") ||
    (hasOwn(value, "displayName") &&
      (hasOwn(value, "avatarUrls") ||
        hasOwn(value, "timeZone") ||
        hasOwn(value, "self"))) ||
    (hasOwn(value, "display_name") &&
      (hasOwn(value, "avatar_urls") ||
        hasOwn(value, "timezone") ||
        hasOwn(value, "self")))
  );
}

function redactJiraPersonalDataValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJiraPersonalDataValue(item, parentKey));
  }

  if (!isObject(value)) {
    return value;
  }

  if (looksLikeJiraUserRecord(value)) {
    return null;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "changelog") {
      continue;
    }
    if (parentKey === "_webhook" && JIRA_DUPLICATE_WEBHOOK_KEYS.has(key)) {
      continue;
    }
    output[key] = redactJiraPersonalDataValue(child, key);
  }
  return output;
}

export function sanitizeJiraRecordForStorage(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const result = redactJiraPersonalDataValue(record);
  return isObject(result) ? result : {};
}

export function isDeletedNangoRecord(record: Record<string, unknown>): boolean {
  const metadata = record._nango_metadata;
  if (!isObject(metadata)) {
    return false;
  }

  const lastAction =
    typeof metadata.last_action === "string"
      ? metadata.last_action.toLowerCase()
      : "";
  return lastAction === "deleted" || typeof metadata.deleted_at === "string";
}

// Public helper for callers that need to drive the deletion branch of
// `writeProviderRecord` without having a full sync record on hand. The
// webhook-forward path uses this for hard-deletes (`page.deleted`) and
// soft-deletes (`archived` / `in_trash`) so it does not have to hand-build
// the synthetic `_nango_metadata` envelope and therefore stay in lockstep
// with `isDeletedNangoRecord` internals.
export function buildDeletionRecord(
  id: string,
  options: { deletedAt?: string } = {},
): Record<string, unknown> {
  return {
    id,
    _nango_metadata: {
      last_action: "deleted",
      deleted_at: options.deletedAt ?? new Date().toISOString(),
    },
  };
}

// Constructs a minimal but fully-typed `NangoSyncJob` for webhook-forward
// writers that don't actually run inside a Nango sync iteration. By going
// through this constructor (instead of casting an inline object literal) we
// surface any future required-field additions as a TS error at the call
// site rather than at runtime in `writeBatchToRelayfile`.
export function createWebhookSyncJob(input: {
  workspaceId: string;
  connectionId: string;
  providerConfigKey: string;
  provider: string;
  syncName: string;
  model: string;
}): NangoSyncJob {
  return {
    type: "nango_sync",
    provider: input.provider,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    syncName: input.syncName,
    model: input.model,
    modifiedAfter: "",
    cursor: null,
    workspaceId: input.workspaceId,
  };
}

export function parseGitHubRepoFromRecord(
  record: Record<string, unknown>,
): { owner: string; repo: string } | null {
  const candidates = [
    readString(record, "full_name"),
    readString(record, "url"),
    readString(record, "html_url"),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.hostname === "github.com") {
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (parts.length >= 2 && parts[0] && parts[1]) {
          return { owner: parts[0], repo: parts[1] };
        }
      }
    } catch {
      // Not a URL; try owner/repo below.
    }

    const parts = candidate.split("/", 2);
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  }

  return null;
}

function computeGitHubRecordPath(
  objectType: string,
  objectId: string,
  repoInfo: { owner: string; repo: string },
  record: Record<string, unknown>,
): string {
  if (objectType === "pull_request") {
    return githubPullRequestPath(
      repoInfo.owner,
      repoInfo.repo,
      objectId,
      readFirstString(record, "title", "name") ?? undefined,
    );
  }
  if (objectType === "issue") {
    return githubIssuePath(
      repoInfo.owner,
      repoInfo.repo,
      objectId,
      readFirstString(record, "title", "name") ?? undefined,
    );
  }
  if (objectType === "repository") {
    return githubRepositoryMetadataPath(repoInfo.owner, repoInfo.repo);
  }
  return computeGitHubPath(objectType, objectId, repoInfo);
}

type GitLabCloudObjectType =
  | "project"
  | "merge_requests"
  | "issues"
  | "commits"
  | "pipelines"
  | "deployments"
  | "tags"
  | "pipeline_jobs";

function normalizeGitLabModel(model: string): GitLabCloudObjectType {
  const normalized = model.trim().toLowerCase();
  switch (normalized) {
    case "gitlabproject":
    case "project":
      return "project";
    case "gitlabmergerequest":
    case "mergerequest":
    case "merge_request":
    case "merge_requests":
      return "merge_requests";
    case "gitlabissue":
    case "issue":
    case "issues":
      return "issues";
    case "gitlabcommit":
    case "commit":
    case "commits":
      return "commits";
    case "gitlabpipeline":
    case "pipeline":
    case "pipelines":
      return "pipelines";
    case "gitlabdeployment":
    case "deployment":
    case "deployments":
      return "deployments";
    case "gitlabtag":
    case "tag":
    case "tags":
      return "tags";
    case "gitlabpipelinejob":
    case "pipelinejob":
    case "pipeline_job":
    case "pipeline_jobs":
    case "job":
    case "jobs":
      return "pipeline_jobs";
    default:
      throw new Error(`Unsupported GitLab model: ${model}`);
  }
}

function parseGitLabProjectPathFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts =
      parsed.pathname.split("/-/")[0]?.split("/").filter(Boolean) ?? [];
    return parts.length >= 2 ? parts.join("/") : null;
  } catch {
    return null;
  }
}

function readGitLabProjectPath(record: Record<string, unknown>): string | null {
  const direct = readFirstString(
    record,
    "project_path",
    "projectPath",
    "path_with_namespace",
  );
  if (direct) return direct;

  const project = readNestedRecord(record, "project");
  const nested = project
    ? readFirstString(project, "path_with_namespace", "project_path", "projectPath")
    : null;
  if (nested) return nested;

  return parseGitLabProjectPathFromUrl(
    readFirstString(record, "web_url", "url"),
  );
}

function computeGitLabRecordPath(
  objectType: GitLabCloudObjectType,
  record: Record<string, unknown>,
): string {
  const projectPath = readGitLabProjectPath(record);
  if (!projectPath) {
    throw new Error("Missing GitLab project path context");
  }

  if (objectType === "project") {
    return `${gitLabProjectPrefix(projectPath)}/meta.json`;
  }

  if (objectType === "pipeline_jobs") {
    const pipelineId = readFirstString(record, "pipeline_id", "pipelineId");
    const jobId = readFirstString(record, "id", "job_id", "jobId");
    if (!pipelineId || !jobId) {
      throw new Error("Missing GitLab pipeline job id context");
    }
    return computeGitLabPipelineJobPath(
      projectPath,
      pipelineId,
      jobId,
      readFirstString(record, "ref"),
    );
  }

  const objectId = readGitLabObjectId(objectType, record);
  if (!objectId) {
    throw new Error(`Missing GitLab ${objectType} id`);
  }

  const title =
    objectType === "commits"
      ? readFirstString(record, "title", "message") ?? objectId.slice(0, 12)
      : objectType === "pipelines"
        ? readFirstString(record, "ref", "title", "name")
      : objectType === "tags"
        ? normalizeGitLabTagRef(readFirstString(record, "ref", "name") ?? objectId)
      : readFirstString(record, "title", "name") ?? objectId;

  if (objectType === "tags") {
    return computeGitLabTagMetadataPath(projectPath, objectId);
  }

  return computeGitLabMetadataPath(projectPath, objectType, objectId, title);
}

function readGitLabObjectId(
  objectType: GitLabCloudObjectType,
  record: Record<string, unknown>,
): string | null {
  if (objectType === "commits") {
    return readFirstString(record, "sha", "id");
  }
  if (objectType === "tags") {
    return readGitLabTagRef(record)?.id ?? null;
  }
  if (objectType === "pipelines" || objectType === "deployments") {
    return readFirstString(record, "id", "iid");
  }
  if (objectType === "pipeline_jobs") {
    return readFirstString(record, "id", "job_id", "jobId");
  }
  return readFirstString(record, "iid", "id");
}

function normalizeGitLabTagRef(ref: string): string {
  return ref.replace(/^refs\/tags\//u, "");
}

function readGitLabTagRef(record: Record<string, unknown>): { id: string; raw: string } | null {
  const rawNamedRef = readFirstString(record, "ref", "name");
  const raw = rawNamedRef ?? readFirstString(record, "id");
  if (!raw) return null;
  const tagRef = rawNamedRef ? raw : raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  const id = normalizeGitLabTagRef(tagRef);
  return id ? { id, raw: tagRef } : null;
}

function computeGitLabTagMetadataPath(projectPath: string, ref: string): string {
  return `${gitLabProjectPrefix(projectPath)}/tags/${gitLabFlatRecordFilename(ref)}.json`;
}

function computeGitLabTagByRefAliasPath(projectPath: string, ref: string): string {
  return `${gitLabProjectPrefix(projectPath)}/tags/by-ref/${gitLabFlatRecordFilename(ref)}.json`;
}

function computeLegacyGitLabTagMetadataPath(projectPath: string, ref: string): string {
  return `${gitLabProjectPrefix(projectPath)}/tags/${legacyGitLabTagFlatRecordFilename(ref)}`;
}

function computeLegacyGitLabTagByRefAliasPath(projectPath: string, ref: string): string {
  return `${gitLabProjectPrefix(projectPath)}/tags/by-ref/${legacyGitLabTagFlatRecordFilename(ref)}`;
}

function computeLegacyGitLabTagEncodedByRefAliasPath(projectPath: string, ref: string): string {
  return `${gitLabProjectPrefix(projectPath)}/tags/by-ref/${gitLabFlatRecordFilename(ref)}.json`;
}

function computeGitLabTagCleanupPaths(projectPath: string, id: string, raw?: string): string[] {
  const refs = [id, raw, `refs/tags/${id}`].filter(
    (ref): ref is string => typeof ref === "string" && ref.length > 0,
  );
  return [
    ...new Set(
      refs.flatMap((ref) => [
        computeGitLabTagMetadataPath(projectPath, ref),
        computeGitLabTagByRefAliasPath(projectPath, ref),
        computeLegacyGitLabTagMetadataPath(projectPath, ref),
        computeLegacyGitLabTagByRefAliasPath(projectPath, ref),
        computeLegacyGitLabTagEncodedByRefAliasPath(projectPath, ref),
      ]),
    ),
  ];
}

function gitLabFlatRecordFilename(value: string): string {
  const id = value.trim().replace(/\.json$/, "");
  const slug = slugifyGitLabAlias(id);
  if (!slug || slug === "untitled" || slug === id) {
    return encodeURIComponent(id);
  }
  return `${encodeURIComponent(slug)}__${encodeURIComponent(id)}`;
}

function legacyGitLabTagFlatRecordFilename(value: string): string {
  const id = value.trim().replace(/\.json$/, "");
  if (id.includes("__")) {
    return `${id}.json`;
  }
  return `${gitLabFlatRecordFilename(id)}.json`;
}

function slugifyGitLabAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    || "untitled";
}

const GITLAB_INDEXED_OBJECT_TYPES = new Set<GitLabCloudObjectType>([
  "merge_requests",
  "issues",
  "commits",
  "pipelines",
  "deployments",
  "tags",
]);

const GITLAB_BY_ID_ALIAS_OBJECT_TYPES = new Set<GitLabCloudObjectType>([
  "merge_requests",
  "issues",
  "commits",
  "pipelines",
]);

async function buildGitLabStaleCheckInputs(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  objectType: GitLabCloudObjectType,
  record: Record<string, unknown>,
): Promise<{
  staleCheckPaths?: readonly string[];
  staleCheckRecords?: readonly (Record<string, unknown> | null | undefined)[];
}> {
  if (!GITLAB_INDEXED_OBJECT_TYPES.has(objectType)) {
    return {};
  }

  const projectPath = readGitLabProjectPath(record);
  const objectId = readGitLabObjectId(objectType, record);
  if (!projectPath || !objectId) {
    return {};
  }

  const staleCheckPaths: string[] = [];
  if (GITLAB_BY_ID_ALIAS_OBJECT_TYPES.has(objectType)) {
    const aliasPath = gitLabByIdAliasPath(
      projectPath,
      objectType as GitLabIndexedResourceType,
      objectId,
    );
    staleCheckPaths.push(aliasPath);
    const alias = await readJsonObjectFile(client, job.workspaceId, aliasPath);
    const priorCanonicalPath = alias
      ? readFirstString(alias, "canonicalPath", "path")
      : null;
    if (priorCanonicalPath) {
      staleCheckPaths.push(priorCanonicalPath);
    }
  }

  const indexRow = await readIndexRowById(
    client,
    job.workspaceId,
    gitLabProjectResourceIndexPath(
      projectPath,
      objectType as GitLabIndexedResourceType,
    ),
    objectId,
  );

  return {
    staleCheckPaths,
    staleCheckRecords: indexRow ? [indexRow] : undefined,
  };
}

function gitLabProjectByIdAliasPath(projectId: string): string {
  return `/gitlab/projects/by-id/${encodeURIComponent(projectId)}.json`;
}

function isAdapterDeleteRecord(record: Record<string, unknown>): boolean {
  return record._deleted === true || isDeletedNangoRecord(record);
}

function readGitLabProjectUpdatedAt(record: Record<string, unknown>): string {
  return (
    readProviderTimestampString(record, "last_activity_at", "created_at") ??
    ""
  );
}

async function deleteGitLabProjectRecord(
  client: RelayfileWriteClient,
  cleaned: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const id = getRequiredId(cleaned);
  const aliasPath = gitLabProjectByIdAliasPath(id);
  const alias = await readJsonObjectFile(client, job.workspaceId, aliasPath);
  const aliasCanonical = alias
    ? readFirstString(alias, "canonicalPath", "path")
    : null;
  const canonicalPath =
    aliasCanonical ??
    (readGitLabProjectPath(cleaned)
      ? computeGitLabRecordPath("project", cleaned)
      : null);
  const projectPath =
    (alias ? readFirstString(alias, "projectPath", "path_with_namespace") : null) ??
    readGitLabProjectPath(cleaned);

  if (canonicalPath) {
    await deleteManagedFile(client, job.workspaceId, canonicalPath);
  }
  if (projectPath) {
    await removeGitLabProjectIndexRow(client, job.workspaceId, projectPath);
  }
  await deleteManagedFile(client, job.workspaceId, aliasPath);
  return "deleted";
}

async function removeGitLabProjectIndexRow(
  client: RelayfileWriteClient,
  workspaceId: string,
  projectPath: string,
): Promise<void> {
  const rows = await readJsonArray<{
    id: string;
    title: string;
    updated: string;
  }>(client, workspaceId, gitLabProjectsIndexPath());
  const nextRows = rows.filter((row) => row.id !== projectPath);
  if (nextRows.length === rows.length) return;

  const indexFile = buildGitLabProjectsIndexFile(nextRows);
  await writeManagedFile({
    client,
    workspaceId,
    path: indexFile.path,
    content: indexFile.content,
    contentType: indexFile.contentType,
  });
}

function getLinearRecordHumanReadable(
  objectType: string,
  record: Record<string, unknown>,
): string | undefined {
  const normalizedType = objectType.trim().toLowerCase();
  if (normalizedType === "issue") {
    return readFirstString(record, "identifier", "title") ?? undefined;
  }
  if (normalizedType === "comment") {
    const issue = readNestedRecord(record, "issue");
    return (
      readFirstString(record, "issue_identifier", "body") ??
      (issue ? readFirstString(issue, "identifier", "title") : null) ??
      undefined
    );
  }
  return undefined;
}

function getRecordObject(record: unknown): Record<string, unknown> {
  if (!isObject(record)) {
    throw new Error("Nango record must be an object");
  }
  return record;
}

function getRequiredId(
  record: Record<string, unknown>,
  label = "record id",
): string {
  const id = readId(record);
  if (!id) {
    throw new Error(`Missing ${label}`);
  }
  return id;
}

async function writeJsonOrDelete(input: {
  client: RelayfileWriteClient;
  job: NangoSyncJob;
  raw: Record<string, unknown>;
  cleaned: Record<string, unknown>;
  path: string;
  semantics?: FileSemantics;
  staleCheckPaths?: readonly string[];
  staleCheckRecords?: readonly (Record<string, unknown> | null | undefined)[];
  skipIfUnchanged?: boolean;
  stableProjection?: (record: Record<string, unknown>) => unknown;
  dedupLogContext?: {
    provider: string;
    model: string;
  };
}): Promise<RecordWriteOutcome> {
  if (
    await isStaleProviderRecord({
      client: input.client,
      workspaceId: input.job.workspaceId,
      path: input.path,
      additionalPaths: input.staleCheckPaths,
      additionalRecords: input.staleCheckRecords,
      incoming: input.raw,
    })
  ) {
    return "skipped";
  }

  if (isDeletedNangoRecord(input.raw)) {
    await deleteManagedFile(input.client, input.job.workspaceId, input.path);
    return "deleted";
  }

  const content = JSON.stringify(input.cleaned);
  if (input.skipIfUnchanged === true) {
    const existingText = await readTextFile(input.client, input.job.workspaceId, input.path);
    if (existingText === content) {
      logDedupSkip(input, "byte-identical");
      return "skipped";
    }
    if (
      input.stableProjection &&
      stableProjectionMatches(existingText, input.cleaned, input.stableProjection)
    ) {
      logDedupSkip(input, "stable-projection");
      return "skipped";
    }
  }

  await input.client.writeFile({
    workspaceId: input.job.workspaceId,
    path: input.path,
    content,
    contentType: "application/json; charset=utf-8",
    encoding: "utf-8",
    baseRevision: "*",
    ...(input.semantics ? { semantics: input.semantics } : {}),
  });
  return "written";
}

function stableProjectionMatches(
  existingText: string | undefined,
  incomingRecord: Record<string, unknown>,
  projection: (record: Record<string, unknown>) => unknown,
): boolean {
  if (existingText === undefined) return false;
  let existing: unknown;
  try {
    existing = JSON.parse(existingText);
  } catch {
    return false;
  }
  if (!isObject(existing)) return false;
  return stableJson(projection(existing)) === stableJson(projection(incomingRecord));
}

function logDedupSkip(
  input: {
    job: NangoSyncJob;
    path: string;
    dedupLogContext?: {
      provider: string;
      model: string;
    };
  },
  dedupKind: "byte-identical" | "stable-projection",
): void {
  if (!input.dedupLogContext) return;
  console.info("[record-writer] provider write skipped unchanged", {
    area: "nango-sync-worker",
    provider: input.dedupLogContext.provider,
    model: input.dedupLogContext.model,
    syncName: input.job.syncName,
    workspaceId: input.job.workspaceId,
    path: input.path,
    dedupKind,
  });
}

async function writeMarkdownOrDelete(input: {
  client: RelayfileWriteClient;
  job: NangoSyncJob;
  raw: Record<string, unknown>;
  path: string;
  markdown: string;
}): Promise<RecordWriteOutcome> {
  if (
    await isStaleProviderRecord({
      client: input.client,
      workspaceId: input.job.workspaceId,
      path: input.path,
      incoming: input.raw,
    })
  ) {
    return "skipped";
  }

  if (isDeletedNangoRecord(input.raw)) {
    await deleteManagedFile(input.client, input.job.workspaceId, input.path);
    return "deleted";
  }

  await input.client.writeFile({
    workspaceId: input.job.workspaceId,
    path: input.path,
    content: input.markdown,
    // Markdown body — not JSON. Workspace subscribers (e.g. cortical-demo's
    // `onWrite('/notion/pages/*/content.md')` trigger) discriminate on
    // contentType, so we must emit `text/markdown` here rather than letting
    // the JSON code path stringify the whole record.
    contentType: "text/markdown; charset=utf-8",
    encoding: "utf-8",
    baseRevision: "*",
  });
  return "written";
}

async function writeGitHubRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  const repoInfo = parseGitHubRepoFromRecord(cleaned);
  if (!repoInfo) {
    throw new Error("Missing GitHub repository context");
  }

  const objectType = normalizeNangoGitHubModel(job.model);
  let objectId: string;

  if (objectType === "repository") {
    objectId = `${repoInfo.owner}/${repoInfo.repo}`;
  } else if (objectType === "pull_request" || objectType === "issue") {
    const number = typeof cleaned.number === "number" ? cleaned.number : null;
    if (!number) {
      throw new Error(`Missing GitHub ${objectType} number`);
    }
    objectId = String(number);
  } else {
    objectId = getRequiredId(cleaned);
  }

  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeGitHubRecordPath(objectType, objectId, repoInfo, cleaned),
    staleCheckPaths:
      objectType === "issue" || objectType === "pull_request"
        ? [
            githubByIdAliasPath(
              repoInfo.owner,
              repoInfo.repo,
              objectType === "issue" ? "issues" : "pulls",
              objectId,
            ),
          ]
        : undefined,
  });
}

async function writeGitLabRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  const objectType = normalizeGitLabModel(job.model);
  if (objectType === "project" && isDeletedNangoRecord(raw)) {
    return deleteGitLabProjectRecord(client, cleaned, job);
  }

  const staleCheckInputs = await buildGitLabStaleCheckInputs(
    client,
    job,
    objectType,
    cleaned,
  );
  const path = computeGitLabRecordPath(objectType, cleaned);

  if (
    await isStaleProviderRecord({
      client,
      workspaceId: job.workspaceId,
      path,
      additionalPaths: staleCheckInputs.staleCheckPaths,
      additionalRecords: staleCheckInputs.staleCheckRecords,
      incoming: raw,
    })
  ) {
    return "skipped";
  }

  if (objectType === "pipelines" || objectType === "deployments") {
    await deletePriorGitLabStatusAlias(client, job, objectType, cleaned, raw, path);
  }

  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path,
  });
}

async function deletePriorGitLabStatusAlias(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  objectType: "pipelines" | "deployments",
  cleaned: Record<string, unknown>,
  raw: Record<string, unknown>,
  canonicalPath: string,
): Promise<void> {
  const projectPath = readGitLabProjectPath(cleaned);
  const id = readGitLabObjectId(objectType, cleaned);
  if (!projectPath || !id) {
    return;
  }

  const prior = await readJsonObjectFile(client, job.workspaceId, canonicalPath);
  const priorStatus = prior ? readFirstString(prior, "status") : null;
  if (!priorStatus) {
    return;
  }

  const nextStatus = readFirstString(cleaned, "status");
  if (!isDeletedNangoRecord(raw) && priorStatus === nextStatus) {
    return;
  }

  await deleteManagedFile(
    client,
    job.workspaceId,
    gitLabByStatusAliasPath(projectPath, objectType, priorStatus, id),
  );
}

async function writeLinearRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  const id = getRequiredId(cleaned);
  // Translate the Nango sync `model` (e.g. "LinearTeam") to the canonical
  // path-mapper object type before computing the path. `computeLinearPath`
  // alone only accepts canonical types — it would throw on the PascalCase
  // model names that Nango emits.
  const objectType = normalizeNangoLinearModel(job.model);
  const path = computeLinearPath(
    objectType,
    id,
    getLinearRecordHumanReadable(objectType, cleaned),
  );
  const staleCheckPaths =
    objectType === "issue"
      ? [linearByUuidAliasPath(`${LINEAR_PATH_ROOT}/issues`, id)]
      : undefined;
  const staleCheckRecords =
    objectType === "comment"
      ? [
          await readIndexRowById(
            client,
            job.workspaceId,
            linearCommentsIndexPath(),
            id,
          ),
        ]
      : undefined;

  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path,
    staleCheckPaths,
    staleCheckRecords,
    semantics: buildLinearSyncSemantics(job.model, id, cleaned, {
      connectionId: job.connectionId,
      model: job.model,
      providerConfigKey: job.providerConfigKey,
      syncName: job.syncName,
    }),
  });
}

// Local model→object-type resolver. The installed `@relayfile/adapter-notion`
// version does not yet alias `NotionPageContent` (the `fetch-page-content`
// sync's record model) or `NotionUser` (Nango user sync, gated on
// `users:read` scope) onto adapter object types, so we map them locally to
// avoid a release-coupled rollout. Keep parity with `NANGO_MODEL_MAP` in
// `@relayfile/adapter-notion/path-mapper`.
type NotionExtendedObjectType = NotionPathObjectType | "user";

function resolveNotionObjectType(model: string): NotionExtendedObjectType {
  if (model === "NotionPageContent") {
    return "page_content";
  }
  if (model === "NotionUser" || model.trim().toLowerCase() === "notionuser") {
    return "user";
  }
  return normalizeNangoNotionModel(model);
}

async function writeNotionRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  const id = getRequiredId(cleaned);
  const objectType = resolveNotionObjectType(job.model);

  // Use id-stable paths. Notion `title` and database titles are mutable — if
  // we slugged them into the path, renames would write a new file while
  // leaving the old slug behind, and the Nango delete event (which carries
  // only `{ id }`) can only remove the current path, leaving the renamed
  // orphan forever. The path-mapper helpers fall back to the encoded id when
  // title is omitted, so the resulting paths are unambiguous and rename-safe.
  if (objectType === "page_content") {
    // `NotionPageContent` records carry the rendered markdown in `content`.
    // Write the body as `text/markdown` so onWrite subscribers see a
    // markdown file (not a JSON envelope wrapping the markdown).
    const markdown = typeof cleaned.content === "string" ? cleaned.content : "";
    return writeMarkdownOrDelete({
      client,
      job,
      raw,
      path: notionStandalonePageContentPath(id),
      markdown,
    });
  }

  let path: string;
  if (objectType === "page") {
    path = notionStandalonePagePath(id);
  } else if (objectType === "database") {
    // `notionDatabaseMetadataPath` resolves to
    // `/notion/databases/<id>/metadata.json` when no title is supplied, which
    // matches the `NotionDatabase` records emitted by the `notion-relay`
    // `fetch-databases` sync (id-stable, rename-safe).
    path = notionDatabaseMetadataPath(id);
  } else if (objectType === "user") {
    // Notion users: canonical record at the id-only path `/notion/users/<id>.json`.
    // A name-derived `<slug>__<id>.json` would change on every rename — a delete
    // tombstone that only carries `{ id, _nango_metadata }` would compute a
    // different path and leave the previous canonical file as an orphan. The
    // id-only form is stable across renames; the by-name aliases emitted by
    // `writeNotionAuxiliaryFiles` provide the human-readable lookup surface.
    path = notionUserPath(id);
  } else {
    throw new Error(
      `Notion sync model "${job.model}" is not yet supported for writeback`,
    );
  }

  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path,
  });
}

function normalizeNangoJiraModel(model: string): JiraPathObjectType {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("comment")) {
    return "comment";
  }
  if (normalized.includes("project")) {
    return "project";
  }
  if (normalized.includes("sprint")) {
    return "sprint";
  }
  if (normalized.includes("issue")) {
    return "issue";
  }
  return normalizeJiraObjectType(normalized);
}

function getJiraObjectId(
  record: Record<string, unknown>,
  objectType: JiraPathObjectType,
): string {
  if (objectType === "issue") {
    return readId(record) || readId(record, "key");
  }
  return readId(record);
}

function getJiraRecordTitle(
  record: Record<string, unknown>,
  objectType: JiraPathObjectType,
): string | undefined {
  if (objectType === "issue") {
    const fields = isObject(record.fields) ? record.fields : {};
    return readString(fields, "summary") ??
      readString(record, "key") ??
      undefined;
  }
  if (objectType === "project") {
    return readString(record, "name") ?? readString(record, "key") ?? undefined;
  }
  if (objectType === "sprint") {
    return readString(record, "name") ?? undefined;
  }
  if (objectType === "comment") {
    const issue = isObject(record.issue) ? record.issue : {};
    return (
      readString(record, "issueKey") ??
      readString(record, "issue_key") ??
      readString(issue, "key") ??
      readString(record, "issueId") ??
      readString(record, "issue_id") ??
      readString(issue, "id") ??
      undefined
    );
  }
  return undefined;
}

function buildJiraSyncSemantics(
  objectType: JiraPathObjectType,
  objectId: string,
  record: Record<string, unknown>,
  context: {
    connectionId: string;
    model: string;
    providerConfigKey: string;
    syncName: string;
  },
): FileSemantics {
  const properties: Record<string, string> = {
    provider: "jira",
    "provider.object_id": objectId,
    "provider.object_type": objectType,
    "jira.id": objectId,
    "jira.object_type": objectType,
    "nango.connection_id": context.connectionId,
    "nango.model": context.model,
    "nango.provider_config_key": context.providerConfigKey,
    "nango.sync_name": context.syncName,
  };

  if (objectType === "issue") {
    const fields = isObject(record.fields) ? record.fields : {};
    const status = isObject(fields.status) ? fields.status : {};
    const project = isObject(fields.project) ? fields.project : {};
    const summary = readString(fields, "summary");
    if (summary) properties["jira.summary"] = summary;
    const issueKey = readString(record, "key");
    if (issueKey) properties["jira.issue_key"] = issueKey;
    const statusName = readString(status, "name");
    if (statusName) properties["jira.status_name"] = statusName;
    const projectKey = readString(project, "key");
    if (projectKey) properties["jira.project_key"] = projectKey;
  } else if (objectType === "project") {
    const key = readString(record, "key");
    if (key) properties["jira.project_key"] = key;
    const name = readString(record, "name");
    if (name) properties["jira.name"] = name;
  } else if (objectType === "sprint") {
    const name = readString(record, "name");
    if (name) properties["jira.name"] = name;
    const state = readString(record, "state");
    if (state) properties["jira.state"] = state;
  } else if (objectType === "comment") {
    const issue = isObject(record.issue) ? record.issue : {};
    const issueKey =
      readString(issue, "key") ??
      readString(record, "issueKey") ??
      readString(record, "issue_key") ??
      readString(record, "key");
    if (issueKey) properties["jira.issue_key"] = issueKey;
  }

  return { properties };
}

// The Nango `confluence-relay` integration emits records under
// PascalCase model names (`ConfluencePage`, `ConfluenceSpace`). The
// adapter's `normalizeConfluenceObjectType` already accepts those aliases
// (see `OBJECT_TYPE_ALIASES` in
// `@relayfile/adapter-confluence/path-mapper`), so we just delegate.
function normalizeNangoConfluenceModel(model: string): ConfluencePathObjectType {
  return adapterNormalizeConfluenceObjectType(model);
}

function getConfluenceRecordTitle(
  record: Record<string, unknown>,
  objectType: ConfluencePathObjectType,
): string | undefined {
  if (objectType === "space") {
    return readString(record, "name") ?? readString(record, "title") ?? undefined;
  }
  return readString(record, "title") ?? undefined;
}

function getConfluenceObjectId(
  record: Record<string, unknown>,
  objectType: ConfluencePathObjectType,
): string {
  if (objectType === "space") {
    // Spaces may carry both a numeric `id` and a human-facing `key`. Prefer
    // `id` (the adapter slugs the name in front of it via `__id`) and fall
    // back to `key` so legacy records without `id` keep working.
    return readId(record) || readId(record, "key");
  }
  return readId(record);
}

function buildConfluenceSyncSemantics(
  objectType: ConfluencePathObjectType,
  objectId: string,
  record: Record<string, unknown>,
  context: {
    connectionId: string;
    model: string;
    providerConfigKey: string;
    syncName: string;
  },
): FileSemantics {
  const properties: Record<string, string> = {
    provider: "confluence",
    "provider.object_id": objectId,
    "provider.object_type": objectType,
    "confluence.id": objectId,
    "confluence.object_type": objectType,
    "nango.connection_id": context.connectionId,
    "nango.model": context.model,
    "nango.provider_config_key": context.providerConfigKey,
    "nango.sync_name": context.syncName,
  };

  const title = readString(record, "title") ?? readString(record, "name");
  if (title) properties["confluence.title"] = title;
  const spaceId = readString(record, "spaceId");
  if (spaceId) properties["confluence.space_id"] = spaceId;
  const key = readString(record, "key");
  if (key) properties["confluence.space_key"] = key;
  const status = readString(record, "status");
  if (status) properties["confluence.status"] = status;

  return { properties };
}

// ---------------------------------------------------------------------------
// Canonical-write reconciliation helpers.
//
// These remain in cloud because the canonical-path rename cleanup is a
// cloud-side concern: when a Jira issue's summary or a Confluence page's
// title/space changes, the legacy canonical file at the old path must be
// deleted so callers don't see the record duplicated under two slugs. The
// adapter packages own auxiliary (alias/index) emission, but the canonical
// file path is composed by cloud's `writeXRecord` and the previous path is
// recovered by reading the by-id alias the adapter previously wrote.
//
// Kept tight: only the alias-context fields cloud's canonical writers
// actually consult on rename (`title`, `summary`, `spaceId`, `key`). The
// adapter is the source of truth for alias *paths*; cloud just dereferences
// them by id.
// ---------------------------------------------------------------------------

type IndexRow = {
  id: string;
  title: string;
  updated: string;
  [key: string]: unknown;
};

async function readIndexRowById(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
  id: string,
): Promise<IndexRow | null> {
  const rows = await readJsonArray<IndexRow>(client, workspaceId, path);
  return rows.find((row) => row.id === id) ?? null;
}

function isDeletedRecord(record: Record<string, unknown>): boolean {
  return isDeletedNangoRecord(record);
}

const JIRA_CANONICAL_PATH_ROOT = "/jira";

function jiraIssuesIndexPath(): string {
  return `${JIRA_CANONICAL_PATH_ROOT}/issues/_index.json`;
}

function jiraIssueByIdAliasPath(id: string): string {
  return `${JIRA_CANONICAL_PATH_ROOT}/issues/by-id/${encodeURIComponent(id)}.json`;
}

async function readJiraIssueAliasContext(input: {
  client: RelayfileWriteClient;
  workspaceId: string;
  id: string;
  cleaned: Record<string, unknown>;
}): Promise<{
  existingAlias: Record<string, unknown> | null;
  indexRow: IndexRow | null;
  key: string | null;
  status: string | null;
  summary: string | null;
}> {
  const indexRow = await readIndexRowById(
    input.client,
    input.workspaceId,
    jiraIssuesIndexPath(),
    input.id,
  );
  const existingAlias = await readJsonObjectFile(
    input.client,
    input.workspaceId,
    jiraIssueByIdAliasPath(input.id),
  );
  const aliasFields =
    existingAlias && isObject(existingAlias.fields) ? existingAlias.fields : null;
  const aliasStatusObject =
    aliasFields && isObject(aliasFields.status) ? aliasFields.status : null;
  return {
    existingAlias,
    indexRow,
    key:
      readFirstString(input.cleaned, "key") ??
      (existingAlias ? readFirstString(existingAlias, "key") : null) ??
      (indexRow ? readFirstString(indexRow, "key") : null),
    status:
      (aliasStatusObject ? readFirstString(aliasStatusObject, "name") : null) ??
      (indexRow ? readFirstString(indexRow, "status") : null),
    summary:
      (aliasFields ? readFirstString(aliasFields, "summary") : null) ??
      (indexRow ? readFirstString(indexRow, "title") : null),
  };
}

function readConfluencePageStatus(
  record: Record<string, unknown> | null,
): string | null {
  if (!record) return null;
  return readFirstString(record, "status");
}

async function readConfluencePageAliasContext(input: {
  client: RelayfileWriteClient;
  workspaceId: string;
  id: string;
  cleaned: Record<string, unknown>;
}): Promise<{
  existingAlias: Record<string, unknown> | null;
  indexRow: IndexRow | null;
  title: string | null;
  spaceId: string | null;
  status: string | null;
  parentId: string | null;
}> {
  const indexRow = await readIndexRowById(
    input.client,
    input.workspaceId,
    confluencePagesIndexPath(),
    input.id,
  );
  const existingAlias = await readJsonObjectFile(
    input.client,
    input.workspaceId,
    confluencePageByIdAliasPath(input.id),
  );
  return {
    existingAlias,
    indexRow,
    title:
      readFirstString(input.cleaned, "title") ??
      (existingAlias ? readFirstString(existingAlias, "title") : null) ??
      (indexRow ? readFirstString(indexRow, "title") : null),
    spaceId:
      readString(input.cleaned, "spaceId") ??
      readString(input.cleaned, "space_id") ??
      (existingAlias ? readString(existingAlias, "spaceId") : null) ??
      (existingAlias ? readString(existingAlias, "space_id") : null) ??
      (indexRow ? readString(indexRow, "spaceId") : null),
    status:
      readConfluencePageStatus(input.cleaned) ??
      (existingAlias ? readConfluencePageStatus(existingAlias) : null) ??
      (indexRow ? readFirstString(indexRow, "status") : null),
    parentId:
      readFirstString(input.cleaned, "parentId", "parent_id") ??
      (existingAlias ? readFirstString(existingAlias, "parentId", "parent_id") : null),
  };
}

async function writeJiraRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  const safe = sanitizeJiraRecordForStorage(cleaned);
  const objectType = normalizeNangoJiraModel(job.model);
  const objectId = getJiraObjectId(cleaned, objectType);
  if (!objectId) {
    throw new Error(`Missing Jira ${objectType} id`);
  }

  const title = getJiraRecordTitle(cleaned, objectType);
  const path = computeJiraPath(objectType, objectId, title);
  const previousContext =
    objectType === "issue"
      ? await readJiraIssueAliasContext({
          client,
          workspaceId: job.workspaceId,
          id: objectId,
          cleaned: { id: objectId },
        })
      : null;

  if (
    previousContext &&
    isStaleAgainstAnyProviderRecord(raw, [
      previousContext.existingAlias,
      previousContext.indexRow,
    ])
  ) {
    return "skipped";
  }

  // For issue updates (not deletes), clean up the previous canonical
  // path if the title slug changed. Writes alone would leave the old
  // file behind. Skipped for delete tombstones — alias-artifact sweep
  // in writeJiraAuxiliaryFiles handles those.
  if (objectType === "issue" && !isDeletedRecord(raw) && previousContext) {
    const previousTitle = previousContext.summary ?? previousContext.key;
    if (previousTitle && previousTitle !== title) {
      const previousPath = computeJiraPath(objectType, objectId, previousTitle);
      if (previousPath !== path) {
        await deleteManagedFile(client, job.workspaceId, previousPath);
      }
    }
  }

  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned: safe,
    path,
    semantics: buildJiraSyncSemantics(objectType, objectId, safe, {
      connectionId: job.connectionId,
      model: job.model,
      providerConfigKey: job.providerConfigKey,
      syncName: job.syncName,
    }),
  });
}

async function writeConfluenceRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  const objectType = normalizeNangoConfluenceModel(job.model);
  const objectId = getConfluenceObjectId(cleaned, objectType);
  if (!objectId) {
    throw new Error(`Missing Confluence ${objectType} id`);
  }

  const title = getConfluenceRecordTitle(cleaned, objectType);
  const spaceId =
    objectType === "page"
      ? readString(cleaned, "spaceId") ?? readString(cleaned, "space_id") ?? undefined
      : undefined;

  const path =
    objectType === "space"
      ? confluenceSpacePath(objectId, title)
      : confluencePagePath(objectId, title, spaceId ?? undefined);
  const previousContext =
    objectType === "page"
      ? await readConfluencePageAliasContext({
          client,
          workspaceId: job.workspaceId,
          id: objectId,
          cleaned: { id: objectId },
        })
      : null;

  if (
    previousContext &&
    isStaleAgainstAnyProviderRecord(raw, [
      previousContext.existingAlias,
      previousContext.indexRow,
    ])
  ) {
    return "skipped";
  }

  // For pages on update (not delete), clean up the previous canonical
  // path if the title or spaceId moved. Writes alone would leave the
  // old file behind. Skipped for delete tombstones — the alias-artifact
  // sweep in writeConfluenceAuxiliaryFiles handles those.
  if (objectType === "page" && !isDeletedRecord(raw) && previousContext) {
    if (
      previousContext.title &&
      (previousContext.title !== title ||
        (previousContext.spaceId ?? undefined) !== spaceId)
    ) {
      const previousPath = confluencePagePath(
        objectId,
        previousContext.title,
        previousContext.spaceId ?? undefined,
      );
      if (previousPath !== path) {
        await deleteManagedFile(client, job.workspaceId, previousPath);
      }
    }
  }

  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path,
    semantics: buildConfluenceSyncSemantics(objectType, objectId, cleaned, {
      connectionId: job.connectionId,
      model: job.model,
      providerConfigKey: job.providerConfigKey,
      syncName: job.syncName,
    }),
  });
}

function computeHubSpotRecordPath(record: Record<string, unknown>, model: string): string {
  const id = readString(record, "id");
  if (!id) {
    throw new Error(`HubSpot ${model} record missing id`);
  }
  return computeHubSpotPath(normalizeNangoHubSpotModel(model), id);
}

async function writeHubSpotRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeHubSpotRecordPath(cleaned, job.model),
  });
}

function readOptionalNameField(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function warnBareSlackChannelMessagePath(input: {
  model: string;
  channelId: string;
  ts: string;
  threadTs?: string;
  path: string;
}): void {
  console.warn("[record-writer] Slack channel message missing channelName; writing bare path", {
    provider: "slack",
    model: input.model,
    channelId: input.channelId,
    ts: input.ts,
    threadTs: input.threadTs,
    path: input.path,
  });
}

function computeSlackRecordPath(
  cleaned: Record<string, unknown>,
  model: string,
): string {
  const normalizedModel = model.trim().toLowerCase();

  if (normalizedModel === "slackmessage" || normalizedModel === "message") {
    const channelId = readId(cleaned, "channel");
    const ts = readId(cleaned, "ts");
    if (!channelId || !ts) {
      throw new Error("Missing Slack message channel or timestamp");
    }

    // Live Slack forwards attach channelName from the channel index so the
    // primary file row uses the same suffixed channel segment as fs/tree.
    // The fs/events row is derived from this path, so falling back to a bare
    // channel id here makes mounted thread roots drop the event.
    const channelName = readOptionalNameField(
      cleaned,
      "channelName",
      "channel_name",
    );
    const text = readOptionalNameField(cleaned, "text");
    const threadTs = readId(cleaned, "thread_ts");
    const replyCount =
      typeof cleaned.reply_count === "number" ? cleaned.reply_count : 0;
    const directMessageUserId = readId(cleaned, "dm_user_id");

    if (directMessageUserId) {
      if (threadTs && threadTs !== ts) {
        return directMessageThreadReplyPath(directMessageUserId, threadTs, ts);
      }
      return directMessagePath(directMessageUserId, threadTs || ts);
    }

    let path: string;
    if (threadTs && threadTs !== ts) {
      path = threadReplyPath(channelId, threadTs, ts, channelName);
    } else if (threadTs === ts || replyCount > 0) {
      path = threadPath(channelId, threadTs || ts, channelName);
    } else {
      path = messagePath(channelId, ts, text, channelName);
    }

    if (!channelName) {
      warnBareSlackChannelMessagePath({
        model,
        channelId,
        ts,
        threadTs: threadTs || undefined,
        path,
      });
    }
    return path;
  }

  if (normalizedModel === "slackuser" || normalizedModel === "user") {
    const userId = readId(cleaned);
    if (!userId) {
      throw new Error("Missing Slack user id");
    }
    // User records carry display name fields; pass the best available so the
    // canonical directory becomes `<userId>__<username>` instead of bare id.
    const userName = readOptionalNameField(
      cleaned,
      "name",
      "real_name",
      "display_name",
    );
    return userMetadataPath(userId, userName);
  }

  if (normalizedModel === "slackchannel" || normalizedModel === "channel") {
    const channelId = readId(cleaned);
    if (!channelId) {
      throw new Error("Missing Slack channel id");
    }
    // Channel records carry the channel name as `name`. With the v2 path
    // helper we land at `<channelId>__<channelName>/meta.json` so the live
    // tree is human-navigable: `ls /slack/channels` shows the names.
    const channelName = readOptionalNameField(cleaned, "name", "name_normalized");
    return channelMetadataPath(channelId, channelName);
  }

  const id = getRequiredId(cleaned);
  const slackObjectType = normalizedModel.startsWith("slack")
    ? normalizedModel.slice(5)
    : normalizedModel;
  return computeSlackPath(slackObjectType, id);
}

async function writeSlackRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeSlackRecordPath(cleaned, job.model),
    skipIfUnchanged: true,
    stableProjection: slackStableProjection,
    dedupLogContext: {
      provider: "slack",
      model: job.model,
    },
  });
}

function isSlackProvider(provider: string): boolean {
  return provider.trim().toLowerCase().startsWith("slack");
}

function slackStableProjection(record: Record<string, unknown>): unknown {
  const webhook = readNestedRecord(record, "_webhook");
  const nangoMetadata = readNestedRecord(record, "_nango_metadata");
  return {
    ...record,
    ...(webhook
      ? {
          _webhook: {
            ...webhook,
            receivedAt: undefined,
            received_at: undefined,
          },
        }
      : {}),
    ...(nangoMetadata
      ? {
          _nango_metadata: {
            ...nangoMetadata,
            deleted_at: undefined,
          },
        }
      : {}),
  };
}

function readTelegramNestedMessage(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  return (
    readNestedRecord(record, "message") ??
    readNestedRecord(record, "edited_message") ??
    readNestedRecord(record, "channel_post") ??
    readNestedRecord(record, "edited_channel_post") ??
    readNestedRecord(record, "business_message") ??
    readNestedRecord(record, "edited_business_message") ??
    readNestedRecord(record, "guest_message")
  );
}

function readTelegramChatRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const direct = readNestedRecord(record, "chat");
  if (direct) return direct;
  const nestedMessage = readTelegramNestedMessage(record);
  return nestedMessage ? readNestedRecord(nestedMessage, "chat") : null;
}

function readTelegramChatId(record: Record<string, unknown>): string | null {
  const chat = readTelegramChatRecord(record);
  return (
    readFirstString(record, "chatId", "chat_id") ??
    (chat ? readFirstString(chat, "id") : null)
  );
}

function readTelegramChatTitle(record: Record<string, unknown>): string | undefined {
  const chat = readTelegramChatRecord(record);
  const title =
    readFirstString(record, "chatTitle", "title", "username") ??
    (chat
      ? readFirstString(chat, "title", "username", "first_name", "last_name")
      : null);
  return title ?? undefined;
}

function readTelegramMessageId(record: Record<string, unknown>): string | null {
  const nestedMessage = readTelegramNestedMessage(record);
  const direct =
    readFirstString(record, "messageId", "message_id") ??
    (nestedMessage ? readFirstString(nestedMessage, "messageId", "message_id") : null);
  if (direct) return direct;

  const id = readId(record);
  const parts = id.split(":");
  return parts.length >= 2 && parts[1] ? parts[1] : null;
}

function readTelegramThreadId(record: Record<string, unknown>): string | null {
  const nestedMessage = readTelegramNestedMessage(record);
  return (
    readFirstString(record, "messageThreadId", "message_thread_id", "threadId") ??
    (nestedMessage
      ? readFirstString(nestedMessage, "messageThreadId", "message_thread_id", "threadId")
      : null)
  );
}

function computeTelegramRecordPath(
  record: Record<string, unknown>,
  model: string,
): string {
  const normalizedModel = model.trim().toLowerCase();
  const id = readId(record);

  if (normalizedModel === "telegrambotconfig" || normalizedModel === "bot-config" || normalizedModel === "botconfig") {
    return telegramBotConfigPath();
  }

  if (normalizedModel === "telegramchat" || normalizedModel === "chat") {
    const chatId = readTelegramChatId(record) ?? id;
    if (!chatId) {
      throw new Error("Missing Telegram chat id");
    }
    return telegramChatMetadataPath(chatId, readTelegramChatTitle(record));
  }

  if (normalizedModel === "telegrammessage" || normalizedModel === "message") {
    const chatId = readTelegramChatId(record);
    const messageId = readTelegramMessageId(record);
    if (!chatId || !messageId) {
      throw new Error("Missing Telegram message chat id or message id");
    }
    const threadId = readTelegramThreadId(record);
    const chatTitle = readTelegramChatTitle(record);
    return threadId
      ? telegramThreadMessagePath(chatId, threadId, messageId, chatTitle)
      : telegramMessagePath(chatId, messageId, chatTitle);
  }

  if (normalizedModel === "telegramcallbackquery" || normalizedModel === "callback-query" || normalizedModel === "callbackquery") {
    const callbackQueryId = id || readFirstString(record, "callbackQueryId", "callback_query_id");
    if (!callbackQueryId) {
      throw new Error("Missing Telegram callback query id");
    }
    return telegramCallbackQueryPath(callbackQueryId);
  }

  if (normalizedModel === "telegraminlinequery" || normalizedModel === "inline-query" || normalizedModel === "inlinequery") {
    const inlineQueryId = id || readFirstString(record, "inlineQueryId", "inline_query_id");
    if (!inlineQueryId) {
      throw new Error("Missing Telegram inline query id");
    }
    return telegramInlineQueryPath(inlineQueryId);
  }

  if (normalizedModel === "telegramreaction" || normalizedModel === "reaction") {
    const chatId = readTelegramChatId(record);
    const messageId = readTelegramMessageId(record);
    const updateId = readFirstString(record, "updateId", "update_id") ?? id;
    if (!chatId || !messageId || !updateId) {
      throw new Error("Missing Telegram reaction chat id, message id, or update id");
    }
    return telegramReactionPath(chatId, messageId, updateId, readTelegramChatTitle(record));
  }

  if (normalizedModel === "telegramupdate" || normalizedModel === "update") {
    const updateId = readFirstString(record, "updateId", "update_id") ?? id;
    if (!updateId) {
      throw new Error("Missing Telegram update id");
    }
    return telegramUpdatePath(updateId);
  }

  throw new Error(`Unsupported Telegram model: ${model}`);
}

async function writeTelegramRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeTelegramRecordPath(cleaned, job.model),
    skipIfUnchanged: true,
    stableProjection: slackStableProjection,
    dedupLogContext: {
      provider: TELEGRAM_PROVIDER,
      model: job.model,
    },
  });
}

function computeXRecordPath(record: Record<string, unknown>, model: string): string {
  const normalized = model.trim().toLowerCase();
  if (normalized === "xsearchbundle" || normalized === "searchbundle") {
    const run = readNestedRecord(record, "run");
    const id = run ? readFirstString(run, "id") : readFirstString(record, "id");
    if (!id) {
      throw new Error("Missing X search bundle run id");
    }
    return computeXPath(
      "search",
      id,
      run ? readFirstString(run, "title", "query") : readFirstString(record, "title", "query"),
    );
  }

  if (normalized === "xsearchresult" || normalized === "searchresult") {
    const searchId = readFirstString(record, "searchId", "search_id");
    const postId = readFirstString(record, "postId", "post_id", "id");
    if (!searchId || !postId) {
      throw new Error("Missing X search result path context");
    }
    return xSearchResultPath(searchId, readFirstString(record, "title", "query"), postId);
  }

  if (normalized === "xsearch" || normalized === "search") {
    const id = readFirstString(record, "id", "searchId", "search_id");
    if (!id) {
      throw new Error("Missing X search id");
    }
    return computeXPath("search", id, readFirstString(record, "title", "query"));
  }

  if (normalized === "xuser" || normalized === "user") {
    const id = readFirstString(record, "id", "userId", "user_id", "author_id");
    if (!id) {
      throw new Error("Missing X user id");
    }
    return computeXPath("user", id, readFirstString(record, "username", "name"));
  }

  const id = readFirstString(record, "id", "postId", "post_id", "tweet_id");
  if (!id) {
    throw new Error("Missing X post id");
  }
  return computeXPath("post", id, readFirstString(record, "text", "title"));
}

async function writeXRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeXRecordPath(cleaned, job.model),
  });
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function normalizeModelDirectory(model: string): string {
  const normalized = model.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-");
  return normalized.length > 0 ? normalized : "records";
}

function firstNonEmptyModelId(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = readFirstString(record, key)?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function splitCompositeId(value: string | null): { left: string; right: string } | null {
  if (!value) {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator <= 0 || separator >= value.length - 1) {
    return null;
  }
  const left = value.slice(0, separator).trim();
  const right = value.slice(separator + 1).trim();
  if (!left || !right) {
    return null;
  }
  return { left, right };
}

function computeGoogleMailRecordPath(record: Record<string, unknown>, model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const id = readFirstString(record, "id")?.trim();
  const modelDirectory = normalizeModelDirectory(model);

  if (normalizedModel === "googlemaillabel" || normalizedModel === "label") {
    if (!id) throw new Error("Missing Google Mail label id");
    return `/${GOOGLE_MAIL_PROVIDER}/labels/${encodePathSegment(id)}.json`;
  }
  if (normalizedModel === "googlemailfilter" || normalizedModel === "filter") {
    if (!id) throw new Error("Missing Google Mail filter id");
    return `/${GOOGLE_MAIL_PROVIDER}/filters/${encodePathSegment(id)}.json`;
  }
  if (normalizedModel === "googlemailsendasalias" || normalizedModel === "sendasalias") {
    const aliasId = firstNonEmptyModelId(record, "id", "sendAsEmail", "send_as_email");
    if (!aliasId) throw new Error("Missing Google Mail send-as alias id");
    return `/${GOOGLE_MAIL_PROVIDER}/send-as/${encodePathSegment(aliasId)}.json`;
  }
  if (normalizedModel === "googlemailmessage" || normalizedModel === "message") {
    if (!id) throw new Error("Missing Google Mail message id");
    return `/${GOOGLE_MAIL_PROVIDER}/messages/${encodePathSegment(id)}.json`;
  }
  if (normalizedModel === "googlemailthread" || normalizedModel === "thread") {
    if (!id) throw new Error("Missing Google Mail thread id");
    return `/${GOOGLE_MAIL_PROVIDER}/threads/${encodePathSegment(id)}.json`;
  }
  if (normalizedModel === "googlemailwatchrenewal" || normalizedModel === "watchrenewal") {
    if (!id) throw new Error("Missing Google Mail watch renewal id");
    return `/${GOOGLE_MAIL_PROVIDER}/watch-renewals/${encodePathSegment(id)}.json`;
  }

  if (!id) {
    throw new Error(`Missing Google Mail record id for model: ${model}`);
  }
  return `/${GOOGLE_MAIL_PROVIDER}/${modelDirectory}/${encodePathSegment(id)}.json`;
}

function computeGoogleCalendarRecordPath(record: Record<string, unknown>, model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const id = readFirstString(record, "id")?.trim() ?? null;
  const modelDirectory = normalizeModelDirectory(model);

  if (normalizedModel === "googlecalendar" || normalizedModel === "calendar") {
    if (!id) throw new Error("Missing Google Calendar id");
    return `/${GOOGLE_CALENDAR_PROVIDER}/calendars/${encodePathSegment(id)}.json`;
  }
  if (
    normalizedModel === "googlecalendarsetting" ||
    normalizedModel === "calendarsetting" ||
    normalizedModel === "setting"
  ) {
    if (!id) throw new Error("Missing Google Calendar setting id");
    return `/${GOOGLE_CALENDAR_PROVIDER}/settings/${encodePathSegment(id)}.json`;
  }
  if (normalizedModel === "googlecalendarcolor" || normalizedModel === "calendarcolor" || normalizedModel === "color") {
    const colorType = firstNonEmptyModelId(record, "colorType", "color_type") ?? "unknown";
    const colorId = firstNonEmptyModelId(record, "colorId", "color_id") ?? id;
    if (!colorId) throw new Error("Missing Google Calendar color id");
    return `/${GOOGLE_CALENDAR_PROVIDER}/colors/${encodePathSegment(colorType)}/${encodePathSegment(colorId)}.json`;
  }
  if (
    normalizedModel === "googlecalendarwatchrenewal" ||
    normalizedModel === "calendarwatchrenewal" ||
    normalizedModel === "watchrenewal"
  ) {
    if (!id) throw new Error("Missing Google Calendar watch renewal id");
    return `/${GOOGLE_CALENDAR_PROVIDER}/watch-renewals/${encodePathSegment(id)}.json`;
  }
  if (normalizedModel === "googlecalendarevent" || normalizedModel === "calendarevent" || normalizedModel === "event") {
    const composite = splitCompositeId(id);
    const calendarId =
      firstNonEmptyModelId(record, "calendarId", "calendar_id") ??
      composite?.left ??
      null;
    const eventId =
      firstNonEmptyModelId(record, "eventId", "event_id") ??
      composite?.right ??
      id;
    if (!eventId) throw new Error("Missing Google Calendar event id");
    if (!calendarId) {
      return `/${GOOGLE_CALENDAR_PROVIDER}/events/${encodePathSegment(eventId)}.json`;
    }
    return `/${GOOGLE_CALENDAR_PROVIDER}/calendars/${encodePathSegment(calendarId)}/events/${encodePathSegment(eventId)}.json`;
  }
  if (normalizedModel === "googlecalendaracl" || normalizedModel === "calendaracl" || normalizedModel === "acl") {
    const composite = splitCompositeId(id);
    const calendarId =
      firstNonEmptyModelId(record, "calendarId", "calendar_id") ??
      composite?.left ??
      null;
    const ruleId =
      firstNonEmptyModelId(record, "ruleId", "rule_id") ??
      composite?.right ??
      id;
    if (!ruleId) throw new Error("Missing Google Calendar ACL rule id");
    if (!calendarId) {
      return `/${GOOGLE_CALENDAR_PROVIDER}/acls/${encodePathSegment(ruleId)}.json`;
    }
    return `/${GOOGLE_CALENDAR_PROVIDER}/calendars/${encodePathSegment(calendarId)}/acls/${encodePathSegment(ruleId)}.json`;
  }

  if (!id) {
    throw new Error(`Missing Google Calendar record id for model: ${model}`);
  }
  return `/${GOOGLE_CALENDAR_PROVIDER}/${modelDirectory}/${encodePathSegment(id)}.json`;
}

function computeGranolaRecordPath(record: Record<string, unknown>, model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const id = readFirstString(record, "id")?.trim() ?? null;
  if (!id) {
    throw new Error(`Missing Granola record id for model: ${model}`);
  }

  if (normalizedModel === "granolanote" || normalizedModel === "note") {
    return computeGranolaPath("note", id);
  }
  if (normalizedModel === "granolafolder" || normalizedModel === "folder") {
    return computeGranolaPath("folder", id);
  }

  const modelDirectory = normalizeModelDirectory(model);
  return `/${GRANOLA_PROVIDER}/${modelDirectory}/${encodePathSegment(id)}.json`;
}

function computeRecallRecordPath(record: Record<string, unknown>, model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const recordingId =
    readFirstString(record, "recording_id", "recordingId")?.trim() ??
    readFirstString(record, "id")?.trim() ??
    null;
  if (!recordingId) {
    throw new Error(`Missing Recall recording id for model: ${model}`);
  }

  if (
    normalizedModel === "recallrecording" ||
    normalizedModel === "recording" ||
    normalizedModel === "recalltranscript" ||
    normalizedModel === "transcript"
  ) {
    return `/${RECALL_PROVIDER}/recordings/${encodePathSegment(recordingId)}.json`;
  }

  const modelDirectory = normalizeModelDirectory(model);
  return `/${RECALL_PROVIDER}/${modelDirectory}/${encodePathSegment(recordingId)}.json`;
}

function computeFathomRecordPath(record: Record<string, unknown>, model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const id = readFirstString(record, "id")?.trim() ?? null;
  if (!id) {
    throw new Error(`Missing Fathom record id for model: ${model}`);
  }

  if (normalizedModel === "fathommeeting" || normalizedModel === "meeting") {
    return computeFathomPath("meeting", id);
  }
  if (
    normalizedModel === "fathomrecordingsummary" ||
    normalizedModel === "recordingsummary" ||
    normalizedModel === "recording-summary"
  ) {
    return computeFathomPath("recording-summary", id);
  }
  if (
    normalizedModel === "fathomrecordingtranscript" ||
    normalizedModel === "recordingtranscript" ||
    normalizedModel === "recording-transcript"
  ) {
    return computeFathomPath("recording-transcript", id);
  }
  if (normalizedModel === "fathomteam" || normalizedModel === "team") {
    return computeFathomPath("team", id);
  }
  if (
    normalizedModel === "fathomteammember" ||
    normalizedModel === "teammember" ||
    normalizedModel === "team-member"
  ) {
    return computeFathomPath("team-member", id);
  }

  const modelDirectory = normalizeModelDirectory(model);
  return `/${FATHOM_PROVIDER}/${modelDirectory}/${encodePathSegment(id)}.json`;
}

function computeDockerHubRecordPath(
  record: Record<string, unknown>,
  model: string,
): string {
  const id = readFirstString(record, "id")?.trim();
  if (!id) {
    throw new Error(`Missing Docker Hub record id for model: ${model}`);
  }
  return computeDockerHubPath(model, id);
}

function computeRedditRecordPath(
  record: Record<string, unknown>,
  model: string,
): string {
  const id = readFirstString(record, "id")?.trim();
  if (!id) {
    throw new Error(`Missing Reddit record id for model: ${model}`);
  }
  return computeRedditPathFromModel(model, id, {
    subreddit: readFirstString(record, "subreddit") ?? undefined,
    title: readFirstString(record, "title") ?? undefined,
  });
}

function computeDropboxRecordPath(
  record: Record<string, unknown>,
  model: string,
): string {
  const normalizedModel = model.trim().toLowerCase();
  const id = readFirstString(record, "id")?.trim();
  if (!id) {
    throw new Error(`Missing Dropbox record id for model: ${model}`);
  }

  const pathLower = readFirstString(record, "path_lower", "path", "path_display");

  if (normalizedModel === "dropboxfile" || normalizedModel === "file") {
    return computeDropboxPath("file", id, { path_lower: pathLower });
  }
  if (normalizedModel === "dropboxfolder" || normalizedModel === "folder") {
    return computeDropboxPath("folder", id, { path_lower: pathLower });
  }
  if (
    normalizedModel === "dropboxsharedfolder" ||
    normalizedModel === "sharedfolder" ||
    normalizedModel === "shared-folder"
  ) {
    return computeDropboxPath("shared-folder", id, {
      name: readFirstString(record, "shared_folder_name", "name"),
    });
  }
  if (
    normalizedModel === "dropboxsharedlink" ||
    normalizedModel === "sharedlink" ||
    normalizedModel === "shared-link"
  ) {
    return computeDropboxPath("shared-link", id, {
      name: readFirstString(record, "name", "url"),
    });
  }

  const modelDirectory = normalizeModelDirectory(model);
  return `/${DROPBOX_PROVIDER}/${modelDirectory}/${encodePathSegment(id)}.json`;
}

function computeDaytonaRecordPath(
  record: Record<string, unknown>,
  model: string,
): string {
  // The deployed daytona-relay `fetch-usage` sync emits one DaytonaUsage record
  // per organization (id === organizationId). Some usage representations are
  // partitioned by billing period; when a `period` is present we nest under it,
  // otherwise the per-org overview file updates in place each poll.
  const orgId = readFirstString(
    record,
    "organizationId",
    "organization_id",
    "id",
  )?.trim();
  if (!orgId) {
    throw new Error(`Missing Daytona organization id for model: ${model}`);
  }
  const period = readFirstString(record, "period")?.trim();
  const base = `/${DAYTONA_PROVIDER}/usage/${encodePathSegment(orgId)}`;
  return period ? `${base}/${encodePathSegment(period)}.json` : `${base}.json`;
}

function computeGcpRecordPath(
  record: Record<string, unknown>,
  model: string,
): string {
  const objectType = normalizeNangoGcpModel(model);
  if (!objectType) {
    throw new Error(`Unsupported GCP record model: ${model}`);
  }

  const id =
    readFirstString(
      record,
      "id",
      "serviceName",
      "policyId",
      "billingAccountId",
      "groupId",
    )?.trim() ?? null;

  if (objectType === "billing") {
    return computeGcpPath(objectType, id ?? "current");
  }
  if (!id) {
    throw new Error(`Missing GCP record id for model: ${model}`);
  }
  return computeGcpPath(objectType, id);
}

function computeCloudflareRecordPath(
  record: Record<string, unknown>,
  model: string,
): string {
  const objectType = normalizeNangoCloudflareModel(model);
  if (!objectType) {
    throw new Error(`Unsupported Cloudflare record model: ${model}`);
  }

  const id =
    objectType === "worker-script" || objectType === "worker-usage"
      ? readFirstString(record, "script_name", "id")?.trim() ?? null
      : readFirstString(record, "id", "name", "title")?.trim() ?? null;

  if (!id) {
    throw new Error(`Missing Cloudflare record id for model: ${model}`);
  }

  if (objectType === "dns-record") {
    const zoneId = readFirstString(record, "zone_id")?.trim() ?? null;
    if (!zoneId) {
      throw new Error("Missing Cloudflare dns-record zone_id");
    }
    return computeCloudflarePath(objectType, id, { zoneId });
  }

  return computeCloudflarePath(objectType, id);
}

function computeNeonRecordPath(
  record: Record<string, unknown>,
  model: string,
): string {
  const objectType = normalizeNangoNeonModel(model);
  if (!objectType) {
    throw new Error(`Unsupported Neon record model: ${model}`);
  }

  const id =
    readFirstString(
      record,
      "id",
      "org_id",
      "orgId",
      "project_id",
      "projectId",
      "branch_id",
      "branchId",
      "endpoint_id",
      "endpointId",
    )?.trim() ?? null;

  if (!id) {
    throw new Error(`Missing Neon record id for model: ${model}`);
  }
  return computeNeonPath(objectType, id);
}

async function writeDaytonaRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeDaytonaRecordPath(cleaned, job.model),
  });
}

async function writeGcpRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeGcpRecordPath(cleaned, job.model),
  });
}

async function writeCloudflareRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeCloudflareRecordPath(cleaned, job.model),
  });
}

async function writeNeonRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeNeonRecordPath(cleaned, job.model),
  });
}

async function writeGoogleMailRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = normalizeGoogleMailRecordForStorage(
    stripNangoMetadata(raw),
    job.model,
  );
  const stableModel = googleMailStableModel(job.model);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeGoogleMailRecordPath(cleaned, job.model),
    skipIfUnchanged: true,
    ...(isGoogleMailStableDedupEnabled() && stableModel
      ? {
          stableProjection: (record: Record<string, unknown>) =>
            googleMailStableProjection(record, stableModel),
          dedupLogContext: {
            provider: GOOGLE_MAIL_PROVIDER,
            model: job.model,
          },
        }
      : {}),
  });
}

async function writeGoogleCalendarRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeGoogleCalendarRecordPath(cleaned, job.model),
  });
}

async function writeGranolaRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeGranolaRecordPath(cleaned, job.model),
  });
}

async function writeRecallRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeRecallRecordPath(cleaned, job.model),
  });
}

function recallRecordingsMainIndexPath(): string {
  return `/${RECALL_PROVIDER}/recordings/_index.json`;
}

function buildRecallRecordingIndexRow(record: Record<string, unknown>): DigestIndexRow {
  const id =
    readFirstString(record, "recording_id", "recordingId")?.trim() ??
    readFirstString(record, "id")?.trim() ??
    "";
  return {
    id,
    path: `/${RECALL_PROVIDER}/recordings/${encodePathSegment(id)}.json`,
    title: readFirstString(record, "title") ?? id,
    updatedAt: readProviderTimestampString(record) ?? undefined,
    sourceUpdatedAt: readProviderTimestampString(record) ?? undefined,
  };
}

async function writeRecallAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, RECALL_PROVIDER);
  if (bucketed.provider !== RECALL_PROVIDER) return [];

  const recordings = (bucketed.buckets as { recordings?: Record<string, unknown>[] }).recordings ?? [];
  const cache = createIndexCache();
  const errors: EmitAuxiliaryFilesResult["errors"] = [];

  try {
    await getIndexRows(cache, client, job.workspaceId, recallRecordingsMainIndexPath());
  } catch (error) {
    errors.push({ path: recallRecordingsMainIndexPath(), error: String(error) });
  }

  for (const record of recordings) {
    const id =
      readFirstString(record, "recording_id", "recordingId")?.trim() ??
      readFirstString(record, "id")?.trim() ??
      "";
    if (!id) continue;

    try {
      if (record._deleted === true) {
        deleteIndexRow(cache, recallRecordingsMainIndexPath(), id);
        await deleteByIdRecordAlias({
          client,
          workspaceId: job.workspaceId,
          provider: RECALL_PROVIDER,
          resource: "recordings",
          id,
        });
        continue;
      }

      upsertIndexRow(cache, recallRecordingsMainIndexPath(), buildRecallRecordingIndexRow(record));
      await writeByIdRecordAlias({
        client,
        workspaceId: job.workspaceId,
        provider: RECALL_PROVIDER,
        resource: "recordings",
        model: job.model,
        id,
        record,
        connectionId: job.connectionId,
      });
    } catch (error) {
      errors.push({ path: recallRecordingsMainIndexPath(), error: `record ${id}: ${String(error)}` });
    }
  }

  try {
    await flushIndexCache(cache, client, job.workspaceId);
  } catch (error) {
    errors.push({ path: recallRecordingsMainIndexPath(), error: `flushIndexCache: ${String(error)}` });
  }

  return errors;
}

async function writeFathomRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeFathomRecordPath(cleaned, job.model),
  });
}

async function writeDockerHubRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeDockerHubRecordPath(cleaned, job.model),
  });
}

async function writeRedditRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeRedditRecordPath(cleaned, job.model),
  });
}

async function writeDropboxRecord(
  client: RelayfileWriteClient,
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const cleaned = stripNangoMetadata(raw);
  return writeJsonOrDelete({
    client,
    job,
    raw,
    cleaned,
    path: computeDropboxRecordPath(cleaned, job.model),
  });
}

export async function writeProviderRecord(
  client: RelayfileWriteClient,
  record: unknown,
  job: NangoSyncJob,
): Promise<RecordWriteOutcome> {
  const raw = getRecordObject(record);
  const provider = job.provider.trim().toLowerCase();
  const adapter = resolveAdapter(provider);

  if (adapter?.writeRecord) {
    return adapter.writeRecord(client, raw, job);
  }

  if (provider === "github") {
    return writeGitHubRecord(client, raw, job);
  }

  if (provider === "gitlab") {
    return writeGitLabRecord(client, raw, job);
  }

  if (provider === "x" || provider === "twitter") {
    return writeXRecord(client, raw, job);
  }

  if (provider === "linear") {
    return writeLinearRecord(client, raw, job);
  }

  if (provider === "notion") {
    return writeNotionRecord(client, raw, job);
  }

  if (provider === "jira") {
    return writeJiraRecord(client, raw, job);
  }

  if (provider === "confluence") {
    return writeConfluenceRecord(client, raw, job);
  }

  if (provider === "hubspot") {
    return writeHubSpotRecord(client, raw, job);
  }

  if (isGoogleMailProvider(provider)) {
    return writeGoogleMailRecord(client, raw, job);
  }

  if (isGoogleCalendarProvider(provider)) {
    return writeGoogleCalendarRecord(client, raw, job);
  }

  if (isGranolaProvider(provider)) {
    return writeGranolaRecord(client, raw, job);
  }

  if (isRecallProvider(provider)) {
    return writeRecallRecord(client, raw, job);
  }

  if (isFathomProvider(provider)) {
    return writeFathomRecord(client, raw, job);
  }

  if (isDockerHubProvider(provider)) {
    return writeDockerHubRecord(client, raw, job);
  }

  if (isRedditProvider(provider)) {
    return writeRedditRecord(client, raw, job);
  }

  if (isDropboxProvider(provider)) {
    return writeDropboxRecord(client, raw, job);
  }

  if (isSlackProvider(provider)) {
    return writeSlackRecord(client, raw, job);
  }

  if (provider === DAYTONA_PROVIDER || provider === "daytona-relay") {
    return writeDaytonaRecord(client, raw, job);
  }

  if (isGcpProvider(provider)) {
    return writeGcpRecord(client, raw, job);
  }

  throw new Error(`Unsupported Nango sync provider: ${job.provider}`);
}

const ROOT_LAYOUT_MD = `# Relayfile Workspace Layout

Start with each provider's LAYOUT.md and _index.json files before guessing paths.

Provider roots:
- /github/LAYOUT.md and /github/repos/_index.json
- /gitlab/LAYOUT.md and /gitlab/projects/_index.json
- /x/LAYOUT.md and /x/searches/_index.json
- /linear/LAYOUT.md and /linear/issues/_index.json
- /notion/LAYOUT.md and /notion/pages/_index.json
- /hubspot/LAYOUT.md and /hubspot/_index.json
- /jira/LAYOUT.md
- /confluence/LAYOUT.md
- /slack/LAYOUT.md
- /google-mail/LAYOUT.md
- /google-calendar/LAYOUT.md
- /granola/LAYOUT.md
- /docker-hub/LAYOUT.md
- /reddit/LAYOUT.md and /reddit/subreddits/_index.json
- /dropbox/LAYOUT.md
- /daytona/LAYOUT.md and /daytona/usage/_index.json
- /gcp/LAYOUT.md and /gcp/run/services/_index.json
- /neon/LAYOUT.md and /neon/projects/_index.json

Entity files use human-readable __ id segments where the provider adapter can
derive a stable name. Treat the last __ separated segment as the stable id, and
prefer _index.json rows for lookup and listing.

## Materialization

Most providers materialize all records eagerly — the Nango syncs walk the
source-of-truth API and write every record to the mount. Lazy materialization
(fetching on read) is opt-in per provider via adapter configuration; refer to
each provider's LAYOUT.md for the materialization mode it actually uses.
`;

function genericProviderLayout(provider: string): {
  path: string;
  contentType: string;
  content: string;
} {
  const root = `/${provider}`;
  return {
    path: `${root}/LAYOUT.md`,
    contentType: "text/markdown; charset=utf-8",
    content: `# ${provider} Mount Layout

Use \`${root}/_index.json\` or resource-specific \`_index.json\` files when present before constructing direct paths.

This provider's canonical records are JSON files under \`${root}/\`. Entity file names may include a human-readable prefix joined to the stable id with \`__\`.
`,
  };
}

async function writeCommonLayouts(
  client: RelayfileWriteClient,
  workspaceId: string,
  provider: string,
): Promise<void> {
  await writeManagedFile({
    client,
    workspaceId,
    path: "/LAYOUT.md",
    content: ROOT_LAYOUT_MD,
    contentType: "text/markdown; charset=utf-8",
  });

  const adapter = resolveAdapter(provider);
  const providerLayout = adapter
    ? adapter.layoutPromptFile()
    : genericProviderLayout(provider);

  await writeManagedFile({
    client,
    workspaceId,
    path: providerLayout.path,
    content: providerLayout.content,
    contentType: providerLayout.contentType ?? "text/markdown; charset=utf-8",
  });

  // Consistency invariant: the code path that writes the provider LAYOUT.md
  // (the discovery-contract ADVERTISER) is the same one that drives the
  // discovery-file PRODUCER (`writeDiscoveryArtifacts`, called via
  // `writeProviderDiscovery` from `materializeProviderContract`) — both off
  // `resourcesForProvider`. Assert
  // here so an adapter that advertises `discovery/...` in LAYOUT but exports
  // no `resources` (or vice versa) is surfaced loudly instead of silently
  // shipping a contract nothing materializes (the original defect).
  assertLayoutDiscoveryConsistency(
    provider,
    providerLayout.content,
    resourcesForProvider(provider),
  );
}

// ---------------------------------------------------------------------------
// Auxiliary-file emission dispatchers.
//
// Phase 3 of the cloud aux-file refactor (relayfile-adapters#78/#79/#80/#81/
// #82/#83 owned the Phase 1+2 side). Each `writeXAuxiliaryFiles` below is a
// thin wrapper that:
//   1. Buckets the incoming Nango records by model into the adapter's
//      expected input shape (see `record-buckets.ts`).
//   2. Wraps cloud's variadic `RelayfileWriteClient` into the duck-typed
//      `AuxiliaryEmitterClient` contract (see `auxiliary-emitter-shim.ts`).
//   3. Calls the adapter package's `emitXAuxiliaryFiles` and surfaces any
//      per-path errors via `console.warn` so CloudWatch keeps the same
//      observability shape as the pre-refactor logging.
//
// The old `writeXAuxiliaryFiles` functions (and their alias / index / prior-
// state helpers) lived inline here and totaled ~2,100 LOC. They have moved
// into each adapter so the canonical path mappers, alias trees, and index
// row shapes are owned by the same package that owns the underlying record
// schema. Cloud no longer needs to track adapter-version-specific alias
// surfaces.
// ---------------------------------------------------------------------------

import { emitConfluenceAuxiliaryFiles } from "@relayfile/adapter-confluence";
import { emitFathomAuxiliaryFiles } from "@relayfile/adapter-fathom";
import { emitGranolaAuxiliaryFiles } from "@relayfile/adapter-granola";
import { emitDropboxAuxiliaryFiles } from "@relayfile/adapter-dropbox";
import { emitGitHubAuxiliaryFiles } from "@relayfile/adapter-github";
import { emitGitLabAuxiliaryFiles } from "@relayfile/adapter-gitlab";
import { emitJiraAuxiliaryFiles } from "@relayfile/adapter-jira";
import { emitLinearAuxiliaryFiles } from "@relayfile/adapter-linear";
import { emitNotionAuxiliaryFiles } from "@relayfile/adapter-notion";
import { emitHubSpotAuxiliaryFiles } from "@relayfile/adapter-hubspot";
import { emitSlackAuxiliaryFiles } from "@relayfile/adapter-slack";
import { emitXAuxiliaryFiles } from "@relayfile/adapter-x";
import { emitDaytonaAuxiliaryFiles } from "@relayfile/adapter-daytona";
import { emitGcpAuxiliaryFiles } from "@relayfile/adapter-gcp";
import { emitCloudflareAuxiliaryFiles } from "@relayfile/adapter-cloudflare";
import { emitNeonAuxiliaryFiles } from "@relayfile/adapter-neon";
import {
  literalModelNormalizer,
  modelBucket,
} from "@relayfile/adapter-core/sync-bucketing";
import { syncRecordBucketing as confluenceRecordBucketing } from "@relayfile/adapter-confluence";
import { syncRecordBucketing as daytonaRecordBucketing } from "@relayfile/adapter-daytona";
import { syncRecordBucketing as dockerHubRecordBucketing } from "@relayfile/adapter-docker-hub";
import { syncRecordBucketing as dropboxRecordBucketing } from "@relayfile/adapter-dropbox";
import { syncRecordBucketing as fathomRecordBucketing } from "@relayfile/adapter-fathom";
import { syncRecordBucketing as gcpRecordBucketing } from "@relayfile/adapter-gcp";
import { syncRecordBucketing as cloudflareRecordBucketing } from "@relayfile/adapter-cloudflare";
import { syncRecordBucketing as githubRecordBucketing } from "@relayfile/adapter-github";
import { syncRecordBucketing as gitlabRecordBucketing } from "@relayfile/adapter-gitlab";
import { syncRecordBucketing as granolaRecordBucketing } from "@relayfile/adapter-granola";
import { syncRecordBucketing as hubSpotRecordBucketing } from "@relayfile/adapter-hubspot";
import { syncRecordBucketing as jiraRecordBucketing } from "@relayfile/adapter-jira";
import { syncRecordBucketing as linearRecordBucketing } from "@relayfile/adapter-linear";
import { syncRecordBucketing as neonRecordBucketing } from "@relayfile/adapter-neon";
import { syncRecordBucketing as notionRecordBucketing } from "@relayfile/adapter-notion";
import { syncRecordBucketing as recallRecordBucketing } from "@relayfile/adapter-recall";
import { syncRecordBucketing as redditRecordBucketing } from "@relayfile/adapter-reddit";
import { syncRecordBucketing as slackRecordBucketing } from "@relayfile/adapter-slack";
import { syncRecordBucketing as xRecordBucketing } from "@relayfile/adapter-x";
import {
  toAuxiliaryEmitterClient,
  type AuxiliaryEmitterClient,
  type EmitAuxiliaryFilesResult,
} from "./auxiliary-emitter-shim.js";
import {
  bucketForAdapter,
  type AdapterRecordBucketing,
  type ProviderBuckets,
  type RecordBucketMap,
} from "./record-buckets.js";

function logEmitErrors(
  provider: string,
  job: NangoSyncJob,
  result: EmitAuxiliaryFilesResult,
): EmitAuxiliaryFilesResult["errors"] {
  if (result.errors.length === 0) {
    return [];
  }
  // Mirrors the pre-refactor `console.error` shape on aux-write failures so
  // existing CloudWatch dashboards / alerts keep matching. Errors are
  // accumulated by the adapter (each path's failure is independent) and
  // surfaced verbatim here.
  console.warn(`[record-writer] ${provider} auxiliary emit errors`, {
    area: "nango-sync-worker",
    provider,
    model: job.model,
    syncName: job.syncName,
    workspaceId: job.workspaceId,
    written: result.written,
    deleted: result.deleted,
    errors: result.errors,
  });
  return result.errors;
}

async function writeGitHubAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, "github");
  if (bucketed.provider !== "github") return [];
  const buckets = bucketed.buckets;

  const result = await emitGitHubAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      pullRequests: buckets.pullRequests as never,
      issues: buckets.issues as never,
      repositories: buckets.repositories as never,
      reviews: buckets.reviews as never,
      reviewComments: buckets.reviewComments as never,
      checkRuns: buckets.checkRuns as never,
      commits: buckets.commits as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors("github", job, result);
}

async function writeGitLabAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const allBucketed = bucketByModel(records, job.model, "gitlab");
  if (allBucketed.provider !== "gitlab") return [];
  const allBuckets = allBucketed.buckets;
  const supportsTombstoneDeletes = await gitLabEmitterSupportsTombstoneDeletes();
  const handlesTagTombstonesLocally = normalizeGitLabModel(job.model) === "tags";
  const emitterRecords = supportsTombstoneDeletes
    ? records.filter((record) => !(handlesTagTombstonesLocally && isDeletedNangoRecord(record)))
    : records.filter((record) => !isDeletedNangoRecord(record));
  const emitterBucketed = bucketByModel(emitterRecords, job.model, "gitlab");
  if (emitterBucketed.provider !== "gitlab") return [];
  const buckets = emitterBucketed.buckets;

  const projectErrors = await writeGitLabProjectAuxiliaryFiles(
    client,
    allBuckets.projects ?? [],
    job,
  );
  const tombstoneErrors = supportsTombstoneDeletes
    ? handlesTagTombstonesLocally
      ? await deleteGitLabTagTombstones(client, job, [], allBuckets.tags ?? [])
      : []
    : await deleteGitLabTombstoneAuxiliaryFiles(client, allBuckets, job);
  const result = await emitGitLabAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      mergeRequests: buckets.mergeRequests as never,
      issues: buckets.issues as never,
      commits: buckets.commits as never,
      pipelines: buckets.pipelines as never,
      deployments: buckets.deployments as never,
      tags: (buckets.tags ?? []).map(normalizeGitLabTagEmitterRecord) as never,
      connectionId: job.connectionId,
    },
  );
  const tagErrors = await reconcileGitLabTagAuxiliaryFiles(client, job, allBuckets.tags ?? []);
  return [...projectErrors, ...tombstoneErrors, ...logEmitErrors("gitlab", job, result), ...tagErrors];
}

async function writeXAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, "x");
  if (bucketed.provider !== "x") return [];
  const buckets = bucketed.buckets;

  const result = await emitXAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      bundles: buckets.bundles as never,
      searches: buckets.searches as never,
      posts: buckets.posts as never,
      users: buckets.users as never,
      results: buckets.results as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors("x", job, result);
}

function normalizeGitLabTagEmitterRecord(record: Record<string, unknown>): Record<string, unknown> {
  const tagRef = readGitLabTagRef(record);
  if (!tagRef) return record;
  return {
    ...record,
    ref: tagRef.id,
    name: readFirstString(record, "name") ?? tagRef.id,
  };
}

let gitLabEmitterTombstoneDeleteSupport: Promise<boolean> | undefined;

function gitLabEmitterSupportsTombstoneDeletes(): Promise<boolean> {
  gitLabEmitterTombstoneDeleteSupport ??= probeGitLabEmitterTombstoneDeletes();
  return gitLabEmitterTombstoneDeleteSupport;
}

async function reconcileGitLabTagAuxiliaryFiles(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const errors: EmitAuxiliaryFilesResult["errors"] = [];
  for (const record of records) {
    const projectPath = readGitLabProjectPath(record);
    const tagRef = readGitLabTagRef(record);
    if (!projectPath || !tagRef) continue;

    const canonicalPath = computeGitLabTagMetadataPath(projectPath, tagRef.id);
    const byRefPath = computeGitLabTagByRefAliasPath(projectPath, tagRef.id);
    const cleanupPaths = computeGitLabTagCleanupPaths(projectPath, tagRef.id, tagRef.raw);

    try {
      if (isAdapterDeleteRecord(record)) {
        await deleteGitLabAuxiliaryPaths(client, job, errors, cleanupPaths);
        continue;
      }

      await writeManagedFile({
        client,
        workspaceId: job.workspaceId,
        path: byRefPath,
        content: `${JSON.stringify({ id: tagRef.id, canonicalPath, ref: tagRef.id })}\n`,
        contentType: "application/json; charset=utf-8",
      });
      await deleteGitLabAuxiliaryPaths(
        client,
        job,
        errors,
        cleanupPaths.filter(
          (path) => path !== canonicalPath && path !== byRefPath,
        ),
      );
    } catch (error) {
      errors.push({ path: byRefPath, error: String(error) });
    }
  }
  return errors;
}

async function probeGitLabEmitterTombstoneDeletes(): Promise<boolean> {
  const writes: string[] = [];
  const deletes: string[] = [];
  const probeClient: AuxiliaryEmitterClient = {
    async writeFile(input) {
      writes.push(input.path);
    },
    async deleteFile(input) {
      deletes.push(input.path);
    },
    async readFile() {
      return null;
    },
  };
  await emitGitLabAuxiliaryFiles(
    probeClient,
    {
      workspaceId: "__probe__",
      mergeRequests: [
        {
          iid: "1",
          project_path: "probe/project",
          title: "Probe",
          _deleted: true,
        } as never,
      ],
    },
  );
  return (
    deletes.some((path) => path.includes("/merge_requests/1__probe/meta.json")) &&
    !writes.some((path) => path.includes("/merge_requests/1__probe/meta.json"))
  );
}

async function deleteGitLabTombstoneAuxiliaryFiles(
  client: RelayfileWriteClient,
  buckets: RecordBucketMap,
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const errors: EmitAuxiliaryFilesResult["errors"] = [];
  await deleteGitLabTitledTombstones(client, job, errors, "merge_requests", buckets.mergeRequests ?? []);
  await deleteGitLabTitledTombstones(client, job, errors, "issues", buckets.issues ?? []);
  await deleteGitLabCommitTombstones(client, job, errors, buckets.commits ?? []);
  await deleteGitLabPipelineTombstones(client, job, errors, buckets.pipelines ?? []);
  await deleteGitLabDeploymentTombstones(client, job, errors, buckets.deployments ?? []);
  await deleteGitLabTagTombstones(client, job, errors, buckets.tags ?? []);
  return errors;
}

async function deleteGitLabTitledTombstones(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  errors: EmitAuxiliaryFilesResult["errors"],
  objectType: "merge_requests" | "issues",
  records: readonly Record<string, unknown>[],
): Promise<void> {
  for (const record of records.filter(isAdapterDeleteRecord)) {
    const projectPath = readGitLabProjectPath(record);
    const id = readFirstString(record, "iid", "id");
    if (!projectPath || !id) continue;
    const byIdPath = gitLabByIdAliasPath(projectPath, objectType, id);
    const prior = await readJsonObjectFile(client, job.workspaceId, byIdPath);
    const title = (prior ? readFirstString(prior, "title") : null) ?? readFirstString(record, "title", "name") ?? id;
    const canonicalPath = (prior ? readFirstString(prior, "canonicalPath", "path") : null) ?? computeGitLabMetadataPath(projectPath, objectType, id, title);
    await deleteGitLabAuxiliaryPaths(client, job, errors, [
      canonicalPath,
      byIdPath,
      gitLabByTitleAliasPath(projectPath, objectType, title, id),
    ]);
    await removeGitLabResourceIndexRow(client, job, errors, projectPath, objectType, id);
  }
}

async function deleteGitLabCommitTombstones(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  errors: EmitAuxiliaryFilesResult["errors"],
  records: readonly Record<string, unknown>[],
): Promise<void> {
  for (const record of records.filter(isAdapterDeleteRecord)) {
    const projectPath = readGitLabProjectPath(record);
    const id = readFirstString(record, "sha", "id");
    if (!projectPath || !id) continue;
    const byIdPath = gitLabByIdAliasPath(projectPath, "commits", id);
    const prior = await readJsonObjectFile(client, job.workspaceId, byIdPath);
    const title = (prior ? readFirstString(prior, "title") : null) ?? readFirstString(record, "title", "message") ?? id.slice(0, 12);
    const canonicalPath = (prior ? readFirstString(prior, "canonicalPath", "path") : null) ?? computeGitLabMetadataPath(projectPath, "commits", id, title);
    await deleteGitLabAuxiliaryPaths(client, job, errors, [
      canonicalPath,
      byIdPath,
      gitLabByTitleAliasPath(projectPath, "commits", title, id),
    ]);
    await removeGitLabResourceIndexRow(client, job, errors, projectPath, "commits", id);
  }
}

async function deleteGitLabPipelineTombstones(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  errors: EmitAuxiliaryFilesResult["errors"],
  records: readonly Record<string, unknown>[],
): Promise<void> {
  for (const record of records.filter(isAdapterDeleteRecord)) {
    const projectPath = readGitLabProjectPath(record);
    const id = readFirstString(record, "id", "iid");
    if (!projectPath || !id) continue;
    const byIdPath = gitLabByIdAliasPath(projectPath, "pipelines", id);
    const prior = await readJsonObjectFile(client, job.workspaceId, byIdPath);
    const ref = (prior ? readFirstString(prior, "ref") : null) ?? readFirstString(record, "ref");
    const status = (prior ? readFirstString(prior, "status") : null) ?? readFirstString(record, "status");
    const canonicalPath = (prior ? readFirstString(prior, "canonicalPath", "path") : null) ?? computeGitLabMetadataPath(projectPath, "pipelines", id, ref);
    await deleteGitLabAuxiliaryPaths(client, job, errors, [
      canonicalPath,
      byIdPath,
      ...(ref ? [gitLabByRefAliasPath(projectPath, "pipelines", ref, id)] : []),
      ...(status ? [gitLabByStatusAliasPath(projectPath, "pipelines", status, id)] : []),
    ]);
    await removeGitLabResourceIndexRow(client, job, errors, projectPath, "pipelines", id);
  }
}

async function deleteGitLabDeploymentTombstones(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  errors: EmitAuxiliaryFilesResult["errors"],
  records: readonly Record<string, unknown>[],
): Promise<void> {
  for (const record of records.filter(isAdapterDeleteRecord)) {
    const projectPath = readGitLabProjectPath(record);
    const id = readFirstString(record, "id", "iid");
    if (!projectPath || !id) continue;
    const status = readFirstString(record, "status");
    await deleteGitLabAuxiliaryPaths(client, job, errors, [
      computeGitLabMetadataPath(projectPath, "deployments", id),
      ...(status ? [gitLabByStatusAliasPath(projectPath, "deployments", status, id)] : []),
    ]);
    await removeGitLabResourceIndexRow(client, job, errors, projectPath, "deployments", id);
  }
}

async function deleteGitLabTagTombstones(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  errors: EmitAuxiliaryFilesResult["errors"],
  records: readonly Record<string, unknown>[],
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  for (const record of records.filter(isAdapterDeleteRecord)) {
    const projectPath = readGitLabProjectPath(record);
    const tagRef = readGitLabTagRef(record);
    if (!projectPath || !tagRef) continue;
    await deleteGitLabAuxiliaryPaths(
      client,
      job,
      errors,
      computeGitLabTagCleanupPaths(projectPath, tagRef.id, tagRef.raw),
    );
    await removeGitLabResourceIndexRow(client, job, errors, projectPath, "tags", tagRef.id);
  }
  return errors;
}

async function deleteGitLabAuxiliaryPaths(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  errors: EmitAuxiliaryFilesResult["errors"],
  paths: readonly (string | null | undefined)[],
): Promise<void> {
  for (const path of new Set(paths.filter((path): path is string => typeof path === "string" && path.length > 0))) {
    try {
      await deleteManagedFile(client, job.workspaceId, path);
    } catch (error) {
      errors.push({ path, error: String(error) });
    }
  }
}

async function removeGitLabResourceIndexRow(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
  errors: EmitAuxiliaryFilesResult["errors"],
  projectPath: string,
  objectType: "commits" | "deployments" | "issues" | "merge_requests" | "pipelines" | "tags",
  id: string,
): Promise<void> {
  const path = gitLabProjectResourceIndexPath(projectPath, objectType);
  const rows = await readJsonArray<Record<string, unknown>>(client, job.workspaceId, path);
  const nextRows = rows.filter((row) => readFirstString(row, "id") !== id);
  if (nextRows.length === rows.length) return;
  try {
    await writeManagedFile({
      client,
      workspaceId: job.workspaceId,
      path,
      content: `${JSON.stringify(nextRows)}\n`,
      contentType: "application/json; charset=utf-8",
    });
  } catch (error) {
    errors.push({ path, error: String(error) });
  }
}

async function writeGitLabProjectAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  if (records.length === 0) return [];
  const errors: EmitAuxiliaryFilesResult["errors"] = [];

  for (const file of [buildGitLabRootIndexFile()]) {
    try {
      await writeManagedFile({
        client,
        workspaceId: job.workspaceId,
        path: file.path,
        content: file.content,
        contentType: file.contentType,
      });
    } catch (error) {
      errors.push({ path: file.path, error: String(error) });
    }
  }

  const indexRead = await readGitLabProjectsIndexForRewrite(
    client,
    job.workspaceId,
  );
  let rows = indexRead.rows;

  for (const raw of records) {
    const cleaned = stripNangoMetadata(raw);
    const id = readId(cleaned);
    if (isAdapterDeleteRecord(raw)) {
      const alias = id
        ? await readJsonObjectFile(client, job.workspaceId, gitLabProjectByIdAliasPath(id))
        : null;
      const projectPath =
        (alias ? readFirstString(alias, "projectPath", "path_with_namespace") : null) ??
        readGitLabProjectPath(cleaned);
      if (projectPath) {
        rows = rows.filter((row) => row.id !== projectPath);
      }
      if (id) {
        await deleteManagedFile(client, job.workspaceId, gitLabProjectByIdAliasPath(id));
      }
      continue;
    }

    const projectPath = readGitLabProjectPath(cleaned);
    if (!id || !projectPath) continue;
    const title =
      readFirstString(cleaned, "name_with_namespace", "name", "path_with_namespace") ??
      projectPath;
    rows = [
      ...rows.filter((row) => row.id !== projectPath),
      { id: projectPath, title, updated: readGitLabProjectUpdatedAt(cleaned) },
    ];
    await writeManagedFile({
      client,
      workspaceId: job.workspaceId,
      path: gitLabProjectByIdAliasPath(id),
      content: `${JSON.stringify({
        id,
        projectPath,
        canonicalPath: computeGitLabRecordPath("project", cleaned),
        title,
      })}\n`,
      contentType: "application/json; charset=utf-8",
    });
  }

  const indexFile = buildGitLabProjectsIndexFile(rows);
  if (indexRead.error) {
    errors.push({ path: indexFile.path, error: indexRead.error });
    return errors;
  }
  try {
    await writeManagedFile({
      client,
      workspaceId: job.workspaceId,
      path: indexFile.path,
      content: indexFile.content,
      contentType: indexFile.contentType,
    });
  } catch (error) {
    errors.push({ path: indexFile.path, error: String(error) });
  }

  return errors;
}

async function readGitLabProjectsIndexForRewrite(
  client: RelayfileWriteClient,
  workspaceId: string,
): Promise<{ rows: GitLabProjectIndexRow[]; error?: string }> {
  const path = gitLabProjectsIndexPath();
  if (!client.readFile) {
    return { rows: [] };
  }

  let content: string | undefined;
  try {
    const value = await client.readFile(workspaceId, path);
    content =
      typeof value === "string"
        ? value
        : value !== null && typeof value.content === "string"
          ? value.content
          : undefined;
  } catch (error) {
    if (isNotFoundLikeError(error)) {
      return { rows: [] };
    }
    return {
      rows: [],
      error: `Refusing to write ${path} because its current contents could not be read: ${String(error)}`,
    };
  }

  if (!content) {
    return { rows: [] };
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      return { rows: [] };
    }
    return { rows: normalizeGitLabProjectIndexRows(parsed) };
  } catch (error) {
    return {
      rows: [],
      error: `Refusing to write ${path} because its current contents could not be parsed: ${String(error)}`,
    };
  }
}

function normalizeGitLabProjectIndexRows(
  rows: readonly unknown[],
): GitLabProjectIndexRow[] {
  return rows
    .map((row) => {
      if (!isObject(row)) return null;
      const id = readFirstString(row, "id");
      if (!id) return null;
      return {
        id,
        title: readFirstString(row, "title") ?? id,
        updated: readFirstString(row, "updated") ?? "",
      };
    })
    .filter((row): row is GitLabProjectIndexRow => row !== null);
}

async function writeLinearAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, "linear");
  if (bucketed.provider !== "linear") return [];
  const buckets = bucketed.buckets;
  const input: Parameters<typeof emitLinearAuxiliaryFiles>[1] = {
    workspaceId: job.workspaceId,
    connectionId: job.connectionId,
  };

  if ("issues" in buckets) input.issues = buckets.issues as never;
  if ("comments" in buckets) input.comments = buckets.comments as never;
  if ("labels" in buckets) input.labels = buckets.labels as never;
  if ("users" in buckets) input.users = buckets.users as never;
  if ("teams" in buckets) input.teams = buckets.teams as never;
  if ("projects" in buckets) input.projects = buckets.projects as never;
  if ("states" in buckets) input.states = buckets.states as never;
  if ("cycles" in buckets) input.cycles = buckets.cycles as never;
  if ("milestones" in buckets) input.milestones = buckets.milestones as never;
  if ("roadmaps" in buckets) input.roadmaps = buckets.roadmaps as never;

  const result = await emitLinearAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    input,
  );
  return logEmitErrors("linear", job, result);
}

type LinearFlatIndexBackfillConfig = {
  resourcePath: string;
  indexPath: string;
  titleKeys: readonly string[];
  depth?: number;
};

const LINEAR_FLAT_INDEX_BACKFILLS: readonly LinearFlatIndexBackfillConfig[] = [
  {
    resourcePath: "/linear/teams",
    indexPath: "/linear/teams/_index.json",
    titleKeys: ["name", "key"],
  },
  {
    resourcePath: "/linear/projects",
    indexPath: "/linear/projects/_index.json",
    titleKeys: ["name"],
    depth: 2,
  },
  {
    resourcePath: "/linear/labels",
    indexPath: "/linear/labels/_index.json",
    titleKeys: ["name", "key"],
  },
];

export async function reconcileLinearFlatIndexes(
  client: RelayfileWriteClient,
  workspaceId: string,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  if (!client.listTree || !client.readFile) {
    return [];
  }

  const errors: EmitAuxiliaryFilesResult["errors"] = [];
  for (const config of LINEAR_FLAT_INDEX_BACKFILLS) {
    try {
      const tree = await client.listTree(workspaceId, {
        path: config.resourcePath,
        depth: config.depth ?? 1,
        limit: 1000,
      });
      const rows: Array<Record<string, unknown>> = [];

      for (const entry of tree.entries ?? []) {
        const path = entry.path ?? "";
        const name = entry.name ?? path.split("/").pop() ?? "";
        const type = entry.type ?? entry.kind ?? "";
        if (
          !path.endsWith(".json") ||
          name === "_index.json" ||
          path.includes("/by-") ||
          type === "directory"
        ) {
          continue;
        }

        const stored = await readJsonObjectFile(client, workspaceId, path);
        if (!stored) continue;
        const record = unwrapStoredSampleRecord(stored);
        const id = readId(record);
        if (!id) continue;
        rows.push({
          id,
          title: readFirstString(record, ...config.titleKeys) ?? "",
          updated: readProviderTimestampString(record, "createdAt", "created_at") ?? "",
        });
      }

      if (rows.length === 0) {
        continue;
      }

      await writeManagedFile({
        client,
        workspaceId,
        path: config.indexPath,
        content: `${JSON.stringify(rows.sort(compareSimpleIndexRows))}\n`,
        contentType: "application/json; charset=utf-8",
      });
    } catch (error) {
      errors.push({
        path: config.indexPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return errors;
}

function compareSimpleIndexRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftUpdated = readString(left, "updated") ?? "";
  const rightUpdated = readString(right, "updated") ?? "";
  if (leftUpdated !== rightUpdated) {
    return rightUpdated.localeCompare(leftUpdated);
  }
  return readId(left).localeCompare(readId(right));
}

async function writeNotionAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, "notion");
  if (bucketed.provider !== "notion") return [];
  const buckets = bucketed.buckets;

  // Structured diagnostic. The Phase-3 emit refactor (#551) is the
  // canonical place to see whether records reaching the worker carry
  // the fields adapter-notion needs for alias emission (`title`,
  // `parent_type`, `parent_id`, `databaseId`, `databaseTitle`). On
  // 2026-05-13 the live mount showed canonical writes but no by-* alias
  // subtrees, which is consistent with either records arriving
  // field-shape-stripped or the worker never reaching this dispatcher.
  // Logged INFO not WARN so it doesn't alert; sampled to one record per
  // batch so a 304-page sync prints once, not 304 times.
  diagnoseNotionDispatch(buckets, job);

  const result = await emitNotionAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      pages: buckets.pages as never,
      databases: buckets.databases as never,
      users: buckets.users as never,
      connectionId: job.connectionId,
    },
  );

  // Always log the emit result counts so CloudWatch carries an authoritative
  // record of how many alias paths each dispatch produced. This is the
  // signal we wished we had on 2026-05-13.
  console.info("[record-writer] notion emit complete", {
    area: "nango-sync-worker",
    provider: "notion",
    model: job.model,
    syncName: job.syncName,
    workspaceId: job.workspaceId,
    written: result.written,
    deleted: result.deleted,
    errorCount: result.errors.length,
    pages: buckets.pages?.length ?? 0,
    databases: buckets.databases?.length ?? 0,
    users: buckets.users?.length ?? 0,
  });

  return logEmitErrors("notion", job, result);
}

async function writeHubSpotAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, "hubspot");
  if (bucketed.provider !== "hubspot") return [];
  const buckets = bucketed.buckets;

  const result = await emitHubSpotAuxiliaryFiles(toAuxiliaryEmitterClient(client), {
    workspaceId: job.workspaceId,
    records: {
      contacts: buckets.contacts as never,
      companies: buckets.companies as never,
      deals: buckets.deals as never,
      tickets: buckets.tickets as never,
    },
  });
  return logEmitErrors("hubspot", job, result);
}

function diagnoseNotionDispatch(buckets: RecordBucketMap, job: NangoSyncJob): void {
  const samplePage = buckets.pages?.[0];
  const sampleDatabase = buckets.databases?.[0];
  const sampleUser = buckets.users?.[0];
  console.info("[record-writer] notion dispatch", {
    area: "nango-sync-worker",
    provider: "notion",
    model: job.model,
    syncName: job.syncName,
    workspaceId: job.workspaceId,
    bucketSizes: {
      pages: buckets.pages?.length ?? 0,
      databases: buckets.databases?.length ?? 0,
      users: buckets.users?.length ?? 0,
    },
    samplePageKeys: samplePage ? Object.keys(samplePage).sort() : undefined,
    samplePageId: samplePage ? readDiagId(samplePage) : undefined,
    samplePagePresence: samplePage
      ? {
          title: typeof samplePage.title === "string" && samplePage.title.length > 0,
          parent_type: typeof samplePage.parent_type === "string" && samplePage.parent_type.length > 0,
          parent_id: typeof samplePage.parent_id === "string" && samplePage.parent_id.length > 0,
          databaseId:
            typeof samplePage.databaseId === "string" || typeof samplePage.database_id === "string",
          databaseTitle:
            typeof samplePage.databaseTitle === "string" ||
            typeof samplePage.database_title === "string",
        }
      : undefined,
    sampleDatabaseKeys: sampleDatabase ? Object.keys(sampleDatabase).sort() : undefined,
    sampleUserKeys: sampleUser ? Object.keys(sampleUser).sort() : undefined,
  });
}

function readDiagId(record: Record<string, unknown>): string | undefined {
  const v = record.id;
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

async function writeConfluenceAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, "confluence");
  if (bucketed.provider !== "confluence") return [];
  const buckets = bucketed.buckets;

  const result = await emitConfluenceAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      pages: buckets.pages as never,
      spaces: buckets.spaces as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors("confluence", job, result);
}

async function writeJiraAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, "jira");
  if (bucketed.provider !== "jira") return [];
  const buckets = bucketed.buckets;

  const result = await emitJiraAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      issues: buckets.issues as never,
      projects: buckets.projects as never,
      sprints: buckets.sprints as never,
      comments: buckets.comments as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors("jira", job, result);
}

async function writeSlackAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, "slack");
  if (bucketed.provider !== "slack") return [];
  const buckets = bucketed.buckets;

  const result = await emitSlackAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      channels: buckets.channels as never,
      users: buckets.users as never,
      messages: buckets.messages as never,
      threads: buckets.threads as never,
      threadReplies: buckets.threadReplies as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors("slack", job, result);
}

async function writeTelegramAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, TELEGRAM_PROVIDER);
  if (bucketed.provider !== TELEGRAM_PROVIDER) return [];
  const buckets = bucketed.buckets;

  const result = await emitTelegramAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      connectionId: job.connectionId,
      botConfigs: buckets.botConfigs as never,
      chats: buckets.chats as never,
      messages: buckets.messages as never,
      callbackQueries: buckets.callbackQueries as never,
      inlineQueries: buckets.inlineQueries as never,
      reactions: buckets.reactions as never,
      updates: buckets.updates as never,
    },
  );
  return logEmitErrors(TELEGRAM_PROVIDER, job, result);
}

function isSlackChannelOrUserModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized === "slackchannel" ||
    normalized === "channel" ||
    normalized === "slackuser" ||
    normalized === "user"
  );
}

function shouldMirrorSlackDiscoveryIndexes(job: NangoSyncJob): boolean {
  return isSlackProvider(job.provider) && isSlackChannelOrUserModel(job.model);
}

function compactSlackDiscoveryRows(
  rows: readonly Record<string, unknown>[],
  kind: "channel" | "user",
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const id = readId(row);
    if (!id) continue;
    const name =
      kind === "channel"
        ? readFirstString(row, "title", "name") ?? ""
        : readFirstString(row, "name") ?? "";
    const title = readFirstString(row, "title") ?? name;
    const canonicalPath =
      readFirstString(row, "path", "canonicalPath") ??
      (kind === "channel" ? channelMetadataPath(id) : userMetadataPath(id));
    out.push({
      id,
      name,
      title,
      canonicalPath,
      path: kind === "channel" ? `/slack/channels/${id}` : `/slack/users/${id}`,
      messagesPath:
        kind === "channel"
          ? `/slack/channels/${id}/messages`
          : `/slack/users/${id}/messages`,
      ...(kind === "user" ? { is_bot: row.is_bot === true } : {}),
    });
  }
  return out;
}

async function mirrorSlackDiscoveryIndexes(
  client: RelayfileWriteClient,
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  if (!client.readFile) return [];
  if (!isSlackProvider(job.provider)) return [];
  const model = job.model.trim().toLowerCase();
  const mirrors: Array<{
    sourcePath: string;
    targetPath: string;
    kind: "channel" | "user";
  }> = [];
  if (model === "slackchannel" || model === "channel") {
    mirrors.push({
      sourcePath: "/slack/channels/_index.json",
      targetPath: "/discovery/slack/channels/_index.json",
      kind: "channel",
    });
  } else if (model === "slackuser" || model === "user") {
    mirrors.push({
      sourcePath: "/slack/users/_index.json",
      targetPath: "/discovery/slack/users/_index.json",
      kind: "user",
    });
  }

  const errors: EmitAuxiliaryFilesResult["errors"] = [];
  for (const mirror of mirrors) {
    try {
      const rows = await readRequiredJsonArray<Record<string, unknown>>(
        client,
        job.workspaceId,
        mirror.sourcePath,
      );
      if (rows === null) continue;
      await writeManagedFile({
        client,
        workspaceId: job.workspaceId,
        path: mirror.targetPath,
        content: `${JSON.stringify(compactSlackDiscoveryRows(rows, mirror.kind))}\n`,
        contentType: "application/json; charset=utf-8",
      });
    } catch (error) {
      if (isNotFoundLikeError(error)) continue;
      errors.push({ path: mirror.targetPath, error: String(error) });
    }
  }
  return errors;
}

async function writeGranolaAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, "granola");
  if (bucketed.provider !== "granola") return [];
  const buckets = bucketed.buckets;

  const result = await emitGranolaAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      notes: buckets.notes as never,
      folders: buckets.folders as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors("granola", job, result);
}

async function writeFathomAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, FATHOM_PROVIDER);
  if (bucketed.provider !== FATHOM_PROVIDER) return [];
  const buckets = bucketed.buckets;

  const result = await emitFathomAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      meetings: buckets.meetings as never,
      recordingSummaries: buckets.recordingSummaries as never,
      recordingTranscripts: buckets.recordingTranscripts as never,
      teams: buckets.teams as never,
      teamMembers: buckets.teamMembers as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors(FATHOM_PROVIDER, job, result);
}

async function writeDockerHubAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, DOCKER_HUB_PROVIDER);
  if (bucketed.provider !== DOCKER_HUB_PROVIDER) return [];
  const buckets = bucketed.buckets;

  const result = await emitDockerHubAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      repositories: buckets.repositories as never,
      tags: buckets.tags as never,
      webhooks: buckets.webhooks as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors(DOCKER_HUB_PROVIDER, job, result);
}

async function writeRedditAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, REDDIT_PROVIDER);
  if (bucketed.provider !== REDDIT_PROVIDER) return [];
  const buckets = bucketed.buckets;

  const result = await emitRedditAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      subreddits: buckets.subreddits as never,
      posts: buckets.posts as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors(REDDIT_PROVIDER, job, result);
}

async function writeDropboxAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, DROPBOX_PROVIDER);
  if (bucketed.provider !== DROPBOX_PROVIDER) return [];
  const buckets = bucketed.buckets;

  const result = await emitDropboxAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      files: buckets.files as never,
      folders: buckets.folders as never,
      sharedFolders: buckets.sharedFolders as never,
      sharedLinks: buckets.sharedLinks as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors(DROPBOX_PROVIDER, job, result);
}

async function writeDaytonaAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, DAYTONA_PROVIDER);
  if (bucketed.provider !== DAYTONA_PROVIDER) return [];
  const buckets = bucketed.buckets;

  const result = await emitDaytonaAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      usage: buckets.usage as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors(DAYTONA_PROVIDER, job, result);
}

async function writeGcpAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, GCP_PROVIDER);
  if (bucketed.provider !== GCP_PROVIDER) return [];
  const buckets = bucketed.buckets;

  const result = await emitGcpAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      cloudRunServices: buckets.cloudRunServices as never,
      monitoringAlerts: buckets.monitoringAlerts as never,
      billing: buckets.billing as never,
      errorGroups: buckets.errorGroups as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors(GCP_PROVIDER, job, result);
}

async function writeCloudflareAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, CLOUDFLARE_PROVIDER);
  if (bucketed.provider !== CLOUDFLARE_PROVIDER) return [];
  const buckets = bucketed.buckets;

  const result = await emitCloudflareAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      workerScripts: buckets.workerScripts as never,
      workerUsage: buckets.workerUsage as never,
      pagesProjects: buckets.pagesProjects as never,
      d1Databases: buckets.d1Databases as never,
      kvNamespaces: buckets.kvNamespaces as never,
      r2Buckets: buckets.r2Buckets as never,
      queues: buckets.queues as never,
      tunnels: buckets.tunnels as never,
      zones: buckets.zones as never,
      dnsRecords: buckets.dnsRecords as never,
      notificationWebhooks: buckets.notificationWebhooks as never,
      notificationPolicies: buckets.notificationPolicies as never,
      notificationEvents: buckets.notificationEvents as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors(CLOUDFLARE_PROVIDER, job, result);
}

async function writeNeonAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const bucketed = bucketByModel(records, job.model, NEON_PROVIDER);
  if (bucketed.provider !== NEON_PROVIDER) return [];
  const buckets = bucketed.buckets;

  const result = await emitNeonAuxiliaryFiles(
    toAuxiliaryEmitterClient(client),
    {
      workspaceId: job.workspaceId,
      organizations: buckets.organizations as never,
      projects: buckets.projects as never,
      branches: buckets.branches as never,
      endpoints: buckets.endpoints as never,
      operations: buckets.operations as never,
      projectConsumption: buckets.projectConsumption as never,
      branchConsumption: buckets.branchConsumption as never,
      spendingLimits: buckets.spendingLimits as never,
      advisorIssues: buckets.advisorIssues as never,
      connectionId: job.connectionId,
    },
  );
  return logEmitErrors(NEON_PROVIDER, job, result);
}

type DigestIndexRow = Record<string, unknown> & { id: string };

interface IndexCache {
  rows: Map<string, Map<string, DigestIndexRow>>;
  dirty: Set<string>;
  unsafeWritePaths: Map<string, unknown>;
}

function createIndexCache(): IndexCache {
  return { rows: new Map(), dirty: new Set(), unsafeWritePaths: new Map() };
}

function normalizeIndexRows(rows: readonly Record<string, unknown>[]): DigestIndexRow[] {
  return rows
    .map((row) => {
      const id = readFirstString(row, "id");
      return id ? ({ ...row, id } as DigestIndexRow) : null;
    })
    .filter((row): row is DigestIndexRow => row !== null);
}

function sortIndexRows(rows: readonly DigestIndexRow[]): DigestIndexRow[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

async function getIndexRows(
  cache: IndexCache,
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<DigestIndexRow[]> {
  const cached = cache.rows.get(path);
  if (cached) {
    return [...cached.values()];
  }
  let content: string | undefined;
  if (client.readFile) {
    try {
      const value = await client.readFile(workspaceId, path);
      content =
        typeof value === "string"
          ? value
          : value !== null && typeof value.content === "string"
            ? value.content
            : undefined;
    } catch (error) {
      if (!isNotFoundLikeError(error)) {
        cache.unsafeWritePaths.set(path, error);
      }
    }
  }
  let loaded: DigestIndexRow[] = [];
  if (content) {
    try {
      const parsed = JSON.parse(content) as unknown;
      loaded = Array.isArray(parsed)
        ? normalizeIndexRows(
            parsed.filter((item): item is Record<string, unknown> =>
              isObject(item),
            ),
          )
        : [];
    } catch (error) {
      cache.unsafeWritePaths.set(path, error);
    }
  }
  cache.rows.set(path, new Map(loaded.map((row) => [row.id, row])));
  return loaded;
}

function upsertIndexRow(cache: IndexCache, path: string, row: DigestIndexRow): void {
  const rows = cache.rows.get(path) ?? new Map<string, DigestIndexRow>();
  rows.set(row.id, row);
  cache.rows.set(path, rows);
  cache.dirty.add(path);
}

function deleteIndexRow(cache: IndexCache, path: string, id: string): void {
  const rows = cache.rows.get(path);
  if (!rows) {
    return;
  }
  if (!rows.delete(id)) {
    return;
  }
  cache.dirty.add(path);
}

async function flushIndexCache(
  cache: IndexCache,
  client: RelayfileWriteClient,
  workspaceId: string,
): Promise<void> {
  for (const path of cache.dirty) {
    const unsafeReadError = cache.unsafeWritePaths.get(path);
    if (unsafeReadError !== undefined) {
      throw new Error(
        `Refusing to write auxiliary index ${path} because its current contents could not be read`,
        { cause: unsafeReadError },
      );
    }
    const rows = sortIndexRows([...(cache.rows.get(path)?.values() ?? [])]);
    await writeManagedFile({
      client,
      workspaceId,
      path,
      content: `${JSON.stringify(sortIndexRows(rows))}\n`,
      contentType: "application/json; charset=utf-8",
    });
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function parseMailHeader(payload: Record<string, unknown>, headerName: string): string | null {
  const headers = payload.headers;
  if (!Array.isArray(headers)) {
    return null;
  }
  const lower = headerName.toLowerCase();
  for (const entry of headers) {
    if (!isObject(entry)) continue;
    const name = readFirstString(entry, "name");
    if (!name || name.toLowerCase() !== lower) continue;
    const value = readFirstString(entry, "value");
    if (value) return value;
  }
  return null;
}

function isGoogleMailMessageModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "googlemailmessage" || normalized === "message";
}

function isGoogleMailThreadModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "googlemailthread" || normalized === "thread";
}

function googleMailStableModel(model: string): GoogleMailStableModel | null {
  if (isGoogleMailMessageModel(model)) return "message";
  if (isGoogleMailThreadModel(model)) return "thread";
  return null;
}

function decodeGmailBodyData(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

type GoogleMailAttachmentRef = {
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  attachmentId: string | null;
  partId: string | null;
};

type GoogleMailBodyExtraction = {
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: GoogleMailAttachmentRef[];
};

function collectGmailMessageParts(
  part: Record<string, unknown>,
  output: {
    textParts: string[];
    htmlParts: string[];
    attachments: GoogleMailAttachmentRef[];
  },
): void {
  const mimeType = readFirstString(part, "mimeType")?.toLowerCase() ?? null;
  const filename = readFirstString(part, "filename");
  const partId = readFirstString(part, "partId");
  const body = readNestedRecord(part, "body");
  const data = body ? decodeGmailBodyData(body.data) : null;
  const attachmentId = body ? readFirstString(body, "attachmentId") : null;
  const size = body && typeof body.size === "number" ? body.size : null;

  if (data !== null && mimeType === "text/plain") {
    output.textParts.push(data);
  } else if (data !== null && mimeType === "text/html") {
    output.htmlParts.push(data);
  } else if (filename || attachmentId) {
    output.attachments.push({
      filename: filename ?? null,
      mimeType,
      size,
      attachmentId,
      partId,
    });
  }

  const children = Array.isArray(part.parts)
    ? part.parts.filter((entry): entry is Record<string, unknown> =>
        isObject(entry),
      )
    : [];
  for (const child of children) {
    collectGmailMessageParts(child, output);
  }
}

function extractGmailMessageBodies(
  record: Record<string, unknown>,
): GoogleMailBodyExtraction {
  const payload = readNestedRecord(record, "payload");
  if (!payload) {
    return { bodyText: null, bodyHtml: null, attachments: [] };
  }
  const collected = {
    textParts: [] as string[],
    htmlParts: [] as string[],
    attachments: [] as GoogleMailAttachmentRef[],
  };
  collectGmailMessageParts(payload, collected);
  return {
    bodyText:
      collected.textParts.length > 0 ? collected.textParts.join("\n\n") : null,
    bodyHtml:
      collected.htmlParts.length > 0 ? collected.htmlParts.join("\n\n") : null,
    attachments: collected.attachments,
  };
}

function readNullableStringField(
  record: Record<string, unknown>,
  field: string,
): string | null {
  return typeof record[field] === "string" ? record[field] : null;
}

function readGmailFlattenedHeader(
  record: Record<string, unknown>,
  payload: Record<string, unknown> | null,
  headerName: string,
  field: string,
): string | null {
  return (payload ? parseMailHeader(payload, headerName) : null) ??
    readNullableStringField(record, field);
}

function normalizeGoogleMailMessageRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const payload = readNestedRecord(record, "payload");
  const extracted = extractGmailMessageBodies(record);
  const existingAttachments = Array.isArray(record.attachments)
    ? record.attachments
    : [];
  const base = { ...record };
  delete base.payload;
  delete base.raw;
  delete base.raw_json;
  return {
    ...base,
    subject: readGmailFlattenedHeader(record, payload, "Subject", "subject"),
    from: readGmailFlattenedHeader(record, payload, "From", "from"),
    to: readGmailFlattenedHeader(record, payload, "To", "to"),
    cc: readGmailFlattenedHeader(record, payload, "Cc", "cc"),
    bcc: readGmailFlattenedHeader(record, payload, "Bcc", "bcc"),
    date: readGmailFlattenedHeader(record, payload, "Date", "date"),
    messageId: readGmailFlattenedHeader(record, payload, "Message-ID", "messageId"),
    inReplyTo: readGmailFlattenedHeader(record, payload, "In-Reply-To", "inReplyTo"),
    references: readGmailFlattenedHeader(record, payload, "References", "references"),
    body_text: payload ? extracted.bodyText : readNullableStringField(record, "body_text"),
    body_html: payload ? extracted.bodyHtml : readNullableStringField(record, "body_html"),
    attachments: payload ? extracted.attachments : existingAttachments,
  };
}

function compactGoogleMailThreadMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeGoogleMailMessageRecord(message);
  return {
    id: readFirstString(normalized, "id") ?? undefined,
    threadId: readFirstString(normalized, "threadId", "thread_id") ?? undefined,
    labelIds: Array.isArray(normalized.labelIds) ? normalized.labelIds : undefined,
    snippet: readFirstString(normalized, "snippet") ?? undefined,
    historyId: readFirstString(normalized, "historyId", "history_id") ?? undefined,
    internalDate: readFirstString(normalized, "internalDate", "internal_date") ?? undefined,
    subject: readFirstString(normalized, "subject") ?? undefined,
    from: readFirstString(normalized, "from") ?? undefined,
    to: readFirstString(normalized, "to") ?? undefined,
    date: readFirstString(normalized, "date") ?? undefined,
  };
}

function normalizeGoogleMailRecordForStorage(
  record: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (isGoogleMailMessageModel(model)) {
    return normalizeGoogleMailMessageRecord(record);
  }
  if (isGoogleMailThreadModel(model)) {
    const compactMessages = Array.isArray(record.messages)
      ? record.messages.map((entry) =>
          isObject(entry) ? compactGoogleMailThreadMessage(entry) : entry,
        )
      : record.messages;
    const base = { ...record };
    delete base.messages;
    delete base.raw;
    delete base.raw_json;
    const messageIds = Array.isArray(compactMessages)
      ? compactMessages
          .map((entry) => (isObject(entry) ? readFirstString(entry, "id") : null))
          .filter((id): id is string => Boolean(id))
      : [];
    return {
      ...base,
      messageIds,
      messageCount: messageIds.length,
      messages: compactMessages,
    };
  }
  return record;
}

function parseEmailAddresses(input: string | null): string[] {
  if (!input) {
    return [];
  }
  const matches = [...input.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)];
  if (matches.length === 0) {
    return [];
  }
  return [...new Set(matches.map((match) => match[0]!.trim().toLowerCase()))];
}

function normalizeDigestKey(input: string | null, fallback = "unknown"): string {
  if (!input) return fallback;
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || fallback;
}

function parseInternalDateDay(internalDate: string | null): string | null {
  if (!internalDate) return null;
  const parsed = parseProviderTimestampMs(internalDate);
  if (parsed === null) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function parseCalendarDayFromStart(start: Record<string, unknown> | null): {
  startValue: string | null;
  day: string | null;
  allDay: boolean;
} {
  if (!start) {
    return { startValue: null, day: null, allDay: false };
  }
  const date = readFirstString(start, "date");
  if (date) {
    return { startValue: date, day: date.slice(0, 10), allDay: true };
  }
  const dateTime = readFirstString(start, "dateTime", "date_time");
  if (!dateTime) {
    return { startValue: null, day: null, allDay: false };
  }
  const parsed = Date.parse(dateTime);
  const day = Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : dateTime.slice(0, 10);
  return { startValue: dateTime, day, allDay: false };
}

function googleMailMessageMainIndexPath(): string {
  return `/${GOOGLE_MAIL_PROVIDER}/messages/_index.json`;
}

function googleMailThreadMainIndexPath(): string {
  return `/${GOOGLE_MAIL_PROVIDER}/threads/_index.json`;
}

function googleMailLabelMainIndexPath(): string {
  return `/${GOOGLE_MAIL_PROVIDER}/labels/_index.json`;
}

function googleMailFilterMainIndexPath(): string {
  return `/${GOOGLE_MAIL_PROVIDER}/filters/_index.json`;
}

function googleMailSendAsMainIndexPath(): string {
  return `/${GOOGLE_MAIL_PROVIDER}/send-as/_index.json`;
}

function googleMailWatchMainIndexPath(): string {
  return `/${GOOGLE_MAIL_PROVIDER}/watch-renewals/_index.json`;
}

function googleCalendarCalendarMainIndexPath(): string {
  return `/${GOOGLE_CALENDAR_PROVIDER}/calendars/_index.json`;
}

function googleCalendarSettingMainIndexPath(): string {
  return `/${GOOGLE_CALENDAR_PROVIDER}/settings/_index.json`;
}

function googleCalendarColorMainIndexPath(): string {
  return `/${GOOGLE_CALENDAR_PROVIDER}/colors/_index.json`;
}

function googleCalendarEventMainIndexPath(): string {
  return `/${GOOGLE_CALENDAR_PROVIDER}/events/_index.json`;
}

function googleCalendarAclMainIndexPath(): string {
  return `/${GOOGLE_CALENDAR_PROVIDER}/acls/_index.json`;
}

function googleCalendarWatchMainIndexPath(): string {
  return `/${GOOGLE_CALENDAR_PROVIDER}/watch-renewals/_index.json`;
}

function byIdAliasPath(provider: string, resource: string, id: string): string {
  return `/${provider}/${resource}/by-id/${encodePathSegment(id)}.json`;
}

async function writeByIdRecordAlias(input: {
  client: RelayfileWriteClient;
  workspaceId: string;
  provider: string;
  resource: string;
  model: string;
  id: string;
  record: Record<string, unknown>;
  connectionId: string;
  canonicalPath?: string;
}): Promise<void> {
  const aliasPayload =
    input.provider === GOOGLE_MAIL_PROVIDER &&
    (input.resource === "messages" || input.resource === "threads")
      ? {
          provider: input.provider,
          objectType: input.model,
          objectId: input.id,
          canonicalPath:
            input.canonicalPath ??
            `/${input.provider}/${input.resource}/${encodePathSegment(input.id)}.json`,
          connectionId: input.connectionId,
        }
      : {
          provider: input.provider,
          objectType: input.model,
          objectId: input.id,
          payload: input.record,
          connectionId: input.connectionId,
        };
  await writeManagedFile({
    client: input.client,
    workspaceId: input.workspaceId,
    path: byIdAliasPath(input.provider, input.resource, input.id),
    content: `${JSON.stringify(aliasPayload, null, 2)}\n`,
    contentType: "application/json; charset=utf-8",
  });
}

async function deleteByIdRecordAlias(input: {
  client: RelayfileWriteClient;
  workspaceId: string;
  provider: string;
  resource: string;
  id: string;
}): Promise<void> {
  await deleteManagedFile(
    input.client,
    input.workspaceId,
    byIdAliasPath(input.provider, input.resource, input.id),
  );
}

function googleMailMessageFacetPaths(row: DigestIndexRow): string[] {
  const paths: string[] = [];
  const threadId = readFirstString(row, "threadId");
  if (threadId) {
    paths.push(
      `/${GOOGLE_MAIL_PROVIDER}/messages/by-thread/${encodePathSegment(threadId)}/_index.json`,
    );
  }

  for (const labelId of readStringArray(row.labelIds)) {
    paths.push(
      `/${GOOGLE_MAIL_PROVIDER}/messages/by-label/${encodePathSegment(labelId)}/_index.json`,
    );
  }

  const senderKey = readFirstString(row, "senderKey");
  if (senderKey) {
    paths.push(
      `/${GOOGLE_MAIL_PROVIDER}/messages/by-sender/${encodePathSegment(senderKey)}/_index.json`,
    );
  }

  const day = readFirstString(row, "day");
  if (day) {
    paths.push(
      `/${GOOGLE_MAIL_PROVIDER}/messages/by-day/${encodePathSegment(day)}/_index.json`,
    );
  }
  return paths;
}

function googleMailThreadFacetPaths(row: DigestIndexRow): string[] {
  const paths: string[] = [];
  for (const labelId of readStringArray(row.labelIds)) {
    paths.push(
      `/${GOOGLE_MAIL_PROVIDER}/threads/by-label/${encodePathSegment(labelId)}/_index.json`,
    );
  }
  for (const participant of readStringArray(row.participants)) {
    paths.push(
      `/${GOOGLE_MAIL_PROVIDER}/threads/by-participant/${encodePathSegment(participant)}/_index.json`,
    );
  }
  const day = readFirstString(row, "day");
  if (day) {
    paths.push(
      `/${GOOGLE_MAIL_PROVIDER}/threads/by-day/${encodePathSegment(day)}/_index.json`,
    );
  }
  return paths;
}

function googleCalendarEventFacetPaths(row: DigestIndexRow): string[] {
  const paths: string[] = [];
  const calendarId = readFirstString(row, "calendarId");
  if (calendarId) {
    paths.push(
      `/${GOOGLE_CALENDAR_PROVIDER}/events/by-calendar/${encodePathSegment(calendarId)}/_index.json`,
    );
  }
  const status = readFirstString(row, "status");
  if (status) {
    paths.push(
      `/${GOOGLE_CALENDAR_PROVIDER}/events/by-status/${encodePathSegment(status.toLowerCase())}/_index.json`,
    );
  }
  const organizer = readFirstString(row, "organizerKey");
  if (organizer) {
    paths.push(
      `/${GOOGLE_CALENDAR_PROVIDER}/events/by-organizer/${encodePathSegment(organizer)}/_index.json`,
    );
  }
  const day = readFirstString(row, "startDay");
  if (day) {
    paths.push(
      `/${GOOGLE_CALENDAR_PROVIDER}/events/by-day/${encodePathSegment(day)}/_index.json`,
    );
  }
  return paths;
}

function googleCalendarAclFacetPaths(row: DigestIndexRow): string[] {
  const paths: string[] = [];
  const calendarId = readFirstString(row, "calendarId");
  if (calendarId) {
    paths.push(
      `/${GOOGLE_CALENDAR_PROVIDER}/acls/by-calendar/${encodePathSegment(calendarId)}/_index.json`,
    );
  }
  const role = readFirstString(row, "role");
  if (role) {
    paths.push(
      `/${GOOGLE_CALENDAR_PROVIDER}/acls/by-role/${encodePathSegment(role.toLowerCase())}/_index.json`,
    );
  }
  return paths;
}

async function applyPrimaryAndFacets(input: {
  cache: IndexCache;
  client: RelayfileWriteClient;
  workspaceId: string;
  primaryPath: string;
  rowId: string;
  nextRow: DigestIndexRow | null;
  facetPathsForRow: (row: DigestIndexRow) => string[];
}): Promise<void> {
  const primaryRows = await getIndexRows(
    input.cache,
    input.client,
    input.workspaceId,
    input.primaryPath,
  );
  const prior = primaryRows.find((row) => row.id === input.rowId) ?? null;

  if (prior) {
    for (const path of input.facetPathsForRow(prior)) {
      await getIndexRows(input.cache, input.client, input.workspaceId, path);
      deleteIndexRow(input.cache, path, input.rowId);
    }
  }

  if (!input.nextRow) {
    deleteIndexRow(input.cache, input.primaryPath, input.rowId);
    return;
  }

  upsertIndexRow(input.cache, input.primaryPath, input.nextRow);
  for (const path of input.facetPathsForRow(input.nextRow)) {
    await getIndexRows(input.cache, input.client, input.workspaceId, path);
    upsertIndexRow(input.cache, path, input.nextRow);
  }
}

function buildGoogleMailMessageIndexRow(
  record: Record<string, unknown>,
): DigestIndexRow {
  const id = getRequiredId(record);
  const threadId = readFirstString(record, "threadId", "thread_id") ?? "";
  const payload = readNestedRecord(record, "payload");
  const subject = readFirstString(record, "subject") ?? (payload ? parseMailHeader(payload, "Subject") : null);
  const fromHeader = readFirstString(record, "from") ?? (payload ? parseMailHeader(payload, "From") : null);
  const toHeader = readFirstString(record, "to") ?? (payload ? parseMailHeader(payload, "To") : null);
  const senderEmail = parseEmailAddresses(fromHeader)[0] ?? null;
  const senderKey = normalizeDigestKey(senderEmail ?? fromHeader);
  const internalDate = readFirstString(record, "internalDate", "internal_date");
  const day = parseInternalDateDay(internalDate);
  return {
    id,
    threadId,
    subject: subject ?? undefined,
    sender: fromHeader ?? undefined,
    senderEmail: senderEmail ?? undefined,
    senderKey,
    recipients: parseEmailAddresses(toHeader),
    labelIds: readStringArray(record.labelIds),
    snippet: readFirstString(record, "snippet") ?? undefined,
    internalDate: internalDate ?? undefined,
    day: day ?? undefined,
    canonicalPath: computeGoogleMailRecordPath(record, "GoogleMailMessage"),
  };
}

function buildGoogleMailThreadIndexRow(record: Record<string, unknown>): DigestIndexRow {
  const id = getRequiredId(record);
  const messages = Array.isArray(record.messages)
    ? record.messages.filter((entry): entry is Record<string, unknown> => isObject(entry))
    : [];
  const subjects = messages
    .map((message) => {
      const payload = readNestedRecord(message, "payload");
      return readFirstString(message, "subject") ??
        (payload ? parseMailHeader(payload, "Subject") : null);
    })
    .filter((subject): subject is string => typeof subject === "string" && subject.length > 0);
  const fromValues = messages.flatMap((message) => {
    const payload = readNestedRecord(message, "payload");
    return parseEmailAddresses(
      readFirstString(message, "from") ??
        (payload ? parseMailHeader(payload, "From") : null),
    );
  });
  const toValues = messages.flatMap((message) => {
    const payload = readNestedRecord(message, "payload");
    return parseEmailAddresses(
      readFirstString(message, "to") ??
        (payload ? parseMailHeader(payload, "To") : null),
    );
  });
  const participants = [...new Set([...fromValues, ...toValues])];
  const labels = [
    ...new Set(
      messages.flatMap((message) =>
        readStringArray((message as Record<string, unknown>).labelIds),
      ),
    ),
  ];
  const internalDates = messages
    .map((message) =>
      parseProviderTimestampMs(
        readFirstString(message, "internalDate", "internal_date") ?? "",
      ),
    )
    .filter((value): value is number => value !== null);
  const latestMs =
    internalDates.length > 0 ? Math.max(...internalDates) : null;
  const day = latestMs !== null ? new Date(latestMs).toISOString().slice(0, 10) : null;
  return {
    id,
    subject: subjects[0] ?? undefined,
    participants,
    labelIds: labels,
    messageCount: messages.length,
    snippet: readFirstString(record, "snippet") ?? undefined,
    day: day ?? undefined,
    canonicalPath: computeGoogleMailRecordPath(record, "GoogleMailThread"),
  };
}

function buildGoogleCalendarEventIndexRow(record: Record<string, unknown>): DigestIndexRow {
  const id = getRequiredId(record);
  const calendarId = readFirstString(record, "calendarId", "calendar_id");
  const eventId = readFirstString(record, "eventId", "event_id");
  const organizer = readNestedRecord(record, "organizer");
  const creator = readNestedRecord(record, "creator");
  const organizerEmail =
    (organizer ? readFirstString(organizer, "email") : null) ??
    (creator ? readFirstString(creator, "email") : null);
  const organizerKey = normalizeDigestKey(organizerEmail);
  const startInfo = parseCalendarDayFromStart(readNestedRecord(record, "start"));
  const endInfo = parseCalendarDayFromStart(readNestedRecord(record, "end"));
  const attendees = Array.isArray(record.attendees) ? record.attendees : [];
  return {
    id,
    calendarId: calendarId ?? undefined,
    eventId: eventId ?? undefined,
    summary: readFirstString(record, "summary") ?? undefined,
    status: (readFirstString(record, "status") ?? "confirmed").toLowerCase(),
    organizerEmail: organizerEmail ?? undefined,
    organizerKey,
    attendeeCount: attendees.length,
    start: startInfo.startValue ?? undefined,
    end: endInfo.startValue ?? undefined,
    startDay: startInfo.day ?? undefined,
    isAllDay: startInfo.allDay,
    updated: readProviderTimestampString(record) ?? undefined,
    canonicalPath: computeGoogleCalendarRecordPath(record, "GoogleCalendarEvent"),
  };
}

function buildGoogleCalendarAclIndexRow(record: Record<string, unknown>): DigestIndexRow {
  const id = getRequiredId(record);
  const calendarId = readFirstString(record, "calendarId", "calendar_id");
  const ruleId = readFirstString(record, "ruleId", "rule_id");
  const role = readFirstString(record, "role");
  const scope = readNestedRecord(record, "scope");
  return {
    id,
    calendarId: calendarId ?? undefined,
    ruleId: ruleId ?? undefined,
    role: role ?? undefined,
    scopeType: scope ? readFirstString(scope, "type") ?? undefined : undefined,
    scopeValue: scope ? readFirstString(scope, "value") ?? undefined : undefined,
    canonicalPath: computeGoogleCalendarRecordPath(record, "GoogleCalendarAcl"),
  };
}

async function writeGoogleMailAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const errors: EmitAuxiliaryFilesResult["errors"] = [];
  const cache = createIndexCache();
  const normalizedModel = job.model.trim().toLowerCase();

  // Per-record exception isolation. cloud#801 follow-up: PR #825 already
  // moved `flushIndexCache` outside the outer try/catch so it always runs,
  // but that only helps if at least ONE record's body completed its
  // upsertIndexRow / applyPrimaryAndFacets before another threw. If
  // record #1's `writeByIdRecordAlias` throws (e.g. transient writeFile
  // failure, network blip, path-validation reject), the for-loop aborts
  // BEFORE any upsert happens, so the cache is empty and the always-run
  // flush is a no-op — exactly the rw_fc7b534b symptom (1000+ canonical
  // gmail messages, ZERO `_index.json` files). Wrap each record's body so
  // a throw on one record is captured, logged, and skipped — the rest of
  // the batch's upserts reach the cache and flush as intended.
  const processRecord = async (
    raw: Record<string, unknown>,
    body: () => Promise<void>,
  ): Promise<void> => {
    try {
      await body();
    } catch (error) {
      const recordId =
        readFirstString(stripNangoMetadata(raw), "id") ?? "<unknown>";
      errors.push({
        path: `/${GOOGLE_MAIL_PROVIDER}/_index.json`,
        error: `record ${recordId}: ${String(error)}`,
      });
      console.error("[record-writer] google-mail per-record aux emit failed", {
        area: "nango-sync-worker",
        provider: GOOGLE_MAIL_PROVIDER,
        model: job.model,
        syncName: job.syncName,
        workspaceId: job.workspaceId,
        recordId,
        stack: error instanceof Error ? error.stack : undefined,
        ...errorLogFields(error),
      });
    }
  };

  try {
    if (normalizedModel === "googlemailmessage" || normalizedModel === "message") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = normalizeGoogleMailRecordForStorage(stripNangoMetadata(raw), job.model);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          const nextRow = isAdapterDeleteRecord(raw)
            ? null
            : buildGoogleMailMessageIndexRow(cleaned);
          const canonicalPath = computeGoogleMailRecordPath(cleaned, "GoogleMailMessage");
          await getIndexRows(cache, client, job.workspaceId, googleMailMessageMainIndexPath());
          if (nextRow) {
            await writeByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_MAIL_PROVIDER,
              resource: "messages",
              model: "GoogleMailMessage",
              id,
              record: cleaned,
              connectionId: job.connectionId,
              canonicalPath,
            });
          } else {
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_MAIL_PROVIDER,
              resource: "messages",
              id,
            });
          }
          await applyPrimaryAndFacets({
            cache,
            client,
            workspaceId: job.workspaceId,
            primaryPath: googleMailMessageMainIndexPath(),
            rowId: id,
            nextRow,
            facetPathsForRow: googleMailMessageFacetPaths,
          });
        });
      }
    } else if (normalizedModel === "googlemailthread" || normalizedModel === "thread") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = normalizeGoogleMailRecordForStorage(stripNangoMetadata(raw), job.model);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          const nextRow = isAdapterDeleteRecord(raw)
            ? null
            : buildGoogleMailThreadIndexRow(cleaned);
          const canonicalPath = computeGoogleMailRecordPath(cleaned, "GoogleMailThread");
          await getIndexRows(cache, client, job.workspaceId, googleMailThreadMainIndexPath());
          if (nextRow) {
            await writeByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_MAIL_PROVIDER,
              resource: "threads",
              model: "GoogleMailThread",
              id,
              record: cleaned,
              connectionId: job.connectionId,
              canonicalPath,
            });
          } else {
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_MAIL_PROVIDER,
              resource: "threads",
              id,
            });
          }
          await applyPrimaryAndFacets({
            cache,
            client,
            workspaceId: job.workspaceId,
            primaryPath: googleMailThreadMainIndexPath(),
            rowId: id,
            nextRow,
            facetPathsForRow: googleMailThreadFacetPaths,
          });
        });
      }
    } else if (normalizedModel === "googlemaillabel" || normalizedModel === "label") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          await getIndexRows(cache, client, job.workspaceId, googleMailLabelMainIndexPath());
          if (isAdapterDeleteRecord(raw)) {
            deleteIndexRow(cache, googleMailLabelMainIndexPath(), id);
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_MAIL_PROVIDER,
              resource: "labels",
              id,
            });
            return;
          }
          await writeByIdRecordAlias({
            client,
            workspaceId: job.workspaceId,
            provider: GOOGLE_MAIL_PROVIDER,
            resource: "labels",
            model: "GoogleMailLabel",
            id,
            record: cleaned,
            connectionId: job.connectionId,
          });
          upsertIndexRow(cache, googleMailLabelMainIndexPath(), {
            id,
            title: readFirstString(cleaned, "name") ?? id,
            type: readFirstString(cleaned, "type") ?? undefined,
            messagesUnread: cleaned.messagesUnread,
            threadsUnread: cleaned.threadsUnread,
            canonicalPath: computeGoogleMailRecordPath(cleaned, "GoogleMailLabel"),
          });
        });
      }
    } else if (normalizedModel === "googlemailfilter" || normalizedModel === "filter") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          await getIndexRows(cache, client, job.workspaceId, googleMailFilterMainIndexPath());
          if (isAdapterDeleteRecord(raw)) {
            deleteIndexRow(cache, googleMailFilterMainIndexPath(), id);
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_MAIL_PROVIDER,
              resource: "filters",
              id,
            });
            return;
          }
          await writeByIdRecordAlias({
            client,
            workspaceId: job.workspaceId,
            provider: GOOGLE_MAIL_PROVIDER,
            resource: "filters",
            model: "GoogleMailFilter",
            id,
            record: cleaned,
            connectionId: job.connectionId,
          });
          upsertIndexRow(cache, googleMailFilterMainIndexPath(), {
            id,
            from: readFirstString(cleaned, "from") ?? undefined,
            to: readFirstString(cleaned, "to") ?? undefined,
            canonicalPath: computeGoogleMailRecordPath(cleaned, "GoogleMailFilter"),
          });
        });
      }
    } else if (normalizedModel === "googlemailsendasalias" || normalizedModel === "sendasalias") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id = readFirstString(cleaned, "id", "sendAsEmail", "send_as_email");
          if (!id) return;
          await getIndexRows(cache, client, job.workspaceId, googleMailSendAsMainIndexPath());
          if (isAdapterDeleteRecord(raw)) {
            deleteIndexRow(cache, googleMailSendAsMainIndexPath(), id);
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_MAIL_PROVIDER,
              resource: "send-as",
              id,
            });
            return;
          }
          await writeByIdRecordAlias({
            client,
            workspaceId: job.workspaceId,
            provider: GOOGLE_MAIL_PROVIDER,
            resource: "send-as",
            model: "GoogleMailSendAsAlias",
            id,
            record: cleaned,
            connectionId: job.connectionId,
          });
          upsertIndexRow(cache, googleMailSendAsMainIndexPath(), {
            id,
            sendAsEmail: readFirstString(cleaned, "sendAsEmail", "send_as_email", "id") ?? id,
            displayName: readFirstString(cleaned, "displayName", "display_name") ?? undefined,
            isPrimary: cleaned.isPrimary === true,
            treatAsAlias: cleaned.treatAsAlias === true,
            canonicalPath: computeGoogleMailRecordPath(cleaned, "GoogleMailSendAsAlias"),
          });
        });
      }
    } else if (normalizedModel === "googlemailwatchrenewal" || normalizedModel === "watchrenewal") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          await getIndexRows(cache, client, job.workspaceId, googleMailWatchMainIndexPath());
          if (isAdapterDeleteRecord(raw)) {
            deleteIndexRow(cache, googleMailWatchMainIndexPath(), id);
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_MAIL_PROVIDER,
              resource: "watch-renewals",
              id,
            });
            return;
          }
          await writeByIdRecordAlias({
            client,
            workspaceId: job.workspaceId,
            provider: GOOGLE_MAIL_PROVIDER,
            resource: "watch-renewals",
            model: "GoogleMailWatchRenewal",
            id,
            record: cleaned,
            connectionId: job.connectionId,
          });
          upsertIndexRow(cache, googleMailWatchMainIndexPath(), {
            id,
            historyId: readFirstString(cleaned, "historyId", "history_id") ?? undefined,
            expiration: readFirstString(cleaned, "expiration") ?? undefined,
            topicName: readFirstString(cleaned, "topicName", "topic_name") ?? undefined,
            canonicalPath: computeGoogleMailRecordPath(cleaned, "GoogleMailWatchRenewal"),
          });
        });
      }
    }
  } catch (error) {
    errors.push({
      path: `/${GOOGLE_MAIL_PROVIDER}/_index.json`,
      error: String(error),
    });
    console.error("[record-writer] google-mail auxiliary file emit failed", {
      area: "nango-sync-worker",
      provider: GOOGLE_MAIL_PROVIDER,
      model: job.model,
      syncName: job.syncName,
      workspaceId: job.workspaceId,
      stack: error instanceof Error ? error.stack : undefined,
      ...errorLogFields(error),
    });
  }

  // Flush ALWAYS — even if the record loop above threw mid-iteration, any
  // upserts already in the cache must reach disk. The earlier shape put the
  // flush INSIDE the try-block, so a per-record throw aborted the loop AND
  // skipped flush, leaving zero `_index.json` files for the whole provider —
  // the rw_fc7b534b symptom from cloud#801. Capture flush failures separately
  // so they surface as structured errors instead of an uncaught throw.
  try {
    await flushIndexCache(cache, client, job.workspaceId);
  } catch (flushError) {
    errors.push({
      path: `/${GOOGLE_MAIL_PROVIDER}/_index.json`,
      error: `flushIndexCache: ${String(flushError)}`,
    });
    console.error("[record-writer] google-mail flushIndexCache failed", {
      area: "nango-sync-worker",
      provider: GOOGLE_MAIL_PROVIDER,
      model: job.model,
      syncName: job.syncName,
      workspaceId: job.workspaceId,
      stack: flushError instanceof Error ? flushError.stack : undefined,
      ...errorLogFields(flushError),
    });
  }

  return errors;
}

async function writeGoogleCalendarAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const errors: EmitAuxiliaryFilesResult["errors"] = [];
  const cache = createIndexCache();
  const normalizedModel = job.model.trim().toLowerCase();

  // Per-record exception isolation. See writeGoogleMailAuxiliaryFiles for
  // rationale — same cloud#801 pattern: a throw on one record's body must
  // not abort the entire batch's aux emit.
  const processRecord = async (
    raw: Record<string, unknown>,
    body: () => Promise<void>,
  ): Promise<void> => {
    try {
      await body();
    } catch (error) {
      const recordId =
        readFirstString(stripNangoMetadata(raw), "id") ?? "<unknown>";
      errors.push({
        path: `/${GOOGLE_CALENDAR_PROVIDER}/_index.json`,
        error: `record ${recordId}: ${String(error)}`,
      });
      console.error("[record-writer] google-calendar per-record aux emit failed", {
        area: "nango-sync-worker",
        provider: GOOGLE_CALENDAR_PROVIDER,
        model: job.model,
        syncName: job.syncName,
        workspaceId: job.workspaceId,
        recordId,
        stack: error instanceof Error ? error.stack : undefined,
        ...errorLogFields(error),
      });
    }
  };

  try {
    if (normalizedModel === "googlecalendar" || normalizedModel === "calendar") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          await getIndexRows(cache, client, job.workspaceId, googleCalendarCalendarMainIndexPath());
          if (isAdapterDeleteRecord(raw)) {
            deleteIndexRow(cache, googleCalendarCalendarMainIndexPath(), id);
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_CALENDAR_PROVIDER,
              resource: "calendars",
              id,
            });
            return;
          }
          await writeByIdRecordAlias({
            client,
            workspaceId: job.workspaceId,
            provider: GOOGLE_CALENDAR_PROVIDER,
            resource: "calendars",
            model: "GoogleCalendar",
            id,
            record: cleaned,
            connectionId: job.connectionId,
          });
          upsertIndexRow(cache, googleCalendarCalendarMainIndexPath(), {
            id,
            title: readFirstString(cleaned, "summaryOverride", "summary", "id") ?? id,
            primary: cleaned.primary === true,
            accessRole: readFirstString(cleaned, "accessRole", "access_role") ?? undefined,
            timeZone: readFirstString(cleaned, "timeZone", "time_zone") ?? undefined,
            canonicalPath: computeGoogleCalendarRecordPath(cleaned, "GoogleCalendar"),
          });
        });
      }
    } else if (normalizedModel === "googlecalendarsetting" || normalizedModel === "calendarsetting" || normalizedModel === "setting") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          await getIndexRows(cache, client, job.workspaceId, googleCalendarSettingMainIndexPath());
          if (isAdapterDeleteRecord(raw)) {
            deleteIndexRow(cache, googleCalendarSettingMainIndexPath(), id);
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_CALENDAR_PROVIDER,
              resource: "settings",
              id,
            });
            return;
          }
          await writeByIdRecordAlias({
            client,
            workspaceId: job.workspaceId,
            provider: GOOGLE_CALENDAR_PROVIDER,
            resource: "settings",
            model: "GoogleCalendarSetting",
            id,
            record: cleaned,
            connectionId: job.connectionId,
          });
          upsertIndexRow(cache, googleCalendarSettingMainIndexPath(), {
            id,
            title: readFirstString(cleaned, "summary", "value", "id") ?? id,
            value: readFirstString(cleaned, "value") ?? undefined,
            canonicalPath: computeGoogleCalendarRecordPath(cleaned, "GoogleCalendarSetting"),
          });
        });
      }
    } else if (normalizedModel === "googlecalendarcolor" || normalizedModel === "calendarcolor" || normalizedModel === "color") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id =
            readFirstString(cleaned, "id", "colorId", "color_id") ??
            readFirstString(cleaned, "background", "foreground");
          if (!id) return;
          await getIndexRows(cache, client, job.workspaceId, googleCalendarColorMainIndexPath());
          if (isAdapterDeleteRecord(raw)) {
            deleteIndexRow(cache, googleCalendarColorMainIndexPath(), id);
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_CALENDAR_PROVIDER,
              resource: "colors",
              id,
            });
            return;
          }
          await writeByIdRecordAlias({
            client,
            workspaceId: job.workspaceId,
            provider: GOOGLE_CALENDAR_PROVIDER,
            resource: "colors",
            model: "GoogleCalendarColor",
            id,
            record: cleaned,
            connectionId: job.connectionId,
          });
          upsertIndexRow(cache, googleCalendarColorMainIndexPath(), {
            id,
            colorType: readFirstString(cleaned, "colorType", "color_type") ?? undefined,
            colorId: readFirstString(cleaned, "colorId", "color_id") ?? id,
            canonicalPath: computeGoogleCalendarRecordPath(cleaned, "GoogleCalendarColor"),
          });
        });
      }
    } else if (normalizedModel === "googlecalendarevent" || normalizedModel === "calendarevent" || normalizedModel === "event") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          const nextRow = isAdapterDeleteRecord(raw)
            ? null
            : buildGoogleCalendarEventIndexRow(cleaned);
          await getIndexRows(cache, client, job.workspaceId, googleCalendarEventMainIndexPath());
          if (nextRow) {
            await writeByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_CALENDAR_PROVIDER,
              resource: "events",
              model: "GoogleCalendarEvent",
              id,
              record: cleaned,
              connectionId: job.connectionId,
            });
          } else {
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_CALENDAR_PROVIDER,
              resource: "events",
              id,
            });
          }
          await applyPrimaryAndFacets({
            cache,
            client,
            workspaceId: job.workspaceId,
            primaryPath: googleCalendarEventMainIndexPath(),
            rowId: id,
            nextRow,
            facetPathsForRow: googleCalendarEventFacetPaths,
          });
        });
      }
    } else if (normalizedModel === "googlecalendaracl" || normalizedModel === "calendaracl" || normalizedModel === "acl") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          const nextRow = isAdapterDeleteRecord(raw)
            ? null
            : buildGoogleCalendarAclIndexRow(cleaned);
          await getIndexRows(cache, client, job.workspaceId, googleCalendarAclMainIndexPath());
          if (nextRow) {
            await writeByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_CALENDAR_PROVIDER,
              resource: "acls",
              model: "GoogleCalendarAcl",
              id,
              record: cleaned,
              connectionId: job.connectionId,
            });
          } else {
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_CALENDAR_PROVIDER,
              resource: "acls",
              id,
            });
          }
          await applyPrimaryAndFacets({
            cache,
            client,
            workspaceId: job.workspaceId,
            primaryPath: googleCalendarAclMainIndexPath(),
            rowId: id,
            nextRow,
            facetPathsForRow: googleCalendarAclFacetPaths,
          });
        });
      }
    } else if (normalizedModel === "googlecalendarwatchrenewal" || normalizedModel === "calendarwatchrenewal" || normalizedModel === "watchrenewal") {
      for (const raw of records) {
        await processRecord(raw, async () => {
          const cleaned = stripNangoMetadata(raw);
          const id = readFirstString(cleaned, "id");
          if (!id) return;
          await getIndexRows(cache, client, job.workspaceId, googleCalendarWatchMainIndexPath());
          if (isAdapterDeleteRecord(raw)) {
            deleteIndexRow(cache, googleCalendarWatchMainIndexPath(), id);
            await deleteByIdRecordAlias({
              client,
              workspaceId: job.workspaceId,
              provider: GOOGLE_CALENDAR_PROVIDER,
              resource: "watch-renewals",
              id,
            });
            return;
          }
          await writeByIdRecordAlias({
            client,
            workspaceId: job.workspaceId,
            provider: GOOGLE_CALENDAR_PROVIDER,
            resource: "watch-renewals",
            model: "GoogleCalendarWatchRenewal",
            id,
            record: cleaned,
            connectionId: job.connectionId,
          });
          upsertIndexRow(cache, googleCalendarWatchMainIndexPath(), {
            id,
            resourceType: readFirstString(cleaned, "resourceType", "resource_type") ?? undefined,
            expiration: readFirstString(cleaned, "expiration") ?? undefined,
            webhookUrl: readFirstString(cleaned, "webhookUrl", "webhook_url") ?? undefined,
            canonicalPath: computeGoogleCalendarRecordPath(cleaned, "GoogleCalendarWatchRenewal"),
          });
        });
      }
    }

  } catch (error) {
    errors.push({
      path: `/${GOOGLE_CALENDAR_PROVIDER}/_index.json`,
      error: String(error),
    });
    console.error("[record-writer] google-calendar auxiliary file emit failed", {
      area: "nango-sync-worker",
      provider: GOOGLE_CALENDAR_PROVIDER,
      model: job.model,
      syncName: job.syncName,
      workspaceId: job.workspaceId,
      stack: error instanceof Error ? error.stack : undefined,
      ...errorLogFields(error),
    });
  }

  // Flush ALWAYS — see writeGoogleMailAuxiliaryFiles for rationale (cloud#801).
  try {
    await flushIndexCache(cache, client, job.workspaceId);
  } catch (flushError) {
    errors.push({
      path: `/${GOOGLE_CALENDAR_PROVIDER}/_index.json`,
      error: `flushIndexCache: ${String(flushError)}`,
    });
    console.error("[record-writer] google-calendar flushIndexCache failed", {
      area: "nango-sync-worker",
      provider: GOOGLE_CALENDAR_PROVIDER,
      model: job.model,
      syncName: job.syncName,
      workspaceId: job.workspaceId,
      stack: flushError instanceof Error ? flushError.stack : undefined,
      ...errorLogFields(flushError),
    });
  }

  return errors;
}

const googleMailRecordBucketing = modelBucket({
  normalizeModel: literalModelNormalizer({
    GoogleMailLabel: "label",
    label: "label",
    GoogleMailFilter: "filter",
    filter: "filter",
    GoogleMailSendAsAlias: "send-as",
    SendAsAlias: "send-as",
    "send-as": "send-as",
    sendas: "send-as",
    GoogleMailMessage: "message",
    message: "message",
    GoogleMailThread: "thread",
    thread: "thread",
    GoogleMailWatchRenewal: "watch-renewal",
    WatchRenewal: "watch-renewal",
    "watch-renewal": "watch-renewal",
  }),
  buckets: {
    label: "labels",
    filter: "filters",
    "send-as": "send-as",
    message: "messages",
    thread: "threads",
    "watch-renewal": "watch-renewals",
  },
});

const googleCalendarRecordBucketing = modelBucket({
  normalizeModel: literalModelNormalizer({
    GoogleCalendar: "calendar",
    calendar: "calendar",
    GoogleCalendarSetting: "setting",
    CalendarSetting: "setting",
    setting: "setting",
    GoogleCalendarColor: "color",
    CalendarColor: "color",
    color: "color",
    GoogleCalendarEvent: "event",
    CalendarEvent: "event",
    event: "event",
    GoogleCalendarAcl: "acl",
    CalendarAcl: "acl",
    acl: "acl",
    GoogleCalendarWatchRenewal: "watch-renewal",
    CalendarWatchRenewal: "watch-renewal",
    WatchRenewal: "watch-renewal",
    "watch-renewal": "watch-renewal",
  }),
  buckets: {
    calendar: "calendars",
    setting: "settings",
    color: "colors",
    event: "events",
    acl: "acls",
    "watch-renewal": "watch-renewals",
  },
});

// ===========================================================================
// THE CANONICAL ADAPTER REGISTRY
// ===========================================================================
//
// `ADAPTERS` is the SOLE place an integration is registered with the cloud
// record writer. To add a new integration there is exactly ONE edit in this
// file: import its adapter package and push one `RegisteredAdapter` entry
// here. `writeCommonLayouts` (LAYOUT advertiser), `writeProviderDiscovery`
// (discovery producer), `bucketByModel` (sync-ingest bucketing), and
// `writeProviderAuxiliaryFiles` (aux emitter) all drive generically off
// `resolveAdapter`.
//
// STRUCTURAL DRIFT PREVENTION
// ---------------------------
// The original defect class was: an adapter's LAYOUT.md advertises a
// `discovery/<provider>/.../.schema.json` contract while no code materializes
// it (or resources exist with nothing advertising them). That divergence is
// now structurally impossible: a SINGLE registry entry supplies the
// `layoutPromptFile` (advertiser), `resources` (producer input),
// `recordBucketing` (model-to-resource routing), and the `emitAuxiliaryFiles`
// closure. They cannot be wired to different sources because there is only
// one source — the entry. `resolveAdapter` returns that one entry;
// layout/discovery/bucketing/aux all consume the same entry for a given sync.
// `assertLayoutDiscoveryConsistency` (kept, called from
// `writeCommonLayouts`) and the registry structural test
// (`record-writer.test.ts`) are belt-and-braces over this guarantee, not the
// primary defense.
//
// SIGNATURE VARIANCE
// ------------------
// Each adapter package's `emit*AuxiliaryFiles` has a different argument shape
// (and gitlab additionally needs project/tombstone/tag reconciliation).
// `emitAuxiliaryFiles` is a thin per-entry closure delegating to the existing
// `writeXAuxiliaryFiles` wrapper, which already owns that per-package
// adaptation. The generic caller passes ONE common context
// `(client, objects, job)`; behaviour/arguments/ordering/error accumulation
// are byte-for-byte identical to the pre-registry per-provider dispatch.

export interface RegisteredAdapter {
  /** Stable adapter id (canonical provider key). */
  id: string;
  /**
   * True when this adapter owns `provider`. The slack entry encodes the
   * historical `provider.startsWith("slack-")` prefix rule here so multi-
   * workspace slack connection keys (`slack-foo`) resolve to slack exactly
   * as the pre-refactor `resourcesForProvider` / dispatch did.
   */
  matches(provider: string): boolean;
  /** The provider LAYOUT.md builder (discovery-contract ADVERTISER). */
  layoutPromptFile(): { path: string; content: string; contentType?: string };
  /**
   * The adapter's writable-resource manifest (discovery PRODUCER input). The
   * SAME array the adapter's `layoutPromptFile()` text and the
   * `executeFileNativeWriteback` router derive from. Empty for adapters that
   * advertise no discovery contract (e.g. `x`), which makes the discovery
   * producer early-return exactly like the old `resourcesForProvider`
   * returning `[]`.
   */
  resources: readonly AdapterResourceConfig[];
  /**
   * Sync-ingest model bucketing for this adapter's auxiliary emitter and
   * discovery sampling. This keeps model -> bucket mapping in the same
   * adapter catalog entry as layout, resources, and materialization.
   */
  recordBucketing: AdapterRecordBucketing;
  /**
   * Optional canonical record writer. New adapters should register provider-
   * specific write paths here instead of extending `writeProviderRecord`.
   */
  writeRecord?(
    client: RelayfileWriteClient,
    raw: Record<string, unknown>,
    job: NangoSyncJob,
  ): Promise<RecordWriteOutcome>;
  /**
   * Aux-file emission. Per-entry closure that maps the ONE common context to
   * this package's actual `emit*AuxiliaryFiles` signature (and any extra
   * reconciliation, e.g. gitlab). Returns accumulated per-path errors.
   */
  emitAuxiliaryFiles(
    client: RelayfileWriteClient,
    objects: readonly Record<string, unknown>[],
    job: NangoSyncJob,
  ): Promise<EmitAuxiliaryFilesResult["errors"]>;
}

/**
 * THE single add-point for a new integration. Add one entry (import the
 * adapter package above + push here) and the provider automatically gets
 * LAYOUT + discovery + aux with zero other edits in this file.
 *
 * Order matters only for `resolveAdapter`'s first-match semantics; entries
 * are mutually exclusive by `matches()` so order is not load-bearing today.
 */
export const ADAPTERS: readonly RegisteredAdapter[] = [
  {
    id: "github",
    matches: (p) => p === "github",
    layoutPromptFile: githubLayoutPromptFile,
    resources: githubResources as readonly AdapterResourceConfig[],
    recordBucketing: githubRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeGitHubAuxiliaryFiles(client, objects, job),
  },
  {
    id: "gitlab",
    matches: (p) => p === "gitlab",
    layoutPromptFile: gitLabLayoutPromptFile,
    resources: gitLabResources as readonly AdapterResourceConfig[],
    recordBucketing: gitlabRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeGitLabAuxiliaryFiles(client, objects, job),
  },
  {
    id: "linear",
    matches: (p) => p === "linear",
    layoutPromptFile: linearLayoutPromptFile,
    resources: linearResources as readonly AdapterResourceConfig[],
    recordBucketing: linearRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeLinearAuxiliaryFiles(client, objects, job),
  },
  {
    id: "notion",
    matches: (p) => p === "notion",
    layoutPromptFile: notionLayoutPromptFile,
    resources: notionResources as readonly AdapterResourceConfig[],
    recordBucketing: notionRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeNotionAuxiliaryFiles(client, objects, job),
  },
  {
    id: "hubspot",
    matches: (p) => p === "hubspot",
    layoutPromptFile: hubspotLayoutPromptFile,
    resources: hubspotResources as readonly AdapterResourceConfig[],
    recordBucketing: hubSpotRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeHubSpotAuxiliaryFiles(client, objects, job),
  },
  {
    id: "confluence",
    matches: (p) => p === "confluence",
    layoutPromptFile: confluenceLayoutPromptFile,
    resources: confluenceResources as readonly AdapterResourceConfig[],
    recordBucketing: confluenceRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeConfluenceAuxiliaryFiles(client, objects, job),
  },
  {
    id: "jira",
    matches: (p) => p === "jira",
    layoutPromptFile: jiraLayoutPromptFile,
    resources: jiraResources as readonly AdapterResourceConfig[],
    recordBucketing: jiraRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeJiraAuxiliaryFiles(client, objects, job),
  },
  {
    id: "slack",
    // Historical rule preserved verbatim: bare `slack` OR any `slack-*`
    // multi-workspace connection key maps to the slack adapter.
    matches: (p) => p === "slack" || p.startsWith("slack-"),
    layoutPromptFile: slackLayoutPromptFile,
    resources: slackResources as readonly AdapterResourceConfig[],
    recordBucketing: slackRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeSlackAuxiliaryFiles(client, objects, job),
  },
  {
    id: TELEGRAM_PROVIDER,
    matches: (p) => isTelegramProvider(p),
    layoutPromptFile: telegramLayoutPromptFile,
    resources: telegramResources as readonly AdapterResourceConfig[],
    recordBucketing: telegramRecordBucketing,
    writeRecord: (client, raw, job) => writeTelegramRecord(client, raw, job),
    emitAuxiliaryFiles: (client, objects, job) =>
      writeTelegramAuxiliaryFiles(client, objects, job),
  },
  {
    id: GOOGLE_MAIL_PROVIDER,
    matches: (p) => isGoogleMailProvider(p),
    layoutPromptFile: googleMailLayoutPromptFile,
    resources: GOOGLE_MAIL_RESOURCES,
    recordBucketing: googleMailRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeGoogleMailAuxiliaryFiles(client, objects, job),
  },
  {
    id: GOOGLE_CALENDAR_PROVIDER,
    matches: (p) => isGoogleCalendarProvider(p),
    layoutPromptFile: googleCalendarLayoutPromptFile,
    resources: GOOGLE_CALENDAR_RESOURCES,
    recordBucketing: googleCalendarRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeGoogleCalendarAuxiliaryFiles(client, objects, job),
  },
  {
    id: GRANOLA_PROVIDER,
    matches: (p) => isGranolaProvider(p),
    layoutPromptFile: granolaLayoutPromptFile,
    resources: granolaResources as readonly AdapterResourceConfig[],
    recordBucketing: granolaRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeGranolaAuxiliaryFiles(client, objects, job),
  },
  {
    id: RECALL_PROVIDER,
    matches: (p) => isRecallProvider(p),
    layoutPromptFile: recallLayoutPromptFile,
    resources: RECALL_RESOURCES,
    recordBucketing: recallRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeRecallAuxiliaryFiles(client, objects, job),
  },
  {
    id: FATHOM_PROVIDER,
    matches: (p) => isFathomProvider(p),
    layoutPromptFile: fathomLayoutPromptFile,
    resources: fathomResources as readonly AdapterResourceConfig[],
    recordBucketing: fathomRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeFathomAuxiliaryFiles(client, objects, job),
  },
  {
    id: DOCKER_HUB_PROVIDER,
    matches: (p) => isDockerHubProvider(p),
    layoutPromptFile: dockerHubLayoutPromptFile,
    resources: DOCKER_HUB_RESOURCES,
    recordBucketing: dockerHubRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeDockerHubAuxiliaryFiles(client, objects, job),
  },
  {
    id: REDDIT_PROVIDER,
    matches: (p) => isRedditProvider(p),
    layoutPromptFile: redditLayoutPromptFile,
    resources: redditResources as readonly AdapterResourceConfig[],
    recordBucketing: redditRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeRedditAuxiliaryFiles(client, objects, job),
  },
  {
    id: DROPBOX_PROVIDER,
    matches: (p) => isDropboxProvider(p),
    layoutPromptFile: dropboxLayoutPromptFile,
    resources: dropboxResources as readonly AdapterResourceConfig[],
    recordBucketing: dropboxRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeDropboxAuxiliaryFiles(client, objects, job),
  },
  {
    id: DAYTONA_PROVIDER,
    matches: (p) => p === DAYTONA_PROVIDER,
    layoutPromptFile: daytonaLayoutPromptFile,
    resources: daytonaResources as readonly AdapterResourceConfig[],
    recordBucketing: daytonaRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeDaytonaAuxiliaryFiles(client, objects, job),
  },
  {
    id: GCP_PROVIDER,
    matches: (p) => isGcpProvider(p),
    layoutPromptFile: gcpLayoutPromptFile,
    resources: gcpResources as readonly AdapterResourceConfig[],
    recordBucketing: gcpRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeGcpAuxiliaryFiles(client, objects, job),
  },
  {
    id: CLOUDFLARE_PROVIDER,
    matches: (p) => isCloudflareProvider(p),
    layoutPromptFile: cloudflareLayoutPromptFile,
    resources: cloudflareResources as readonly AdapterResourceConfig[],
    recordBucketing: cloudflareRecordBucketing,
    writeRecord: (client, raw, job) =>
      writeCloudflareRecord(client, raw, job),
    emitAuxiliaryFiles: (client, objects, job) =>
      writeCloudflareAuxiliaryFiles(client, objects, job),
  },
  {
    id: NEON_PROVIDER,
    matches: (p) => isNeonProvider(p),
    layoutPromptFile: neonLayoutPromptFile,
    resources: neonResources as readonly AdapterResourceConfig[],
    recordBucketing: neonRecordBucketing,
    writeRecord: (client, raw, job) =>
      writeNeonRecord(client, raw, job),
    emitAuxiliaryFiles: (client, objects, job) =>
      writeNeonAuxiliaryFiles(client, objects, job),
  },
  {
    id: "x",
    // `twitter` is the legacy alias the pre-refactor dispatch also accepted.
    matches: (p) => p === "x" || p === "twitter",
    layoutPromptFile: xLayoutPromptFile,
    // `x` advertises NO discovery contract and ships no writable resources.
    // Empty resources => `writeProviderDiscovery` early-returns, identical to
    // the old `resourcesForProvider` returning `[]` for `x`.
    resources: [],
    recordBucketing: xRecordBucketing,
    emitAuxiliaryFiles: (client, objects, job) =>
      writeXAuxiliaryFiles(client, objects, job),
  },
];

/**
 * Resolve the canonical adapter for a provider key, or `undefined` for
 * unknown providers. Replaces `resourcesForProvider` plus every per-provider
 * branch. Preserves pre-refactor semantics exactly:
 *  - `slack-foo` → slack adapter (prefix rule lives in slack's `matches`)
 *  - `x` / `twitter` → x adapter (empty resources => discovery no-ops)
 *  - unknown → `undefined` (callers fall back to generic layout / no-op aux
 *    / empty discovery, exactly as before)
 */
export function resolveAdapter(
  provider: string,
): RegisteredAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.matches(provider));
}

export function bucketByModel(
  records: readonly unknown[],
  model: string,
  provider: string,
): ProviderBuckets {
  const adapter = resolveAdapter(provider.trim().toLowerCase());
  return bucketForAdapter(records, model, adapter);
}

async function writeProviderAuxiliaryFiles(
  client: RelayfileWriteClient,
  records: readonly unknown[],
  job: NangoSyncJob,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const provider = job.provider.trim().toLowerCase();
  const adapter = resolveAdapter(provider);
  if (!adapter) {
    return [];
  }

  if (!client.readFile) {
    // Reconciliation requires read access; without it, alias deletes on
    // rename/status-change would race with canonical writes. Surface this as
    // a non-fatal sync error instead of silently skipping every aux file.
    const error =
      "Auxiliary file emission skipped because Relayfile client lacks readFile capability";
    console.warn("[record-writer] auxiliary emit skipped: no readFile capability", {
      area: "nango-sync-worker",
      provider,
      model: job.model,
      syncName: job.syncName,
      workspaceId: job.workspaceId,
      adapter: adapter.id,
      error,
    });
    return [{ path: `/${adapter.id}/_index.json`, error }];
  }

  const objects = records.filter(
    (r): r is Record<string, unknown> =>
      r !== null && typeof r === "object" && !Array.isArray(r),
  );
  return await adapter.emitAuxiliaryFiles(client, objects, job);
}

type StagedBulkWriteFile = {
  op?: "upsert";
  path: string;
  dependsOn?: string[];
  content: string;
  contentType?: string;
  encoding: "utf-8" | "base64";
  semantics?: FileSemantics;
};

type StagedBulkDeleteFile = {
  op: "delete";
  path: string;
  dependsOn?: string[];
  baseRevision: "*" | string;
};

interface StagedBulkWrite {
  file: StagedBulkWriteFile | StagedBulkDeleteFile;
  ownerOffsets: Set<number>;
  attribution: "record" | "auxiliary" | "unattributed";
}

interface StagedBulkBuffer {
  writes: StagedBulkWrite[];
}

function stagedNotFound(path: string): Error & { status: number } {
  const error = new Error(`staged file not found: ${path}`) as Error & {
    status: number;
  };
  error.status = 404;
  return error;
}

function readStagedBulkFile(
  buffer: StagedBulkBuffer,
  path: string,
): { content: string; revision: string } | "deleted" | null {
  for (let index = buffer.writes.length - 1; index >= 0; index -= 1) {
    const staged = buffer.writes[index]?.file;
    if (!staged || staged.path !== path) {
      continue;
    }
    if (staged.op === "delete") {
      return "deleted";
    }
    return {
      content: staged.content,
      revision: `staged:${index}`,
    };
  }
  return null;
}

function createStagedBulkClient(
  client: RelayfileWriteClient,
  buffer: StagedBulkBuffer,
  ownerOffsets: readonly number[] = [],
  attribution: StagedBulkWrite["attribution"] = "unattributed",
): RelayfileWriteClient {
  return {
    ...(client.readFile
      ? {
          readFile: (
            workspaceId: string,
            path: string,
            correlationId?: string,
            signal?: AbortSignal,
          ) => {
            const staged = readStagedBulkFile(buffer, path);
            if (staged === "deleted") {
              throw stagedNotFound(path);
            }
            if (staged) {
              return Promise.resolve(staged);
            }
            return client.readFile!(workspaceId, path, correlationId, signal);
          },
        }
      : {}),
    ...(client.listTree
      ? {
          listTree: (
            workspaceId: string,
            options?: Parameters<NonNullable<RelayfileWriteClient["listTree"]>>[1],
          ) => client.listTree!(workspaceId, options),
        }
      : {}),
    async writeFile(input) {
      buffer.writes.push({
        ownerOffsets: new Set(ownerOffsets),
        attribution,
        file: {
          path: input.path,
          content: input.content,
          contentType: input.contentType,
          encoding: input.encoding,
          ...(input.semantics ? { semantics: input.semantics } : {}),
        },
      });
    },
    async deleteFile(input) {
      buffer.writes.push({
        ownerOffsets: new Set(ownerOffsets),
        attribution,
        file: {
          op: "delete",
          path: input.path,
          baseRevision: input.baseRevision,
        },
      });
    },
  };
}

function coalesceStagedWrites(
  writes: readonly StagedBulkWrite[],
): Array<
  BulkWriteMutation & {
    ownerOffsets: Set<number>;
    attributions: Set<StagedBulkWrite["attribution"]>;
  }
> {
  const byPath = new Map<
    string,
    BulkWriteMutation & {
      ownerOffsets: Set<number>;
      attributions: Set<StagedBulkWrite["attribution"]>;
    }
  >();

  for (const [index, write] of writes.entries()) {
    const coalescingKey =
      write.file.op === "delete"
        ? `${write.file.path}\0delete\0${index}`
        : write.file.path;
    const existing = byPath.get(coalescingKey);
    const ownerOffsets = existing?.ownerOffsets ?? new Set<number>();
    const attributions = existing?.attributions ?? new Set<StagedBulkWrite["attribution"]>();
    for (const owner of write.ownerOffsets) {
      ownerOffsets.add(owner);
    }
    attributions.add(write.attribution);
    byPath.set(coalescingKey, {
      ...write.file,
      ownerOffsets,
      attributions,
    });
  }

  return [...byPath.values()];
}

function recordDependenciesForStagedWrite(
  write: BulkWriteMutation & {
    ownerOffsets: Set<number>;
    attributions: Set<StagedBulkWrite["attribution"]>;
  },
  recordPathsByOwnerOffset: ReadonlyMap<number, ReadonlySet<string>>,
): string[] {
  if (write.attributions.has("record")) {
    return [];
  }

  const dependencies = new Set<string>();
  for (const ownerOffset of write.ownerOffsets) {
    for (const path of recordPathsByOwnerOffset.get(ownerOffset) ?? []) {
      dependencies.add(path);
    }
  }
  return [...dependencies].sort();
}

function bulkWriteErrorCode(error: unknown): string {
  if (isObject(error) && typeof error.code === "string" && error.code) {
    return error.code;
  }
  return "bulk_write_failed";
}

function bulkWriteErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Relayfile bulk write failed.";
}

function bulkWriteErrorSample(
  error: { path: string; code: string; message: string },
  ownerOffsets: readonly number[],
): BulkWriteErrorSample {
  return {
    path: error.path,
    code: error.code,
    message: error.message,
    ownerOffsets: [...ownerOffsets],
  };
}

function logNangoRecordWriteFailed(job: NangoSyncJob, reason: unknown): void {
  console.error("Nango record write failed", {
    area: "nango-sync-worker",
    provider: job.provider,
    model: job.model,
    syncName: job.syncName,
    workspaceId: job.workspaceId,
    stack: reason instanceof Error ? reason.stack : undefined,
    ...errorLogFields(reason),
  });
}

function logNangoBulkWriteFailed(
  job: NangoSyncJob,
  error: unknown,
  ownerOffsets: readonly number[],
): void {
  console.error("Nango staged Relayfile bulk write failed", {
    area: "nango-sync-worker",
    provider: job.provider,
    model: job.model,
    syncName: job.syncName,
    workspaceId: job.workspaceId,
    ownerOffsets,
    stack: error instanceof Error ? error.stack : undefined,
    ...errorLogFields(error),
  });
}

// Relayfile #306: a `/fs/bulk` POST returns 202 with a raw committed count. If
// the DO accepts the request but commits fewer rows than were sent — without
// reporting them as per-file errors (partial-batch rollback / shard race) — the
// sync would otherwise read "no errors" as full success and silently lose
// records ("accepted but unreadable"). Logged loudly so the shortfall is
// observable; the caller also surfaces it as page errors.
/** Thrown when a `/fs/bulk` flush commits fewer rows than were sent without
 * flagging them as errors (relayfile#306). Propagates out of the sync page so
 * the CF Workflow step fails and retries instead of advancing the cursor. */
export class NangoBulkWriteUnderCommittedError extends Error {
  readonly code = "bulk_write_under_committed";
  readonly detail: {
    sent: number;
    committed: number;
    deduped: number;
    errored: number;
    shortfall: number;
  };
  constructor(
    job: Pick<NangoSyncJob, "provider" | "model" | "syncName">,
    detail: {
      sent: number;
      committed: number;
      deduped: number;
      errored: number;
      shortfall: number;
    },
  ) {
    super(
      `Relayfile bulk write under-committed for ${job.provider}/${job.model}/${job.syncName}: ` +
        `sent=${detail.sent} committed=${detail.committed} deduped=${detail.deduped} ` +
        `errored=${detail.errored} shortfall=${detail.shortfall}`,
    );
    this.name = "NangoBulkWriteUnderCommittedError";
    this.detail = detail;
  }
}

function logNangoBulkWriteUnaccounted(
  job: NangoSyncJob,
  detail: {
    correlationId?: string;
    sent: number;
    committed: number;
    deduped: number;
    errored: number;
    shortfall: number;
  },
): void {
  console.error("Nango staged Relayfile bulk write under-committed", {
    area: "nango-sync-worker",
    provider: job.provider,
    model: job.model,
    syncName: job.syncName,
    workspaceId: job.workspaceId,
    ...detail,
  });
}

type RelayfileBulkWriteInput = Parameters<
  NonNullable<RelayfileWriteClient["bulkWrite"]>
>[0];
type RelayfileBulkWriteResult = Awaited<
  ReturnType<NonNullable<RelayfileWriteClient["bulkWrite"]>>
>;

function readHeaderValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  const lowerName = name.toLowerCase();
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value?.trim() || null;
  }
  if (typeof headers !== "object" || Array.isArray(headers)) return null;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (Array.isArray(value)) {
      const first = value.find(
        (entry): entry is string => typeof entry === "string",
      );
      return first?.trim() || null;
    }
    if (typeof value === "string") return value.trim() || null;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function retryableBulkWriteStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.status === "number") return record.status;
  const response = record.response as Record<string, unknown> | undefined;
  return typeof response?.status === "number" ? response.status : null;
}

function retryableBulkWriteCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function retryAfterDelayMs(error: unknown, now: number): number | null {
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const response =
    record.response && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : {};
  const value =
    readHeaderValue(record.headers, "retry-after") ??
    readHeaderValue(response.headers, "retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, BULK_WRITE_BUSY_RETRY_MAX_DELAY_MS);
    }

    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) {
      return Math.min(
        Math.max(0, dateMs - now),
        BULK_WRITE_BUSY_RETRY_MAX_DELAY_MS,
      );
    }
  }

  for (const candidate of [
    record.retryAfterSeconds,
    record.details,
    record.body,
    response.body,
  ]) {
    if (typeof candidate === "number" && candidate >= 0) {
      return Math.min(candidate * 1000, BULK_WRITE_BUSY_RETRY_MAX_DELAY_MS);
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const retryAfterSeconds = (candidate as Record<string, unknown>)
      .retryAfterSeconds;
    if (typeof retryAfterSeconds === "number" && retryAfterSeconds >= 0) {
      return Math.min(
        retryAfterSeconds * 1000,
        BULK_WRITE_BUSY_RETRY_MAX_DELAY_MS,
      );
    }
  }

  return null;
}

function isRetryableBulkWriteBackpressure(error: unknown): boolean {
  if (retryableBulkWriteStatus(error) !== 429) return false;
  const code = retryableBulkWriteCode(error);
  return code !== null && BULK_WRITE_BUSY_RETRYABLE_CODES.has(code);
}

function bulkWriteBackoffMs(attempt: number): number {
  const base = Math.min(
    BULK_WRITE_BUSY_RETRY_MAX_DELAY_MS,
    BULK_WRITE_BUSY_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
  );
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.floor(base * jitter);
}

function nextBulkWriteRetryDelayMs(
  error: unknown,
  attempt: number,
  now: number,
): number {
  return retryAfterDelayMs(error, now) ?? bulkWriteBackoffMs(attempt);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bulkWriteWithWorkspaceBusyRetry(
  client: RelayfileWriteClient,
  input: RelayfileBulkWriteInput,
  job: NangoSyncJob,
): Promise<RelayfileBulkWriteResult> {
  if (!client.bulkWrite) {
    throw new Error("Relayfile client bulkWrite capability is required");
  }

  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return await client.bulkWrite(input);
    } catch (error) {
      const now = Date.now();
      const retryDelayMs = nextBulkWriteRetryDelayMs(error, attempts, now);
      const retryDeadlineExceeded =
        now + retryDelayMs - startedAt > BULK_WRITE_BUSY_RETRY_DEADLINE_MS;
      if (
        isRetryableBulkWriteBackpressure(error) &&
        attempts < BULK_WRITE_BUSY_RETRY_MAX_ATTEMPTS &&
        !retryDeadlineExceeded
      ) {
        console.warn("Nango staged Relayfile bulk write busy; retrying", {
          area: "nango-sync-worker",
          provider: job.provider,
          model: job.model,
          syncName: job.syncName,
          workspaceId: job.workspaceId,
          attempt: attempts,
          retryDelayMs,
          status: retryableBulkWriteStatus(error),
          code: retryableBulkWriteCode(error),
          correlationId: input.correlationId,
        });
        await sleep(retryDelayMs);
        continue;
      }
      throw error;
    }
  }
}

async function flushStagedBulkWrites(
  client: RelayfileWriteClient,
  buffer: StagedBulkBuffer,
  job: NangoSyncJob,
): Promise<{
  failedRecordOwnerOffsets: Set<number>;
  ownerErrorOffsets: Set<number>;
  unattributedErrors: number;
  errorSamples: BulkWriteErrorSample[];
}> {
  if (buffer.writes.length === 0) {
    return {
      failedRecordOwnerOffsets: new Set(),
      ownerErrorOffsets: new Set(),
      unattributedErrors: 0,
      errorSamples: [],
    };
  }
  if (!client.bulkWrite) {
    throw new Error("Relayfile client bulkWrite capability is required");
  }

  const coalesced = coalesceStagedWrites(buffer.writes);
  buffer.writes.length = 0;
  const recordPathsByOwnerOffset = new Map<number, Set<string>>();
  const ownersByPath = new Map<
    string,
    {
      ownerOffsets: Set<number>;
      attributions: Set<StagedBulkWrite["attribution"]>;
    }
  >();
  for (const write of coalesced) {
    if (write.attributions.has("record")) {
      for (const owner of write.ownerOffsets) {
        const paths = recordPathsByOwnerOffset.get(owner) ?? new Set<string>();
        paths.add(write.path);
        recordPathsByOwnerOffset.set(owner, paths);
      }
    }
    const ownerInfo = ownersByPath.get(write.path) ?? {
      ownerOffsets: new Set<number>(),
      attributions: new Set<StagedBulkWrite["attribution"]>(),
    };
    for (const owner of write.ownerOffsets) {
      ownerInfo.ownerOffsets.add(owner);
    }
    for (const attribution of write.attributions) {
      ownerInfo.attributions.add(attribution);
    }
    ownersByPath.set(write.path, ownerInfo);
  }
  const failedRecordOwnerOffsets = new Set<number>();
  const ownerErrorOffsets = new Set<number>();
  const errorSamples: BulkWriteErrorSample[] = [];
  let unattributedErrors = 0;

  let result: RelayfileBulkWriteResult;
  try {
    result = await bulkWriteWithWorkspaceBusyRetry(client, {
      workspaceId: job.workspaceId,
      files: coalesced.map((write) => {
        const {
          ownerOffsets: _ownerOffsets,
          attributions: _attributions,
          ...file
        } = write;
        const dependsOn = recordDependenciesForStagedWrite(
          write,
          recordPathsByOwnerOffset,
        );
        return dependsOn.length > 0 ? { ...file, dependsOn } : file;
      }),
      correlationId: `nango-sync:${job.provider}:${job.connectionId}:${job.syncName}:${job.model}`,
    }, job);
  } catch (error) {
    const owners = new Set<number>();
    for (const write of coalesced) {
      for (const owner of write.ownerOffsets) {
        owners.add(owner);
      }
    }
    logNangoBulkWriteFailed(
      job,
      {
        code: bulkWriteErrorCode(error),
        message: bulkWriteErrorMessage(error),
        cause: error,
      },
      [...owners],
    );
    throw error;
  }

  // Auxiliary/index writes carry same-bulk dependencies on their owning
  // canonical record writes. Relayfile still uses one admission lease for the
  // page, but it can now skip dependent files when a canonical sibling fails.
  for (const error of result.errors ?? []) {
    const ownerInfo = ownersByPath.get(error.path);
    if (ownerInfo && ownerInfo.ownerOffsets.size > 0) {
      for (const owner of ownerInfo.ownerOffsets) {
        ownerErrorOffsets.add(owner);
        if (ownerInfo.attributions.has("record")) {
          failedRecordOwnerOffsets.add(owner);
        }
      }
    } else {
      unattributedErrors += 1;
    }
    const ownerOffsets = ownerInfo ? [...ownerInfo.ownerOffsets] : [];
    if (errorSamples.length < 5) {
      errorSamples.push(bulkWriteErrorSample(error, ownerOffsets));
    }
    logNangoBulkWriteFailed(job, error, ownerOffsets);
  }

  // Reconcile the DO's own accounting against what we sent. Every file in the
  // batch must resolve to exactly one of: committed (`written`), content-deduped
  // (`dedupedFiles`), or rejected (`errors`). A shortfall means the DO accepted
  // (202) but did not commit some rows without flagging them — the silent
  // "accepted but unreadable" failure mode (relayfile#306). Throw so the CF
  // Workflow page step fails and retries from the same cursor (upserts are
  // idempotent); a persistent shortfall escalates to mark-failed instead of
  // silently completing the sync with missing records. Surfacing it only as a
  // page-level error count is insufficient — `NangoSyncWorkflow.run` advances
  // the cursor on `nextCursor` without inspecting the error array, so a
  // non-throwing signal would not trigger a retry.
  const sentCount = coalesced.length;
  const committedCount =
    typeof result.written === "number" && result.written >= 0
      ? result.written
      : 0;
  const dedupedCount = result.dedupedFiles?.length ?? 0;
  const erroredCount = result.errors?.length ?? 0;
  const accountedCount = committedCount + dedupedCount + erroredCount;
  if (accountedCount < sentCount) {
    const shortfall = sentCount - accountedCount;
    logNangoBulkWriteUnaccounted(job, {
      correlationId: result.correlationId,
      sent: sentCount,
      committed: committedCount,
      deduped: dedupedCount,
      errored: erroredCount,
      shortfall,
    });
    throw new NangoBulkWriteUnderCommittedError(job, {
      sent: sentCount,
      committed: committedCount,
      deduped: dedupedCount,
      errored: erroredCount,
      shortfall,
    });
  }

  return { failedRecordOwnerOffsets, ownerErrorOffsets, unattributedErrors, errorSamples };
}

async function writeBatchToRelayfileWriteThrough(
  client: RelayfileWriteClient,
  records: readonly unknown[],
  job: NangoSyncJob,
  options: Required<
    Pick<
      BatchWriteOptions,
      "concurrency" | "materializeContract" | "materializeAuxiliaryFiles"
    >
  > &
    Pick<BatchWriteOptions, "startOffset" | "shouldCheckpoint">,
): Promise<BatchWriteResult> {
  let written = 0;
  let deleted = 0;
  let errors = 0;
  const appliedRecords: unknown[] = [];
  const processedRecords: unknown[] = [];
  let checkpointOffset: number | undefined;

  for (let i = options.startOffset ?? 0; i < records.length; i += options.concurrency) {
    const chunk = records.slice(i, i + options.concurrency);
    const results = await Promise.allSettled(
      chunk.map((record) => writeProviderRecord(client, record, job)),
    );

    for (const [index, result] of results.entries()) {
      const record = chunk[index];
      processedRecords.push(record);
      if (result.status === "fulfilled") {
        if (result.value === "written") {
          written += 1;
          appliedRecords.push(record);
        } else if (result.value === "deleted") {
          deleted += 1;
          appliedRecords.push(record);
        }
      } else {
        errors += 1;
        logNangoRecordWriteFailed(job, result.reason);
      }
    }

    const nextOffset = Math.min(records.length, i + chunk.length);
    if (options.shouldCheckpoint?.(nextOffset)) {
      checkpointOffset = nextOffset;
      break;
    }
  }

  if (options.materializeContract) {
    try {
      const contractErrors = await materializeProviderContract(
        client,
        processedRecords,
        job,
      );
      errors += contractErrors.length;
      if (contractErrors.length > 0) {
        console.error("Nango provider contract materialization reported errors", {
          area: "nango-sync-worker",
          provider: job.provider,
          model: job.model,
          syncName: job.syncName,
          workspaceId: job.workspaceId,
          errorCount: contractErrors.length,
          errors: contractErrors,
        });
      }
    } catch (error) {
      errors += 1;
      console.error("Nango provider contract materialization failed", {
        area: "nango-sync-worker",
        provider: job.provider,
        model: job.model,
        syncName: job.syncName,
        workspaceId: job.workspaceId,
        stack: error instanceof Error ? error.stack : undefined,
        ...errorLogFields(error),
      });
    }
  }

  if (appliedRecords.length === 0) {
    if (shouldMirrorSlackDiscoveryIndexes(job)) {
      const discoveryIndexErrors = await mirrorSlackDiscoveryIndexes(client, job);
      errors += discoveryIndexErrors.length;
      if (discoveryIndexErrors.length > 0) {
        console.error("Nango Slack discovery index mirror reported errors", {
          area: "nango-sync-worker",
          provider: job.provider,
          model: job.model,
          syncName: job.syncName,
          workspaceId: job.workspaceId,
          errorCount: discoveryIndexErrors.length,
          errors: discoveryIndexErrors,
        });
      }
    }
    return {
      written,
      deleted,
      errors,
      ...(checkpointOffset !== undefined ? { checkpointOffset } : {}),
    };
  }

  try {
    if (options.materializeAuxiliaryFiles) {
      const auxiliaryErrors = await writeProviderAuxiliaryFiles(client, appliedRecords, job);
      errors += auxiliaryErrors.length;
      if (auxiliaryErrors.length > 0) {
        console.error("Nango auxiliary file emission reported errors", {
          area: "nango-sync-worker",
          provider: job.provider,
          model: job.model,
          syncName: job.syncName,
          workspaceId: job.workspaceId,
          errorCount: auxiliaryErrors.length,
          errors: auxiliaryErrors,
        });
      }
    }
    if (shouldMirrorSlackDiscoveryIndexes(job)) {
      const discoveryIndexErrors = await mirrorSlackDiscoveryIndexes(client, job);
      errors += discoveryIndexErrors.length;
      if (discoveryIndexErrors.length > 0) {
        console.error("Nango Slack discovery index mirror reported errors", {
          area: "nango-sync-worker",
          provider: job.provider,
          model: job.model,
          syncName: job.syncName,
          workspaceId: job.workspaceId,
          errorCount: discoveryIndexErrors.length,
          errors: discoveryIndexErrors,
        });
      }
    }
  } catch (error) {
    errors += 1;
    console.error("Nango auxiliary file write failed", {
      area: "nango-sync-worker",
      provider: job.provider,
      model: job.model,
      syncName: job.syncName,
      workspaceId: job.workspaceId,
      stack: error instanceof Error ? error.stack : undefined,
      ...errorLogFields(error),
    });
  }

  return {
    written,
    deleted,
    errors,
    ...(checkpointOffset !== undefined ? { checkpointOffset } : {}),
  };
}

/**
 * Materialize the provider's documented contract surface for this sync:
 * the root + provider `LAYOUT.md` (the discovery-contract ADVERTISER) and
 * the `discovery/<provider>/...` schema/example/adapter files (the
 * PRODUCER). Both are driven off `resourcesForProvider`, asserted
 * consistent, and written via idempotent `writeManagedFile`.
 *
 * Critically this runs on EVERY sync batch — even one where no record was
 * applied (all tombstones, or every record write failed). The discovery
 * contract is what an agent reads BEFORE writing; it must never be absent
 * just because a sync produced no successfully-applied records. This is
 * exactly the rw_fc7b534b condition (769 paths, LAYOUT present, discovery
 * entirely absent).
 */
async function materializeProviderContract(
  client: RelayfileWriteClient,
  records: readonly unknown[],
  job: NangoSyncJob,
  // When provided, schema inference uses these records bucketed DIRECTLY by
  // resource `name` instead of re-deriving buckets from `job.model` via
  // `bucketByModel`. The on-demand backfill (`ensureProviderDiscoveryContract`)
  // has no Nango `job.model` to bucket by — it samples the workspace's
  // existing synced records per resource and already knows the resource each
  // sample belongs to, so it supplies the map directly. The active-sync path
  // (`writeBatchToRelayfile`, which DOES have `job.model`) passes `undefined`
  // and keeps its existing `bucketByModel` behaviour unchanged.
  preBucketedByResourceName?: ReadonlyMap<
    string,
    readonly Record<string, unknown>[]
  >,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  if (!client.readFile) {
    // `writeManagedFile` reads to dedupe; without read access the
    // pre-existing aux path already short-circuits, so mirror it here.
    return [];
  }
  const provider = job.provider.trim().toLowerCase();
  const objects = records.filter(
    (r): r is Record<string, unknown> =>
      r !== null && typeof r === "object" && !Array.isArray(r),
  );
  await writeCommonLayouts(client, job.workspaceId, provider);
  return await writeProviderDiscovery(
    client,
    objects,
    job,
    provider,
    preBucketedByResourceName,
  );
}

/**
 * Batch-INDEPENDENT idempotent backfill of a provider's documented contract
 * surface (root + provider `LAYOUT.md` advertiser and the
 * `discovery/<provider>/.../` schema/example/adapter producer).
 *
 * Why this exists separately from `writeBatchToRelayfile`:
 *
 * `writeBatchToRelayfile` already materializes the contract before its
 * applied-records gate, so a sync that runs but produces zero records still
 * backfills discovery. BUT for an already-fully-synced workspace (the live
 * `rw_fc7b534b` condition: 6 connected nango providers, ~781 paths, every
 * record/index/alias tree + provider LAYOUT.md present, discovery entirely
 * absent) the worker only runs when Nango fires a `sync` webhook — there is
 * no cloud refresh path that runs `writeBatchToRelayfile` on demand. A
 * routine refresh/sync touchpoint must be able to backfill the contract
 * WITHOUT waiting for (or depending on) a Nango record batch ever arriving.
 *
 * The contract is fully derivable from the static adapter registry
 * (`resolveAdapter` → `ADAPTERS` resources + LAYOUT) plus a permissive
 * inferred schema when there are no records — verified by the
 * discovery-emitter suite — so an on-demand materialization with an empty
 * record set is sound and produces the exact LAYOUT-advertised surface.
 *
 * Nango-only: returns `[]` for any provider not in the single `ADAPTERS`
 * registry (Composio/x untouched). Idempotent and byte-stable: reuses the
 * same `materializeProviderContract` → monotonic-merge + canonicalize +
 * `writeManagedFile` dedup as the sync path, so repeated refreshes do not
 * churn revisions/writeback/events.
 */
/**
 * Bounded, deterministic per-resource sample size for the on-demand discovery
 * backfill. The #756 refresh route is already slow, so the sample is small and
 * read list-then-read-N (never an unbounded enumeration). Configurable via
 * `DISCOVERY_SAMPLE_LIMIT` (clamped to a sane 1..500 range).
 */
function discoverySampleLimit(): number {
  const raw = process.env.DISCOVERY_SAMPLE_LIMIT;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.min(parsed, 500);
}

/**
 * Ordered list of UNIVERSAL id-keyed alias path conventions every nango
 * adapter writes for a canonical record, keyed on the **index row `id`**.
 *
 * This is the crux of the adapter-agnostic dereference. The
 * The primary reliable enumeration surface is `<resource.path>/_index.json`
 * (or a resource's explicit `sampleIndexPath`). A best-effort optional
 * `listTree` probe is used only to warn when canonical children exist but no
 * sampleable index exists. The canonical record file name embeds an
 * adapter-specific human slug (e.g. Linear
 * `<identifier>__<uuid>.json`, Jira `<key>__<summary-slug>.json`) that is NOT
 * recoverable from the index row generically. When an index row does carry
 * `canonicalPath`, the sampler reads that first. Otherwise every adapter
 * should guarantee at least one alias subtree whose leaf is either an encoded
 * index-row id, a `__`-joined compound id, or a stable provider-id column
 * from the index row, holding the full record ENVELOPE
 * (`{provider,objectType,objectId,deleted,payload:{...},connectionId}`):
 *
 *   - `by-id/<id>.json`   — Jira, Confluence, GitLab, Notion, … key this
 *                            anchor on the canonical record id, which IS the
 *                            `_index.json` row `id`. (For Linear, `by-id/` is
 *                            keyed on the human IDENTIFIER e.g. `AGE-8`, NOT
 *                            the row id — it will simply 404 here.)
 *   - `by-uuid/<id>.json` — Linear's ALWAYS-emitted stable reconciliation
 *                            anchor, keyed on the Linear UUID, which IS the
 *                            `_index.json` row `id`.
 *
 * Trying `canonicalPath` plus these conventions in order and taking the FIRST that resolves is
 * adapter-agnostic (no per-provider switch), deterministic, and independent
 * of how a given adapter keys its human-readable `by-id/` alias. The previous
 * implementation hard-coded only `by-id/<id>.json`, which silently no-op'd for
 * Linear (Linear's `by-id/` is identifier-keyed; the row id is the UUID at
 * `by-uuid/`), so an already-synced Linear-only workspace got `properties:{}`.
 */
const ID_KEYED_ALIAS_DIRS = ["by-id", "by-uuid"] as const;

export type DiscoveryBackfillStatus =
  | "complete"
  | "skipped-no-records"
  | "degraded";

export type DiscoverySamplingWarningReason =
  | "skipped-no-readable-row-ids"
  | "skipped-no-alias-match"
  | "skipped-no-sampleable-records"
  | "skipped-missing-index-with-canonical-records";

export interface DiscoverySamplingWarning {
  provider: string;
  resourceName: string;
  resourcePath: string;
  indexPath: string;
  indexRows: number;
  sampledIds: number;
  sampledRecords: number;
  reason: DiscoverySamplingWarningReason;
}

export interface DiscoveryBackfillReport {
  errors: EmitAuxiliaryFilesResult["errors"];
  status: DiscoveryBackfillStatus;
  samplingWarnings: DiscoverySamplingWarning[];
  indexedResources: number;
  sampledResources: number;
}

interface ExistingRecordSampleResult {
  byResourceName: Map<string, readonly Record<string, unknown>[]>;
  warnings: DiscoverySamplingWarning[];
  indexedResources: number;
  sampledResources: number;
}

async function hasCanonicalChildren(
  client: RelayfileWriteClient,
  workspaceId: string,
  resourcePath: string,
): Promise<boolean> {
  if (!client.listTree) {
    return false;
  }
  try {
    const tree = await client.listTree(workspaceId, {
      path: resourcePath,
      depth: 1,
      limit: 25,
    });
    return (tree.entries ?? []).some((entry) => {
      const path = entry.path ?? "";
      const name = entry.name ?? path.split("/").pop() ?? "";
      const type = entry.type ?? entry.kind ?? "";
      return (
        path.endsWith(".json") &&
        name !== "_index.json" &&
        !path.includes("/by-") &&
        type !== "directory"
      );
    });
  } catch {
    return false;
  }
}

function canonicalPathFromIndexRow(row: Record<string, unknown>): string | null {
  const path = readFirstString(row, "canonicalPath", "path");
  return path?.startsWith("/") ? path : null;
}

function sampleCandidatePaths(
  resourceIndexRoot: string,
  row: Record<string, unknown>,
  id: string,
): string[] {
  const paths: string[] = [];
  const canonicalPath = canonicalPathFromIndexRow(row);
  if (canonicalPath) {
    paths.push(canonicalPath);
  }
  const aliasIds = sampleAliasIds(row, id);
  for (const dir of ID_KEYED_ALIAS_DIRS) {
    for (const aliasId of aliasIds) {
      paths.push(`${resourceIndexRoot}/${dir}/${encodeURIComponent(aliasId)}.json`);
    }
  }
  return [...new Set(paths)];
}

function sampleAliasIds(row: Record<string, unknown>, id: string): string[] {
  const aliasIds = new Set<string>([id]);
  if (id.includes("/")) {
    aliasIds.add(id.split("/").filter(Boolean).join("__"));
  }

  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (key !== "uuid" && !key.endsWith("_id")) continue;
    const aliasId = String(value).trim();
    if (aliasId) {
      aliasIds.add(aliasId);
    }
  }

  return [...aliasIds];
}

function stripIndexFile(path: string): string {
  return path.replace(/\/_index\.json$/u, "");
}

function sampleIndexRoot(resource: AdapterResourceConfig): string {
  if (resource.sampleIndexPath) {
    return stripIndexFile(resource.sampleIndexPath);
  }
  if (resource.path.endsWith(".json")) {
    return resource.path.replace(/\/[^/]+\.json$/u, "");
  }
  return resource.path;
}

function escapeRegexSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function placeholderPathRegex(path: string): RegExp {
  const normalized = path.replace(/\/+/gu, "/").replace(/\/$/u, "");
  const pattern = normalized
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      return segment.startsWith("{") && segment.endsWith("}")
        ? "[^/]+"
        : escapeRegexSegment(segment);
    })
    .join("/");
  return new RegExp(`^${pattern}$`, "u");
}

function parentDirectories(path: string): string[] {
  const parents: string[] = [];
  let current = path.replace(/\/$/u, "");
  while (current.length > 1) {
    const index = current.lastIndexOf("/");
    if (index <= 0) break;
    current = current.slice(0, index);
    parents.push(current);
  }
  return parents;
}

async function sampleIndexRootsForResource(
  client: RelayfileWriteClient,
  workspaceId: string,
  resource: AdapterResourceConfig,
): Promise<string[]> {
  const root = sampleIndexRoot(resource);
  if (!root.includes("{")) {
    return [root];
  }
  if (!client.listTree) {
    return [];
  }
  const placeholderIndex = root.indexOf("{");
  const prefix = root.slice(0, placeholderIndex).replace(/\/$/u, "") || "/";
  const remainingSegments = root
    .slice(prefix === "/" ? 1 : prefix.length + 1)
    .split("/")
    .filter(Boolean).length;
  const matcher = placeholderPathRegex(root);

  try {
    const tree = await client.listTree(workspaceId, {
      path: prefix,
      depth: Math.max(remainingSegments + 2, 4),
      limit: 500,
    });
    const roots = new Set<string>();
    for (const entry of tree.entries ?? []) {
      const entryPath = (entry.path ?? "").replace(/\/$/u, "");
      if (!entryPath.startsWith(prefix)) continue;
      for (const parent of parentDirectories(entryPath)) {
        if (matcher.test(parent)) {
          roots.add(parent);
        }
      }
    }
    return [...roots].sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function unwrapStoredSampleRecord(
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const provider = readFirstString(stored, "provider");
  const objectType = readFirstString(stored, "objectType");
  const payload = readNestedRecord(stored, "payload");
  if (provider && objectType && payload) {
    return payload;
  }
  return stored;
}

/**
 * Generic resource → existing-synced-record sampler for the ON-DEMAND
 * discovery backfill (`ensureProviderDiscoveryContract`). NO per-provider
 * switchboard — registry-driven via `resolveAdapter`/`ADAPTERS`.
 *
 * For each resource the provider's adapter advertises (resources whose `path`
 * still contains a `{placeholder}` are per-parent sub-resources with no flat
 * `_index.json` — SKIPPED, they stay permissive-empty: covering them is a
 * separate, larger gap and out of scope here), this:
 *   1. reads `<resource.path>/_index.json` or a concrete
 *      `<sampleIndexPath>/_index.json`, sorts rows by `id`
 *      lexicographically (byte-stable), takes the first
 *      {@link discoverySampleLimit} ids (bounded list-then-read-N),
 *   2. dereferences each id through index-row `canonicalPath` and then
 *      {@link ID_KEYED_ALIAS_DIRS} in order, using the FIRST path that
 *      resolves (adapter-agnostic; `by-id` for Jira/Confluence/etc.,
 *      `by-uuid` for Linear), unwraps the envelope via
 *      the same `payload ?? whole` rule used elsewhere in this file, drops
 *      tombstones,
 *   3. returns the real records keyed by `resource.name`.
 *
 * COVERAGE (honest, no universality claim — verified against each adapter's
 * `dist/resources.js`): the ONLY sampled resources are those advertising a
 * flat (placeholder-free) `<resource.path>/_index.json` whose adapter writes
 * an id-keyed `by-id/`/`by-uuid/` envelope alias. In the current registry
 * that flat set is exactly:
 *   - Linear:     `/linear/issues`, `/linear/labels`, `/linear/projects`
 *   - Jira:       `/jira/issues`, `/jira/projects`
 *   - Confluence: `/confluence/pages`
 * That is the complete actual flat set today — there is NO `/jira/sprints`
 * resource and NO flat `/confluence/spaces` resource (Confluence only
 * advertises the placeholder `/confluence/spaces/{spaceIdOrKey}/pages`); any
 * future flat resource matching this convention is picked up automatically.
 * GitLab, Notion, Slack and GitHub advertise ZERO flat resources — EVERY one
 * of their resource paths contains a `{placeholder}` (per-parent
 * sub-resources, comments, messages, …) — so they are entirely NOT sampled
 * and stay permissive-empty, exactly like Jira `comments`/`transitions`,
 * Linear `comments`, and all other `{placeholder}` sub-resources. This is a
 * pre-existing, separate, larger gap (no regression here).
 *
 * JIRA SANITIZED-PAYLOAD CAVEAT: Jira `by-id/` envelopes store the
 * `sanitizeJiraRecordForStorage`-redacted payload (assignee→null, changelog
 * stripped). The on-demand schema is therefore a NARROWER subset than the
 * active-sync raw-record schema. This is correct-by-convergence: the discovery
 * schema is written via the monotonic-widening merge
 * (`mergeResourceSchema`, `readOnly` is sticky-OR, properties are unioned), so
 * a later active sync delivering the raw record MONOTONICALLY widens the
 * schema and never drops a field. On an on-demand-only workspace the Jira
 * schema stays narrower until a real sync batch arrives — never destructive.
 *
 * A resource with no `_index.json` (or zero rows / no resolvable
 * `canonicalPath`/id-keyed alias / malformed files) contributes nothing, so
 * the permissive empty schema is preserved (no regression). If `listTree` is
 * available and a flat resource has canonical JSON children but no sampleable
 * index, the sampler emits a structured warning. Idempotent/deterministic:
 * the same lexicographically-first N ids resolve the same records every run.
 */
export async function sampleExistingRecordsByResource(
  client: RelayfileWriteClient,
  workspaceId: string,
  resources: readonly AdapterResourceConfig[],
): Promise<Map<string, readonly Record<string, unknown>[]>> {
  return (
    await sampleExistingRecordsByResourceWithWarnings(
      client,
      workspaceId,
      resources,
      "unknown",
      false,
    )
  ).byResourceName;
}

async function sampleExistingRecordsByResourceWithWarnings(
  client: RelayfileWriteClient,
  workspaceId: string,
  resources: readonly AdapterResourceConfig[],
  provider: string,
  emitWarnings: boolean,
): Promise<ExistingRecordSampleResult> {
  const byResourceName = new Map<string, readonly Record<string, unknown>[]>();
  const warnings: DiscoverySamplingWarning[] = [];
  let indexedResources = 0;
  let sampledResources = 0;
  if (!client.readFile) {
    return { byResourceName, warnings, indexedResources, sampledResources };
  }
  const limit = discoverySampleLimit();

  for (const resource of resources) {
    const resourceIndexRoots = await sampleIndexRootsForResource(
      client,
      workspaceId,
      resource,
    );
    if (resourceIndexRoots.length === 0) {
      continue;
    }

    if (!resource.sampleIndexPath && resource.path.endsWith(".json")) {
      const stored = await readJsonObjectFile(client, workspaceId, resource.path);
      if (stored) {
        const record = unwrapStoredSampleRecord(stored);
        if (isDeletedRecord(record)) {
          continue;
        }
        byResourceName.set(resource.name, [record]);
        indexedResources += 1;
        sampledResources += 1;
        continue;
      }
    }

    const sampled: Record<string, unknown>[] = [];
    let resourceIndexed = false;
    let emittedEmptyIndexWarning = false;
    let lastZeroSampleWarning: DiscoverySamplingWarning | null = null;

    for (const resourceIndexRoot of resourceIndexRoots) {
      const remaining = limit - sampled.length;
      if (remaining <= 0) {
        break;
      }
      const indexPath = `${resourceIndexRoot}/_index.json`;
      const rows = await readJsonArray<Record<string, unknown>>(
        client,
        workspaceId,
        indexPath,
      );
      if (rows.length === 0) {
        if (
          !emittedEmptyIndexWarning &&
          await hasCanonicalChildren(client, workspaceId, resourceIndexRoot)
        ) {
          const warning: DiscoverySamplingWarning = {
            provider,
            resourceName: resource.name,
            resourcePath: resource.path,
            indexPath,
            indexRows: 0,
            sampledIds: 0,
            sampledRecords: 0,
            reason: "skipped-missing-index-with-canonical-records",
          };
          warnings.push(warning);
          emittedEmptyIndexWarning = true;
          if (emitWarnings) {
            console.warn(
              "[record-writer] discovery sampler found canonical records but no sampleable index",
              {
                ...warning,
                workspaceId,
              },
            );
          }
        }
        continue;
      }
      resourceIndexed = true;
      const ids = rows
        .map((row) => readId(row))
        .filter((id) => id.length > 0)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, remaining);

      let resolvedRecords = 0;
      const sampledBeforeRoot = sampled.length;
      for (const id of ids) {
        const row = rows.find((candidate) => readId(candidate) === id) ?? {};
        let stored: Record<string, unknown> | null = null;
        for (const candidatePath of sampleCandidatePaths(
          resourceIndexRoot,
          row,
          id,
        )) {
          stored = await readJsonObjectFile(client, workspaceId, candidatePath);
          if (stored) {
            break;
          }
        }
        if (!stored) {
          continue;
        }
        resolvedRecords += 1;
        const record = unwrapStoredSampleRecord(stored);
        if (isDeletedRecord(record)) {
          continue;
        }
        sampled.push(record);
      }

      if (sampled.length === sampledBeforeRoot) {
        lastZeroSampleWarning = {
          provider,
          resourceName: resource.name,
          resourcePath: resource.path,
          indexPath,
          indexRows: rows.length,
          sampledIds: ids.length,
          sampledRecords: sampled.length - sampledBeforeRoot,
          reason:
            ids.length === 0
              ? "skipped-no-readable-row-ids"
              : resolvedRecords === 0
                ? "skipped-no-alias-match"
                : "skipped-no-sampleable-records",
        };
      }
    }

    if (resourceIndexed) {
      indexedResources += 1;
    }
    if (sampled.length > 0) {
      if (byResourceName.has(resource.name)) {
        console.warn(
          "[record-writer] discovery sampler resource name collision — keeping first, skipping duplicate",
          {
            resourceName: resource.name,
            skippedResourcePath: resource.path,
            workspaceId,
          },
        );
        continue;
      }
      byResourceName.set(resource.name, sampled);
      sampledResources += 1;
      continue;
    }
    if (lastZeroSampleWarning) {
      warnings.push(lastZeroSampleWarning);
      if (emitWarnings) {
        console.warn(
          "[record-writer] discovery sampler found indexed rows but sampled zero records",
          {
            ...lastZeroSampleWarning,
            workspaceId,
          },
        );
      }
    }
  }
  return { byResourceName, warnings, indexedResources, sampledResources };
}

export async function ensureProviderDiscoveryContract(
  client: RelayfileWriteClient,
  provider: string,
  workspaceId: string,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  return (
    await ensureProviderDiscoveryContractReport(client, provider, workspaceId)
  ).errors;
}

export async function ensureProviderDiscoveryContractReport(
  client: RelayfileWriteClient,
  provider: string,
  workspaceId: string,
): Promise<DiscoveryBackfillReport> {
  const normalized = provider.trim().toLowerCase();
  const adapter = resolveAdapter(normalized);
  if (!adapter) {
    // Not a registry-backed nango provider (e.g. composio-only): nothing to
    // materialize. Mirrors the `writeProviderAuxiliaryFiles` short-circuit.
    return {
      errors: [],
      status: "complete",
      samplingWarnings: [],
      indexedResources: 0,
      sampledResources: 0,
    };
  }
  const job: NangoSyncJob = {
    type: "nango_sync",
    provider: normalized,
    connectionId: "",
    providerConfigKey: "",
    syncName: "discovery-contract-backfill",
    model: "",
    modifiedAfter: "",
    cursor: null,
    workspaceId,
  };
  // Sample the workspace's EXISTING synced records per resource so inference
  // produces the real schema (fields + readOnly server-managed) instead of the
  // permissive empty placeholder #756 emitted by passing `[]`. Resources with
  // genuinely zero synced records sample nothing and keep the permissive empty
  // schema (no regression). Bounded + deterministic (list-then-read-N).
  const indexBackfillErrors = normalized === "linear"
    ? await reconcileLinearFlatIndexes(client, workspaceId)
    : [];
  const sampled = await sampleExistingRecordsByResourceWithWarnings(
    client,
    workspaceId,
    adapter.resources,
    normalized,
    true,
  );
  const contractErrors = await materializeProviderContract(
    client,
    [],
    job,
    sampled.byResourceName,
  );
  const errors = [...indexBackfillErrors, ...contractErrors];
  const flatResourceCount = adapter.resources.filter(
    (resource) => !resource.path.includes("{"),
  ).length;
  return {
    errors,
    status:
      sampled.warnings.length > 0
        || indexBackfillErrors.length > 0
        ? "degraded"
        : sampled.indexedResources === 0 && flatResourceCount > 0
          ? "skipped-no-records"
          : "complete",
    samplingWarnings: sampled.warnings,
    indexedResources: sampled.indexedResources,
    sampledResources: sampled.sampledResources,
  };
}

/**
 * Bucket the job's records by adapter resource `name` and emit the writeback
 * discovery surface. Reuses the existing `bucketByModel` (the same
 * record→model bucketing the aux emitters use); bucket keys (`issues`,
 * `comments`, `pages`, ...) align with resource `name`s. A resource with no
 * records this sync still gets `.create.example.json` + `.adapter.md` + a
 * best-effort schema so the advertised contract is NEVER absent — schema
 * fidelity refines as that resource type syncs.
 */
async function writeProviderDiscovery(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
  provider: string,
  preBucketedByResourceName?: ReadonlyMap<
    string,
    readonly Record<string, unknown>[]
  >,
): Promise<EmitAuxiliaryFilesResult["errors"]> {
  const resources = resourcesForProvider(provider);
  if (resources.length === 0) {
    return [];
  }

  const recordsByResourceName = new Map<
    string,
    readonly Record<string, unknown>[]
  >();
  if (preBucketedByResourceName) {
    // On-demand backfill path: records were sampled per resource from the
    // workspace's existing synced files and are already keyed by resource
    // `name`. Use them directly — there is no Nango `job.model` to bucket by.
    for (const [key, value] of preBucketedByResourceName) {
      if (value.length > 0) {
        recordsByResourceName.set(key, value);
      }
    }
  } else {
    try {
      const bucketed = bucketByModel(records, job.model, provider);
      if (bucketed.provider !== "unknown") {
        const discoveryResourceNameForBucket = (bucketName: string): string => {
          if (bucketed.provider === "dropbox") {
            if (bucketName === "sharedFolders") return "shared-folders";
            if (bucketName === "sharedLinks") return "shared-links";
          }
          if (bucketed.provider === GCP_PROVIDER) {
            if (bucketName === "cloudRunServices") return "cloud-run-services";
            if (bucketName === "monitoringAlerts") return "monitoring-alerts";
            if (bucketName === "errorGroups") return "error-reporting-groups";
          }
          if (bucketed.provider === NEON_PROVIDER) {
            if (bucketName === "projectConsumption") return "project-consumption";
            if (bucketName === "branchConsumption") return "branch-consumption";
            if (bucketName === "spendingLimits") return "spending-limits";
            if (bucketName === "advisorIssues") return "advisor-issues";
          }
          if (bucketed.provider === CLOUDFLARE_PROVIDER) {
            if (bucketName === "workerScripts") return "workers-scripts";
            if (bucketName === "workerUsage") return "worker-usage";
            if (bucketName === "pagesProjects") return "pages-projects";
            if (bucketName === "d1Databases") return "d1-databases";
            if (bucketName === "kvNamespaces") return "kv-namespaces";
            if (bucketName === "r2Buckets") return "r2-buckets";
            if (bucketName === "dnsRecords") return "dns-records";
            if (bucketName === "notificationWebhooks") return "notification-webhooks";
            if (bucketName === "notificationPolicies") return "notification-policies";
            if (bucketName === "notificationEvents") return "notification-events";
          }
          if (bucketed.provider === TELEGRAM_PROVIDER) {
            if (bucketName === "callbackQueries") return "callback-queries";
            if (bucketName === "inlineQueries") return "inline-queries";
          }
          return bucketName;
        };
        for (const [key, value] of Object.entries(bucketed.buckets)) {
          if (Array.isArray(value) && value.length > 0) {
            recordsByResourceName.set(
              discoveryResourceNameForBucket(key),
              value as readonly Record<string, unknown>[],
            );
          }
        }
      }
    } catch {
      // Bucketing is best-effort for schema fidelity; even with zero records
      // we still emit the (empty-shape) schema + example + adapter.md so the
      // advertised discovery contract is present. Never block sync on this.
    }
  }

  const result = await writeDiscoveryArtifacts(
    {
      writeManagedFile,
      // Lets the emitter monotonically merge the prior on-disk `.schema.json`
      // so the discovery surface converges across the pages of a multi-page
      // sync instead of being rewritten (revision/writeback/event churn) on
      // most pages because each page infers a different schema subset.
      readManagedFile: ({ client: c, workspaceId: ws, path }) =>
        readTextFile(c, ws, path),
    },
    client,
    job.workspaceId,
    provider,
    resources,
    recordsByResourceName,
  );

  if (result.errors.length > 0) {
    console.warn("[record-writer] discovery emit errors", {
      area: "nango-sync-worker",
      provider,
      model: job.model,
      syncName: job.syncName,
      workspaceId: job.workspaceId,
      written: result.written,
      errors: result.errors,
    });
  }
  return result.errors;
}

export async function writeBatchToRelayfile(
  client: RelayfileWriteClient,
  records: readonly unknown[],
  job: NangoSyncJob,
  options: BatchWriteOptions = {},
): Promise<BatchWriteResult> {
  const concurrency = Math.max(1, options.concurrency ?? WRITE_CONCURRENCY);
  const materializeContract = options.materializeContract !== false;
  const materializeAuxiliaryFiles = options.materializeAuxiliaryFiles !== false;
  const startOffset =
    Number.isInteger(options.startOffset) && options.startOffset! > 0
      ? Math.min(options.startOffset!, records.length)
      : 0;

  if (!client.bulkWrite) {
    return writeBatchToRelayfileWriteThrough(client, records, job, {
      ...options,
      startOffset,
      concurrency,
      materializeContract,
      materializeAuxiliaryFiles,
    });
  }

  let written = 0;
  let deleted = 0;
  let errors = 0;
  let checkpointOffset: number | undefined;
  const stagedBuffer: StagedBulkBuffer = { writes: [] };
  const plannedOutcomes = new Map<number, RecordWriteOutcome>();
  const plannedRecords = new Map<number, unknown>();

  const stageAuxiliaryForAppliedRecords = async (
    appliedRecords: readonly unknown[],
    appliedOffsets: readonly number[],
  ): Promise<void> => {
    if (appliedRecords.length === 0) {
      if (shouldMirrorSlackDiscoveryIndexes(job)) {
        const discoveryIndexErrors = await mirrorSlackDiscoveryIndexes(
          createStagedBulkClient(client, stagedBuffer, [], "auxiliary"),
          job,
        );
        errors += discoveryIndexErrors.length;
        if (discoveryIndexErrors.length > 0) {
          console.error("Nango Slack discovery index mirror reported errors", {
            area: "nango-sync-worker",
            provider: job.provider,
            model: job.model,
            syncName: job.syncName,
            workspaceId: job.workspaceId,
            errorCount: discoveryIndexErrors.length,
            errors: discoveryIndexErrors,
          });
        }
      }
    } else {
      if (materializeAuxiliaryFiles) {
        const auxiliaryErrors = await writeProviderAuxiliaryFiles(
          createStagedBulkClient(
            client,
            stagedBuffer,
            appliedOffsets,
            "auxiliary",
          ),
          appliedRecords,
          job,
        );
        errors += auxiliaryErrors.length;
        if (auxiliaryErrors.length > 0) {
          console.error("Nango auxiliary file emission reported errors", {
            area: "nango-sync-worker",
            provider: job.provider,
            model: job.model,
            syncName: job.syncName,
            workspaceId: job.workspaceId,
            errorCount: auxiliaryErrors.length,
            errors: auxiliaryErrors,
          });
        }
      }
      if (shouldMirrorSlackDiscoveryIndexes(job)) {
        const discoveryIndexErrors = await mirrorSlackDiscoveryIndexes(
          createStagedBulkClient(
            client,
            stagedBuffer,
            appliedOffsets,
            "auxiliary",
          ),
          job,
        );
        errors += discoveryIndexErrors.length;
        if (discoveryIndexErrors.length > 0) {
          console.error("Nango Slack discovery index mirror reported errors", {
            area: "nango-sync-worker",
            provider: job.provider,
            model: job.model,
            syncName: job.syncName,
            workspaceId: job.workspaceId,
            errorCount: discoveryIndexErrors.length,
            errors: discoveryIndexErrors,
          });
        }
      }
    }
  };

  if (materializeContract) {
    try {
      const contractErrors = await materializeProviderContract(
        createStagedBulkClient(client, stagedBuffer, [], "auxiliary"),
        records,
        job,
      );
      errors += contractErrors.length;
      if (contractErrors.length > 0) {
        console.error("Nango provider contract materialization reported errors", {
          area: "nango-sync-worker",
          provider: job.provider,
          model: job.model,
          syncName: job.syncName,
          workspaceId: job.workspaceId,
          errorCount: contractErrors.length,
          errors: contractErrors,
        });
      }
    } catch (error) {
      errors += 1;
      console.error("Nango provider contract materialization failed", {
        area: "nango-sync-worker",
        provider: job.provider,
        model: job.model,
        syncName: job.syncName,
        workspaceId: job.workspaceId,
        stack: error instanceof Error ? error.stack : undefined,
        ...errorLogFields(error),
      });
    }
  }

  for (let i = startOffset; i < records.length; i += concurrency) {
    const chunk = records.slice(i, i + concurrency);
    const chunkOffsets = chunk.map((_, index) => i + index);
    const results = await Promise.allSettled(
      chunk.map(async (record, index) => {
        const offset = chunkOffsets[index];
        const singleRecordBuffer: StagedBulkBuffer = { writes: [] };
        const recordClient = createStagedBulkClient(
          client,
          singleRecordBuffer,
          [offset],
          "record",
        );
        const outcome = await writeProviderRecord(recordClient, record, job);
        return { outcome, writes: singleRecordBuffer.writes };
      }),
    );

    for (const [index, result] of results.entries()) {
      const record = chunk[index];
      const offset = chunkOffsets[index];
      if (result.status === "fulfilled") {
        if (result.value.outcome === "written" || result.value.outcome === "deleted") {
          stagedBuffer.writes.push(...result.value.writes);
          plannedOutcomes.set(offset, result.value.outcome);
          plannedRecords.set(offset, record);
        }
      } else {
        errors += 1;
        logNangoRecordWriteFailed(job, result.reason);
      }
    }

    const nextOffset = Math.min(records.length, i + chunk.length);
    if (options.shouldCheckpoint?.(nextOffset)) {
      checkpointOffset = nextOffset;
      break;
    }
  }

  const appliedOffsets = [...plannedOutcomes.keys()];
  const appliedRecords = appliedOffsets.map((offset) => plannedRecords.get(offset)!);
  try {
    await stageAuxiliaryForAppliedRecords(appliedRecords, appliedOffsets);
  } catch (error) {
    errors += 1;
    console.error("Nango auxiliary file write failed", {
      area: "nango-sync-worker",
      provider: job.provider,
      model: job.model,
      syncName: job.syncName,
      workspaceId: job.workspaceId,
      stack: error instanceof Error ? error.stack : undefined,
      ...errorLogFields(error),
    });
  }

  const flush = await flushStagedBulkWrites(client, stagedBuffer, job);
  for (const [offset, outcome] of plannedOutcomes) {
    if (flush.failedRecordOwnerOffsets.has(offset)) {
      errors += 1;
      continue;
    }
    if (outcome === "written") {
      written += 1;
    } else if (outcome === "deleted") {
      deleted += 1;
    }
  }
  const nonRecordOwnerErrors = new Set(flush.ownerErrorOffsets);
  for (const offset of flush.failedRecordOwnerOffsets) {
    nonRecordOwnerErrors.delete(offset);
  }
  errors += nonRecordOwnerErrors.size + flush.unattributedErrors;

  const errorSamples = flush.errorSamples.length > 0
    ? { errorSamples: flush.errorSamples }
    : {};

  return checkpointOffset === undefined
    ? { written, deleted, errors, ...errorSamples }
    : { written, deleted, errors, checkpointOffset, ...errorSamples };
}
