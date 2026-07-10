import type { NangoSyncJob } from "./nango-sync-job.js";
import {
  ENABLED_NANGO_PROVIDER_MODEL_KEYS,
  type RepoDeclaredNangoProviderModel,
} from "./nango-provider-parity.js";
import {
  googleMailStableProjectionMatches,
  isGoogleMailStableDedupEnabled,
  type GoogleMailStableModel,
} from "./google-mail-stable-dedup.js";

export { REPO_DECLARED_NANGO_PROVIDER_MODELS } from "./nango-provider-parity.js";

export const PROVIDER_NOT_PARITY_ENABLED = "provider_not_parity_enabled";

export type ProviderModelKey = RepoDeclaredNangoProviderModel;

export type PlannedRelayfileSemantics = {
  properties?: Record<string, string>;
  relations?: string[];
  comments?: string[];
};

export class ProviderNotParityEnabledError extends Error {
  readonly code = PROVIDER_NOT_PARITY_ENABLED;
  readonly providerConfigKey: string;
  readonly syncName: string;
  readonly model: string;

  constructor(job: Pick<NangoSyncJob, "providerConfigKey" | "syncName" | "model">) {
    super(
      `Provider/model parity is not enabled for ${providerModelKey(job)}`,
    );
    this.name = "ProviderNotParityEnabledError";
    this.providerConfigKey = job.providerConfigKey;
    this.syncName = job.syncName;
    this.model = job.model;
  }
}

export const DEFAULT_ENABLED_PROVIDER_MODELS: ReadonlySet<ProviderModelKey> =
  ENABLED_NANGO_PROVIDER_MODEL_KEYS;

export function providerModelKey(
  job: Pick<NangoSyncJob, "providerConfigKey" | "syncName" | "model">,
): ProviderModelKey {
  return `${job.providerConfigKey}:${job.syncName}:${job.model}` as ProviderModelKey;
}

export function assertProviderModelParityEnabled(
  job: Pick<NangoSyncJob, "providerConfigKey" | "syncName" | "model">,
  enabledProviderModels: ReadonlySet<ProviderModelKey> = DEFAULT_ENABLED_PROVIDER_MODELS,
): void {
  if (!enabledProviderModels.has(providerModelKey(job))) {
    throw new ProviderNotParityEnabledError(job);
  }
}

export type PlannedRelayfileWrite = {
  path: string;
  contents?: string;
  contentType?: string;
  semantics?: PlannedRelayfileSemantics;
  baseRevision?: string;
  delete?: boolean;
};

export type ProviderWritePlan = {
  writes: PlannedRelayfileWrite[];
  written: number;
  deleted: number;
  skipped: number;
};

export type ProviderWritePlannerContext = {
  existingFiles?: ReadonlyMap<string, string> | Record<string, string>;
  existingRevisions?: ReadonlyMap<string, string> | Record<string, string>;
};

export function planProviderRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  enabledProviderModels?: ReadonlySet<ProviderModelKey>,
  context: ProviderWritePlannerContext = {},
): ProviderWritePlan {
  assertProviderModelParityEnabled(job, enabledProviderModels);
  if (job.providerConfigKey === "confluence-relay") {
    return planConfluenceRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "notion-relay") {
    return planNotionRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "github-relay") {
    return planGitHubRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "linear-relay") {
    return planLinearRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "slack-relay") {
    return planSlackRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "telegram-relay") {
    return planTelegramRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "jira-relay") {
    return planJiraRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "gitlab-relay") {
    return planGitLabRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "x-relay") {
    return planXRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "google-mail-relay") {
    return planGoogleMailRecordWrites(job, records, context);
  }
  if (job.providerConfigKey === "google-calendar-relay") {
    return planGoogleCalendarRecordWrites(job, records, context);
  }
  void records;
  return { writes: [], written: 0, deleted: 0, skipped: 0 };
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const CONFLUENCE_PATH_ROOT = "/confluence";
const MAX_HUMAN_READABLE_LENGTH = 80;
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
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function readFirstString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = readString(record, key)?.trim();
    if (value) return value;
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

function readId(record: Record<string, unknown>, key = "id"): string {
  return readString(record, key)?.trim() ?? "";
}

function stripNangoMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...record };
  delete payload._nango_metadata;
  return payload;
}

function isDeletedNangoRecord(record: Record<string, unknown>): boolean {
  const metadata = record._nango_metadata;
  if (!isObject(metadata)) return false;
  const lastAction =
    typeof metadata.last_action === "string"
      ? metadata.last_action.toLowerCase()
      : "";
  return lastAction === "deleted" || typeof metadata.deleted_at === "string";
}

function readContextValue(
  source: ProviderWritePlannerContext["existingFiles"],
  key: string,
): string | undefined {
  if (!source) return undefined;
  return typeof (source as ReadonlyMap<string, string>).get === "function"
    ? (source as ReadonlyMap<string, string>).get(key)
    : (source as Record<string, string>)[key];
}

function readJsonObject(
  context: ProviderWritePlannerContext,
  path: string,
): Record<string, unknown> | null {
  const content = readContextValue(context.existingFiles, path);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJsonArray(
  context: ProviderWritePlannerContext,
  path: string,
): Record<string, unknown>[] {
  const content = readContextValue(context.existingFiles, path);
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => isObject(item))
      : [];
  } catch {
    return [];
  }
}

function revisionFor(context: ProviderWritePlannerContext, path: string): string | undefined {
  return readContextValue(context.existingRevisions, path);
}

function encodeConfluencePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Confluence path segment must be a non-empty string");
  }
  return encodeURIComponent(trimmed);
}

function aliasCollisionSuffix(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]+/g, "");
  const slug = ascii
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (slug.length <= MAX_HUMAN_READABLE_LENGTH) return slug;
  const truncated = slug.slice(0, MAX_HUMAN_READABLE_LENGTH);
  const cutIndex = truncated.lastIndexOf("-");
  const bounded = cutIndex > 0 ? truncated.slice(0, cutIndex) : truncated;
  return bounded.replace(/^-+|-+$/g, "");
}

function slugifyAlias(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]+/g, "")
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "untitled";
}

function nameWithId(humanReadable: string | undefined, id: string): string {
  const normalizedId = encodeConfluencePathSegment(id);
  const slug = humanReadable ? slugify(humanReadable) : "";
  return slug ? `${slug}__${normalizedId}` : normalizedId;
}

function confluenceSpacePath(spaceIdOrKey: string, name?: string): string {
  return `${CONFLUENCE_PATH_ROOT}/spaces/${nameWithId(name, spaceIdOrKey)}.json`;
}

function confluencePagePath(pageId: string, title?: string, spaceId?: string): string {
  const pageSegment = nameWithId(title, pageId);
  if (spaceId) {
    return `${CONFLUENCE_PATH_ROOT}/spaces/${encodeConfluencePathSegment(spaceId)}/pages/${pageSegment}.json`;
  }
  return `${CONFLUENCE_PATH_ROOT}/pages/${pageSegment}.json`;
}

function confluencePagesIndexPath(): string {
  return `${CONFLUENCE_PATH_ROOT}/pages/_index.json`;
}

function confluenceSpacesIndexPath(): string {
  return `${CONFLUENCE_PATH_ROOT}/spaces/_index.json`;
}

function confluencePageByIdAliasPath(id: string): string {
  return `${CONFLUENCE_PATH_ROOT}/pages/by-id/${encodeConfluencePathSegment(id)}.json`;
}

function confluenceSpaceByIdAliasPath(id: string): string {
  return `${CONFLUENCE_PATH_ROOT}/spaces/by-id/${encodeConfluencePathSegment(id)}.json`;
}

function confluenceByTitleAliasPath(scope: string, title: string, id: string, colliding = false): string {
  const slug = slugifyAlias(title);
  const filename = colliding ? `${slug}-${aliasCollisionSuffix(id)}` : slug;
  return `${scope}/by-title/${encodeConfluencePathSegment(filename)}.json`;
}

function confluencePageByTitleAliasPath(title: string, id: string): string {
  return confluenceByTitleAliasPath(`${CONFLUENCE_PATH_ROOT}/pages`, title, id);
}

function confluenceSpaceByTitleAliasPath(title: string, id: string): string {
  return confluenceByTitleAliasPath(`${CONFLUENCE_PATH_ROOT}/spaces`, title, id);
}

function slugifyStatusName(status: string): string {
  const trimmed = status.trim();
  if (!trimmed) throw new Error("Confluence status name must be a non-empty string");
  let slug = "";
  let previousWasSeparator = false;
  for (const character of trimmed.normalize("NFC").toLowerCase()) {
    if (/\s/u.test(character)) {
      if (!previousWasSeparator && slug.length > 0) slug += "-";
      previousWasSeparator = true;
      continue;
    }
    previousWasSeparator = false;
    if (/[a-z0-9]/u.test(character)) {
      slug += character;
      continue;
    }
    if (character === "-") {
      slug += "%2D";
      continue;
    }
    slug += encodeURIComponent(character);
  }
  if (!slug) throw new Error("Confluence status slug must be a non-empty string");
  return slug;
}

function confluencePageByStatePath(status: string, pageId: string): string {
  return `${CONFLUENCE_PATH_ROOT}/pages/by-state/${slugifyStatusName(status)}/${encodeConfluencePathSegment(pageId)}.json`;
}

function confluencePageByEditedPath(editedDate: string, pageId: string): string {
  return `${CONFLUENCE_PATH_ROOT}/pages/by-edited/${encodeConfluencePathSegment(editedDate)}/${encodeConfluencePathSegment(pageId)}.json`;
}

function confluencePageBySpaceAliasPath(spaceId: string, pageId: string): string {
  return `${CONFLUENCE_PATH_ROOT}/pages/by-space/${encodeConfluencePathSegment(spaceId)}/${encodeConfluencePathSegment(pageId)}.json`;
}

function confluencePageByParentAliasPath(parentId: string, pageId: string): string {
  return `${CONFLUENCE_PATH_ROOT}/pages/by-parent/${encodeConfluencePathSegment(parentId)}/${encodeConfluencePathSegment(pageId)}.json`;
}

function confluenceSpaceByKeyAliasPath(spaceKey: string): string {
  return `${CONFLUENCE_PATH_ROOT}/spaces/by-key/${encodeConfluencePathSegment(spaceKey)}.json`;
}

function normalizeConfluenceObjectType(model: string): "page" | "space" {
  const normalized = model.trim().toLowerCase();
  if (normalized === "confluencepage" || normalized === "page" || normalized === "pages") return "page";
  if (normalized === "confluencespace" || normalized === "space" || normalized === "spaces") return "space";
  throw new Error(`Unsupported Confluence object type: ${model}`);
}

function slugifies(value: string): boolean {
  return slugifyAlias(value) !== "untitled";
}

function buildConfluenceSyncSemantics(
  objectType: "page" | "space",
  objectId: string,
  record: Record<string, unknown>,
  job: NangoSyncJob,
): PlannedRelayfileSemantics {
  const properties: Record<string, string> = {
    provider: "confluence",
    "provider.object_id": objectId,
    "provider.object_type": objectType,
    "confluence.id": objectId,
    "confluence.object_type": objectType,
    "nango.connection_id": job.connectionId,
    "nango.model": job.model,
    "nango.provider_config_key": job.providerConfigKey,
    "nango.sync_name": job.syncName,
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

function wrappedConfluenceContent(
  objectType: "page" | "space",
  objectId: string,
  payload: Record<string, unknown>,
  job: NangoSyncJob,
): string {
  return JSON.stringify({
    provider: "confluence",
    objectType,
    objectId,
    deleted: false,
    payload,
    connectionId: job.connectionId,
  }, null, 2);
}

type PageState = {
  title?: string;
  status?: string;
  spaceId?: string;
  parentId?: string;
  editedDate?: string;
};

type SpaceState = {
  name?: string;
  key?: string;
};

function pickPayload(parsed: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!parsed) return null;
  return isObject(parsed.payload) ? parsed.payload : parsed;
}

function extractPriorPageState(parsed: Record<string, unknown> | null): PageState | null {
  const payload = pickPayload(parsed);
  if (!payload) return null;
  return {
    title: readFirstString(payload, "title") ?? undefined,
    status: readFirstString(payload, "status") ?? undefined,
    spaceId: readFirstString(payload, "spaceId", "space_id") ?? undefined,
    parentId: readFirstString(payload, "parentId", "parent_id") ?? undefined,
    editedDate: editedDateSegment(confluencePageEditedAt(payload)),
  };
}

function extractPriorSpaceState(parsed: Record<string, unknown> | null): SpaceState | null {
  const payload = pickPayload(parsed);
  if (!payload) return null;
  return {
    name: readFirstString(payload, "name", "title") ?? undefined,
    key: readFirstString(payload, "key") ?? undefined,
  };
}

function confluencePagePaths(args: { id: string } & PageState): string[] {
  const paths = [confluencePagePath(args.id, args.title, args.spaceId)];
  paths.push(confluencePageByIdAliasPath(args.id));
  if (args.title && slugifies(args.title)) paths.push(confluencePageByTitleAliasPath(args.title, args.id));
  if (args.status) paths.push(confluencePageByStatePath(args.status, args.id));
  if (args.editedDate) paths.push(confluencePageByEditedPath(args.editedDate, args.id));
  if (args.spaceId) paths.push(confluencePageBySpaceAliasPath(args.spaceId, args.id));
  if (args.parentId) paths.push(confluencePageByParentAliasPath(args.parentId, args.id));
  return paths;
}

function confluenceSpacePaths(args: { id: string } & SpaceState): string[] {
  const paths = [confluenceSpacePath(args.id, args.name ?? args.key)];
  paths.push(confluenceSpaceByIdAliasPath(args.id));
  if (args.name && slugifies(args.name)) paths.push(confluenceSpaceByTitleAliasPath(args.name, args.id));
  if (args.key) paths.push(confluenceSpaceByKeyAliasPath(args.key));
  return paths;
}

function diffPaths(prior: readonly string[], next: readonly string[]): string[] {
  const nextSet = new Set(next);
  const seen = new Set<string>();
  return prior.filter((path) => {
    if (nextSet.has(path) || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function extractTimestampMs(record: Record<string, unknown> | null): number | null {
  if (!record) return null;
  const payload = pickPayload(record) ?? record;
  for (const key of PROVIDER_TIMESTAMP_KEYS) {
    const raw = payload[key];
    const parsed = typeof raw === "string" || typeof raw === "number" ? parseTimestampMs(raw) : null;
    if (parsed !== null) return parsed;
  }
  const version = isObject(payload.version) ? payload.version : null;
  const versionCreatedAt = version ? readFirstString(version, "createdAt", "created_at") : null;
  return versionCreatedAt ? parseTimestampMs(versionCreatedAt) : null;
}

function extractDateSegment(record: Record<string, unknown> | null): string | undefined {
  const timestampMs = extractTimestampMs(record);
  return timestampMs === null ? undefined : new Date(timestampMs).toISOString().slice(0, 10);
}

function parseTimestampMs(value: string | number): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 10_000_000_000 ? value : value * 1000;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/u.test(trimmed)) return parseTimestampMs(Number(trimmed));
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function isStaleAgainstAny(
  incoming: Record<string, unknown>,
  existing: readonly (Record<string, unknown> | null)[],
): boolean {
  const incomingMs = extractTimestampMs(incoming);
  return incomingMs !== null && existing.some((record) => {
    const existingMs = extractTimestampMs(record);
    return existingMs !== null && incomingMs < existingMs;
  });
}

function deleteWrite(path: string, context: ProviderWritePlannerContext): PlannedRelayfileWrite {
  return {
    path,
    delete: true,
    baseRevision: revisionFor(context, path) ?? "*",
  };
}

function pageIndexRow(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: readId(record),
    title: readFirstString(record, "title") ?? readId(record),
    updated: confluenceIndexUpdated(record),
    ...(readFirstString(record, "spaceId", "space_id")
      ? { spaceId: readFirstString(record, "spaceId", "space_id") }
      : {}),
    ...(readFirstString(record, "status") ? { status: readFirstString(record, "status") } : {}),
  };
}

function spaceIndexRow(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: readId(record) || readId(record, "key"),
    title: readFirstString(record, "name", "title", "key") ?? readId(record),
    updated: confluenceIndexUpdated(record),
    ...(readFirstString(record, "key") ? { key: readFirstString(record, "key") } : {}),
  };
}

function confluenceIndexUpdated(record: Record<string, unknown>): string {
  return (
    readFirstString(record, "updated", "updatedAt", "updated_at") ??
    (isObject(record.version) ? readFirstString(record.version, "createdAt", "created_at") : null) ??
    readFirstString(record, "createdAt", "created_at") ??
    ""
  );
}

function confluencePageEditedAt(record: Record<string, unknown>): string {
  return (
    (isObject(record.version) ? readFirstString(record.version, "createdAt") : null) ??
    readFirstString(record, "createdAt") ??
    ""
  );
}

export function editedDateSegment(value: string | undefined): string | undefined {
  return value?.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1];
}

function sortedIndexContent(rows: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify([...rows].sort((a, b) => {
    const updatedA = typeof a.updated === "string" ? a.updated : "";
    const updatedB = typeof b.updated === "string" ? b.updated : "";
    if (updatedA !== updatedB) return updatedB.localeCompare(updatedA);
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  }))}\n`;
}

function mergeIndexRows(
  existingRows: readonly Record<string, unknown>[],
  upserts: readonly Record<string, unknown>[],
  removes: ReadonlySet<string>,
): Record<string, unknown>[] {
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of existingRows) {
    const id = readId(row);
    if (id && !removes.has(id)) rows.set(id, row);
  }
  for (const row of upserts) {
    const id = readId(row);
    if (id) rows.set(id, row);
  }
  return [...rows.values()];
}

type SlackObjectType = "channel" | "user" | "message";
type SlackMessageBucketType = "message" | "thread" | "thread_reply";

type SlackAuxRecord = Record<string, unknown> & {
  _deleted?: true;
  channelId?: string;
  ts?: string;
  threadTs?: string;
  replyTs?: string;
};

type PriorSlackUserState = {
  name?: string;
  title?: string;
  is_bot?: boolean;
};

function normalizeSlackObjectType(model: string): SlackObjectType {
  const normalized = model.trim().toLowerCase();
  if (normalized === "slackchannel" || normalized === "channel") return "channel";
  if (normalized === "slackuser" || normalized === "user") return "user";
  if (normalized === "slackmessage" || normalized === "message") return "message";
  throw new Error(`Unsupported Slack object type: ${model}`);
}

function slackCanonicalRecordPath(
  cleaned: Record<string, unknown>,
  model: string,
): string {
  const objectType = normalizeSlackObjectType(model);
  if (objectType === "message") {
    const channelId = readId(cleaned, "channel");
    const ts = readId(cleaned, "ts");
    if (!channelId || !ts) {
      throw new Error("Missing Slack message channel or timestamp");
    }
    const threadTs = readId(cleaned, "thread_ts");
    const replyCount = numericValue(cleaned.reply_count);
    if (threadTs && threadTs !== ts) {
      return threadReplyPath(channelId, threadTs, ts, undefined);
    }
    if (threadTs === ts || replyCount > 0) {
      return threadPath(channelId, threadTs || ts, undefined);
    }
    return messagePath(channelId, ts, readOptionalString(cleaned, "text"), undefined);
  }
  if (objectType === "user") {
    const userId = readId(cleaned);
    if (!userId) throw new Error("Missing Slack user id");
    return userMetadataPath(
      userId,
      readOptionalString(cleaned, "name", "real_name", "display_name"),
    );
  }
  const channelId = readId(cleaned);
  if (!channelId) throw new Error("Missing Slack channel id");
  return channelMetadataPath(
    channelId,
    readOptionalString(cleaned, "name", "name_normalized"),
  );
}

function readOptionalString(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = readString(record, key)?.trim();
    if (value) return value;
  }
  return undefined;
}

function readNestedObject(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isObject(value) ? value : null;
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function slackSlugifyAlias(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_HUMAN_READABLE_LENGTH)
    .replace(/^-+|-+$/g, "");
  return normalized || "untitled";
}

function slackSlugifies(value: string): boolean {
  return slackSlugifyAlias(value) !== "untitled";
}

function slackNormalizeSegment(value: string, fallback = "unknown"): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/[^A-Za-z0-9._+=@-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function slackPathSlugify(value: string): string {
  return value
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function slackTimestampToPathToken(ts: string): string {
  return slackNormalizeSegment(ts.replace(/\./g, "_"), "0");
}

function joinSlackPath(...segments: string[]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .map((segment, index) => {
      if (index === 0) return segment.replace(/\/+$/g, "") || "/";
      return segment.replace(/^\/+|\/+$/g, "");
    })
    .join("/");
}

function slackNameWithId(humanReadable: string | undefined, id: string): string {
  const normalizedId = slackNormalizeSegment(id);
  const trimmedName = humanReadable?.trim();
  const slug =
    trimmedName && !isSlackIdFallbackName(trimmedName, id)
      ? slackPathSlugify(trimmedName)
      : "";
  return slug ? `${normalizedId}__${slug}` : normalizedId;
}

function isSlackIdFallbackName(value: string, id: string): boolean {
  return (
    value.localeCompare(id, undefined, { sensitivity: "accent" }) === 0 ||
    slackPathSlugify(value) === slackPathSlugify(id)
  );
}

function channelMetadataPath(channelId: string, channelName?: string): string {
  return joinSlackPath("/slack", "channels", slackNameWithId(channelName, channelId), "meta.json");
}

function channelMessagesDirectory(channelId: string, channelName?: string): string {
  return joinSlackPath("/slack", "channels", slackNameWithId(channelName, channelId), "messages");
}

function messagePath(
  channelId: string,
  messageTs: string,
  _messageText?: string,
  channelName?: string,
): string {
  return joinSlackPath(
    channelMessagesDirectory(channelId, channelName),
    slackTimestampToPathToken(messageTs),
    "meta.json",
  );
}

function channelThreadsDirectory(channelId: string, channelName?: string): string {
  return joinSlackPath("/slack", "channels", slackNameWithId(channelName, channelId), "threads");
}

function threadPath(channelId: string, threadTs: string, channelName?: string): string {
  return joinSlackPath(
    channelThreadsDirectory(channelId, channelName),
    slackTimestampToPathToken(threadTs),
    "meta.json",
  );
}

function threadReplyPath(
  channelId: string,
  threadTs: string,
  replyTs: string,
  channelName?: string,
): string {
  // Directory record (`replies/<ts>/meta.json`), matching messagePath/threadPath
  // above and @relayfile/adapter-slack >= 0.3.11. A flat `replies/<ts>.json`
  // leaf collides with the same-named reaction directory and can't be
  // materialized on a POSIX mount — keep parity with the adapter so the synced
  // tree and the writeback tree agree.
  return joinSlackPath(
    channelThreadsDirectory(channelId, channelName),
    slackTimestampToPathToken(threadTs),
    "replies",
    slackTimestampToPathToken(replyTs),
    "meta.json",
  );
}

function userMetadataPath(userId: string, userName?: string): string {
  return joinSlackPath("/slack", "users", slackNameWithId(userName, userId), "meta.json");
}

function slackRootIndexPath(): string {
  return joinSlackPath("/slack", "_index.json");
}

function slackChannelsIndexPath(): string {
  return joinSlackPath("/slack", "channels", "_index.json");
}

function slackUsersIndexPath(): string {
  return joinSlackPath("/slack", "users", "_index.json");
}

function slackDiscoveryChannelsIndexPath(): string {
  return joinSlackPath("/discovery", "slack", "channels", "_index.json");
}

function slackDiscoveryUsersIndexPath(): string {
  return joinSlackPath("/discovery", "slack", "users", "_index.json");
}

function slackAliasFilename(name: string, id: string, colliding: boolean): string {
  const slug = slackSlugifyAlias(name);
  return colliding ? `${slug}-${sha256HexPrefix(id)}` : slug;
}

function slackByNameChannelAliasPath(
  channelName: string,
  channelId: string,
  colliding = false,
): string {
  return joinSlackPath(
    "/slack",
    "channels",
    "by-name",
    `${slackAliasFilename(channelName, channelId, colliding)}.json`,
  );
}

function slackByNameUserAliasPath(
  userName: string,
  userId: string,
  colliding = false,
): string {
  return joinSlackPath(
    "/slack",
    "users",
    "by-name",
    `${slackAliasFilename(userName, userId, colliding)}.json`,
  );
}

function slackBotsAliasPath(userId: string, userName?: string): string {
  return joinSlackPath("/slack", "users", "bots", `${slackNameWithId(userName, userId)}.json`);
}

function utf8Bytes(input: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    let codePoint = input.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < input.length) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function rightRotate32(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256HexPrefix(input: string): string {
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = utf8Bytes(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  for (let shift = 56; shift >= 0; shift -= 8) {
    bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff);
  }

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Array<number>(64);
  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      const offset = chunk + i * 4;
      words[i] =
        ((bytes[offset] ?? 0) << 24) |
        ((bytes[offset + 1] ?? 0) << 16) |
        ((bytes[offset + 2] ?? 0) << 8) |
        (bytes[offset + 3] ?? 0);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rightRotate32(words[i - 15] ?? 0, 7) ^
        rightRotate32(words[i - 15] ?? 0, 18) ^
        ((words[i - 15] ?? 0) >>> 3);
      const s1 = rightRotate32(words[i - 2] ?? 0, 17) ^
        rightRotate32(words[i - 2] ?? 0, 19) ^
        ((words[i - 2] ?? 0) >>> 10);
      words[i] = (((words[i - 16] ?? 0) + s0 + (words[i - 7] ?? 0) + s1) >>> 0);
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rightRotate32(e, 6) ^ rightRotate32(e, 11) ^ rightRotate32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[i]! + words[i]!) >>> 0;
      const s0 = rightRotate32(a, 2) ^ rightRotate32(a, 13) ^ rightRotate32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return h
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("")
    .slice(0, 8);
}

function existingFilePresent(
  context: ProviderWritePlannerContext,
  path: string,
): boolean {
  return readContextValue(context.existingFiles, path) !== undefined;
}

function deleteWriteIfExisting(
  path: string,
  context: ProviderWritePlannerContext,
): PlannedRelayfileWrite | null {
  if (context.existingFiles && !existingFilePresent(context, path)) return null;
  return deleteWrite(path, context);
}

function pushSlackDelete(
  writes: PlannedRelayfileWrite[],
  deletedPaths: Set<string>,
  path: string,
  context: ProviderWritePlannerContext,
): void {
  if (deletedPaths.has(path)) return;
  const write = deleteWriteIfExisting(path, context);
  if (!write) return;
  deletedPaths.add(path);
  writes.push(write);
}

function wrappedSlackContent(
  objectType: string,
  objectId: string,
  payload: unknown,
  job: NangoSyncJob,
): string {
  return JSON.stringify(
    {
      provider: "slack",
      objectType,
      objectId,
      deleted: false,
      payload,
      ...(job.connectionId ? { connectionId: job.connectionId } : {}),
    },
    null,
    2,
  );
}

function slackRootIndexContent(): string {
  return `${JSON.stringify([
    { name: "channels", path: "/slack/channels" },
    { name: "users", path: "/slack/users" },
  ])}\n`;
}

function slackChannelIndexRow(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: readId(record),
    title: readOptionalString(record, "name") ?? "",
    updated: readOptionalString(record, "updated") ?? "",
  };
}

function slackDiscoveryChannelIndexRow(row: Record<string, unknown>): Record<string, unknown> | null {
  const id = readId(row);
  if (!id) return null;
  const name = readOptionalString(row, "title") ?? readOptionalString(row, "name") ?? "";
  return {
    id,
    name,
    title: name,
    path: `/slack/channels/${id}`,
    messagesPath: `/slack/channels/${id}/messages`,
  };
}

function slackUserHandle(record: Record<string, unknown>): string | undefined {
  return readOptionalString(record, "name");
}

function slackUserDisplayName(record: Record<string, unknown>): string | undefined {
  const profile = readNestedObject(record, "profile");
  if (profile) {
    const displayName = readOptionalString(profile, "display_name");
    if (displayName) return displayName;
    const realName = readOptionalString(profile, "real_name");
    if (realName) return realName;
  }
  return readOptionalString(record, "real_name", "name");
}

function slackUserSlugSource(record: Record<string, unknown>): string | undefined {
  return slackUserHandle(record) ?? slackUserDisplayName(record);
}

function slackUserIndexRow(record: Record<string, unknown>): Record<string, unknown> {
  const handle = slackUserHandle(record);
  const displayName = slackUserDisplayName(record) ?? handle;
  return {
    id: readId(record),
    title: displayName ?? "",
    updated: readOptionalString(record, "updated") ?? "",
    is_bot: record.is_bot === true,
    ...(handle ? { name: handle } : {}),
  };
}

function slackDiscoveryUserIndexRow(row: Record<string, unknown>): Record<string, unknown> | null {
  const id = readId(row);
  if (!id) return null;
  const name = readOptionalString(row, "name") ?? "";
  const title = readOptionalString(row, "title") ?? name;
  return {
    id,
    name,
    title,
    path: `/slack/users/${id}`,
    messagesPath: `/slack/users/${id}/messages`,
    is_bot: row.is_bot === true,
  };
}

function compactIndexRows(
  rows: readonly Record<string, unknown>[],
  mapRow: (row: Record<string, unknown>) => Record<string, unknown> | null,
): Record<string, unknown>[] {
  return rows
    .map(mapRow)
    .filter((row): row is Record<string, unknown> => row !== null);
}

function readPriorSlackChannelNames(
  context: ProviderWritePlannerContext,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of readJsonArray(context, slackChannelsIndexPath())) {
    const id = readId(row);
    const title = readOptionalString(row, "title");
    if (id && title) names.set(id, title);
  }
  return names;
}

function readPriorSlackUsers(
  context: ProviderWritePlannerContext,
): Map<string, PriorSlackUserState> {
  const users = new Map<string, PriorSlackUserState>();
  for (const row of readJsonArray(context, slackUsersIndexPath())) {
    const id = readId(row);
    if (!id) continue;
    const state: PriorSlackUserState = { is_bot: row.is_bot === true };
    const name = readOptionalString(row, "name");
    if (name) state.name = name;
    const title = readOptionalString(row, "title");
    if (title) state.title = title;
    users.set(id, state);
  }
  return users;
}

function computeCollidingSlackSlugs(
  records: readonly SlackAuxRecord[],
  slugSource: (record: SlackAuxRecord) => string | undefined,
): ReadonlySet<string> {
  const slugToIds = new Map<string, Set<string>>();
  for (const record of records) {
    if (record._deleted === true) continue;
    const id = readId(record);
    if (!id) continue;
    const source = slugSource(record);
    if (!source) continue;
    const slug = slackSlugifyAlias(source);
    if (slug === "untitled") continue;
    const ids = slugToIds.get(slug) ?? new Set<string>();
    ids.add(id);
    slugToIds.set(slug, ids);
  }
  const colliding = new Set<string>();
  for (const [slug, ids] of slugToIds) {
    if (ids.size > 1) colliding.add(slug);
  }
  return colliding;
}

function slackMessageBucket(record: Record<string, unknown>): SlackMessageBucketType {
  const ts = readId(record, "ts");
  const threadTs = readId(record, "thread_ts") || readId(record, "threadTs");
  const replyCount = numericValue(record.reply_count) || numericValue(record.replyCount);
  if (threadTs && ts && threadTs !== ts) return "thread_reply";
  if ((threadTs && ts && threadTs === ts) || replyCount > 0) return "thread";
  return "message";
}

function toSlackAuxRecord(
  raw: Record<string, unknown>,
  objectType: SlackObjectType,
): SlackAuxRecord {
  const cleaned = stripNangoMetadata(raw) as SlackAuxRecord;
  if (!isDeletedNangoRecord(raw)) {
    if (objectType === "message" && cleaned.channelId === undefined && cleaned.channel) {
      cleaned.channelId = String(cleaned.channel);
    }
    if (objectType === "message") {
      const ts = readId(cleaned, "ts");
      const threadTs = readId(cleaned, "thread_ts") || readId(cleaned, "threadTs");
      const bucket = slackMessageBucket(cleaned);
      if (bucket === "thread_reply") {
        if (cleaned.threadTs === undefined) cleaned.threadTs = threadTs;
        if (cleaned.replyTs === undefined) cleaned.replyTs = ts;
      } else if (bucket === "thread") {
        if (cleaned.threadTs === undefined) cleaned.threadTs = threadTs || ts;
      }
    }
    return cleaned;
  }

  if (objectType === "channel" || objectType === "user") {
    return { id: readId(cleaned), _deleted: true };
  }

  const channelId = readId(cleaned, "channel") || readId(cleaned, "channelId");
  const ts = readId(cleaned, "ts");
  const threadTs = readId(cleaned, "thread_ts") || readId(cleaned, "threadTs");
  const tombstone: SlackAuxRecord = {
    id: readId(cleaned) || ts,
    _deleted: true,
  };
  if (channelId) tombstone.channelId = channelId;
  if (ts) tombstone.ts = ts;
  const bucket = slackMessageBucket(cleaned);
  if (bucket === "thread_reply") {
    tombstone.threadTs = threadTs;
    tombstone.replyTs = ts;
  } else if (bucket === "thread") {
    tombstone.threadTs = threadTs || ts;
  }
  return tombstone;
}

function resolveSlackChannelName(
  channelNameById: ReadonlyMap<string, string>,
  channelId: string,
  recordChannelName: unknown,
): string | undefined {
  const fromMap = channelNameById.get(channelId);
  if (fromMap) return fromMap;
  return typeof recordChannelName === "string" && recordChannelName.trim()
    ? recordChannelName.trim()
    : undefined;
}

function emitSlackChannelAuxWrites(
  writes: PlannedRelayfileWrite[],
  deletedPaths: Set<string>,
  records: readonly SlackAuxRecord[],
  job: NangoSyncJob,
  context: ProviderWritePlannerContext,
): void {
  const priorNameById = readPriorSlackChannelNames(context);
  const collidingSlugs = computeCollidingSlackSlugs(records, (record) =>
    readOptionalString(record, "name"),
  );
  const appliedRows: Record<string, unknown>[] = [];
  const removedIds = new Set<string>();

  for (const record of records) {
    const id = readId(record);
    if (!id) continue;
    if (record._deleted === true) {
      const prior = priorNameById.get(id);
      pushSlackDelete(writes, deletedPaths, channelMetadataPath(id, prior), context);
      if (prior && slackSlugifies(prior)) {
        pushSlackDelete(writes, deletedPaths, slackByNameChannelAliasPath(prior, id), context);
      }
      removedIds.add(id);
      continue;
    }

    const name = readOptionalString(record, "name") ?? priorNameById.get(id);
    const payload = name && !readOptionalString(record, "name")
      ? { ...record, name }
      : record;
    const content = wrappedSlackContent("channel", id, payload, job);
    const canonicalPath = channelMetadataPath(id, name);
    const prior = priorNameById.get(id);
    if (prior && prior !== name) {
      pushSlackDelete(writes, deletedPaths, channelMetadataPath(id, prior), context);
      if (slackSlugifies(prior)) {
        pushSlackDelete(writes, deletedPaths, slackByNameChannelAliasPath(prior, id), context);
      }
    }
    writes.push({ path: canonicalPath, contents: content, contentType: JSON_CONTENT_TYPE, baseRevision: "*" });
    if (name && slackSlugifies(name)) {
      writes.push({
        path: slackByNameChannelAliasPath(name, id, collidingSlugs.has(slackSlugifyAlias(name))),
        contents: content,
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
    }
    appliedRows.push(slackChannelIndexRow(record));
  }

  const indexRows = mergeIndexRows(
    readJsonArray(context, slackChannelsIndexPath()),
    appliedRows,
    removedIds,
  );
  writes.push({
    path: slackChannelsIndexPath(),
    contents: sortedIndexContent(indexRows),
    contentType: JSON_CONTENT_TYPE,
    baseRevision: "*",
  });
  writes.push({
    path: slackDiscoveryChannelsIndexPath(),
    contents: sortedIndexContent(compactIndexRows(indexRows, slackDiscoveryChannelIndexRow)),
    contentType: JSON_CONTENT_TYPE,
    baseRevision: "*",
  });
}

function emitSlackUserAuxWrites(
  writes: PlannedRelayfileWrite[],
  deletedPaths: Set<string>,
  records: readonly SlackAuxRecord[],
  job: NangoSyncJob,
  context: ProviderWritePlannerContext,
): void {
  const priorById = readPriorSlackUsers(context);
  const collidingSlugs = computeCollidingSlackSlugs(records, slackUserSlugSource);
  const appliedRows: Record<string, unknown>[] = [];
  const removedIds = new Set<string>();

  for (const record of records) {
    const id = readId(record);
    if (!id) continue;
    if (record._deleted === true) {
      const prior = priorById.get(id);
      const priorSlug = prior?.name ?? prior?.title;
      pushSlackDelete(writes, deletedPaths, userMetadataPath(id, priorSlug), context);
      if (priorSlug && slackSlugifies(priorSlug)) {
        pushSlackDelete(writes, deletedPaths, slackByNameUserAliasPath(priorSlug, id), context);
      }
      if (prior?.is_bot === true) {
        pushSlackDelete(writes, deletedPaths, slackBotsAliasPath(id, priorSlug), context);
      }
      removedIds.add(id);
      continue;
    }

    const handle = slackUserHandle(record);
    const displayName = slackUserDisplayName(record) ?? handle;
    const slugSource = handle ?? displayName;
    const isBot = record.is_bot === true;
    const content = wrappedSlackContent("user", id, record, job);
    const prior = priorById.get(id);
    if (prior) {
      const priorSlug = prior.name ?? prior.title;
      if (priorSlug && priorSlug !== slugSource) {
        pushSlackDelete(writes, deletedPaths, userMetadataPath(id, priorSlug), context);
        if (slackSlugifies(priorSlug)) {
          pushSlackDelete(writes, deletedPaths, slackByNameUserAliasPath(priorSlug, id), context);
        }
        if (prior.is_bot === true) {
          pushSlackDelete(writes, deletedPaths, slackBotsAliasPath(id, priorSlug), context);
        }
      } else if (prior.is_bot === true && !isBot) {
        pushSlackDelete(writes, deletedPaths, slackBotsAliasPath(id, priorSlug ?? slugSource), context);
      }
    }
    writes.push({
      path: userMetadataPath(id, slugSource),
      contents: content,
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
    if (slugSource && slackSlugifies(slugSource)) {
      writes.push({
        path: slackByNameUserAliasPath(
          slugSource,
          id,
          collidingSlugs.has(slackSlugifyAlias(slugSource)),
        ),
        contents: content,
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
    }
    if (isBot) {
      writes.push({
        path: slackBotsAliasPath(id, slugSource),
        contents: content,
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
    }

    appliedRows.push(slackUserIndexRow(record));
  }

  const indexRows = mergeIndexRows(
    readJsonArray(context, slackUsersIndexPath()),
    appliedRows,
    removedIds,
  );
  writes.push({
    path: slackUsersIndexPath(),
    contents: sortedIndexContent(indexRows),
    contentType: JSON_CONTENT_TYPE,
    baseRevision: "*",
  });
  writes.push({
    path: slackDiscoveryUsersIndexPath(),
    contents: sortedIndexContent(compactIndexRows(indexRows, slackDiscoveryUserIndexRow)),
    contentType: JSON_CONTENT_TYPE,
    baseRevision: "*",
  });
}

function emitSlackExistingDiscoveryIndexWrite(
  writes: PlannedRelayfileWrite[],
  context: ProviderWritePlannerContext,
  objectType: SlackObjectType,
): void {
  if (objectType === "channel") {
    if (readContextValue(context.existingFiles, slackChannelsIndexPath()) === undefined) return;
    writes.push({
      path: slackDiscoveryChannelsIndexPath(),
      contents: sortedIndexContent(
        compactIndexRows(
          readJsonArray(context, slackChannelsIndexPath()),
          slackDiscoveryChannelIndexRow,
        ),
      ),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  } else if (objectType === "user") {
    if (readContextValue(context.existingFiles, slackUsersIndexPath()) === undefined) return;
    writes.push({
      path: slackDiscoveryUsersIndexPath(),
      contents: sortedIndexContent(
        compactIndexRows(
          readJsonArray(context, slackUsersIndexPath()),
          slackDiscoveryUserIndexRow,
        ),
      ),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }
}

function emitSlackMessageAuxWrites(
  writes: PlannedRelayfileWrite[],
  deletedPaths: Set<string>,
  records: readonly SlackAuxRecord[],
  bucket: SlackMessageBucketType,
  job: NangoSyncJob,
  context: ProviderWritePlannerContext,
  channelNameById: ReadonlyMap<string, string>,
): void {
  for (const record of records) {
    const channelId = readId(record, "channelId");
    if (!channelId) continue;
    const channelName = resolveSlackChannelName(channelNameById, channelId, record.channelName);
    if (bucket === "message") {
      const ts = readId(record, "ts");
      if (!ts) continue;
      const path = messagePath(channelId, ts, undefined, channelName);
      if (record._deleted === true) {
        pushSlackDelete(writes, deletedPaths, path, context);
      } else {
        writes.push({
          path,
          contents: wrappedSlackContent("message", `${channelId}:${ts}`, record, job),
          contentType: JSON_CONTENT_TYPE,
          baseRevision: "*",
        });
      }
      continue;
    }
    if (bucket === "thread") {
      const threadTs = readId(record, "threadTs");
      if (!threadTs) continue;
      const path = threadPath(channelId, threadTs, channelName);
      if (record._deleted === true) {
        pushSlackDelete(writes, deletedPaths, path, context);
      } else {
        writes.push({
          path,
          contents: wrappedSlackContent("thread", `${channelId}:${threadTs}`, record, job),
          contentType: JSON_CONTENT_TYPE,
          baseRevision: "*",
        });
      }
      continue;
    }
    const threadTs = readId(record, "threadTs");
    const replyTs = readId(record, "replyTs");
    if (!threadTs || !replyTs) continue;
    const path = threadReplyPath(channelId, threadTs, replyTs, channelName);
    if (record._deleted === true) {
      pushSlackDelete(writes, deletedPaths, path, context);
    } else {
      writes.push({
        path,
        contents: wrappedSlackContent(
          "thread_reply",
          `${channelId}:${threadTs}:${replyTs}`,
          record,
          job,
        ),
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
    }
  }
}

function planSlackRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const objectType = normalizeSlackObjectType(job.model);
  const writes: PlannedRelayfileWrite[] = [];
  const deletedPaths = new Set<string>();
  const appliedAuxRecords: SlackAuxRecord[] = [];
  let written = 0;
  let deleted = 0;
  let skipped = 0;

  for (const raw of records) {
    const cleaned = stripNangoMetadata(raw);
    const canonicalPath = slackCanonicalRecordPath(cleaned, job.model);
    const existingCanonical = readJsonObject(context, canonicalPath);
    if (isStaleAgainstAny(raw, [existingCanonical])) {
      skipped += 1;
      continue;
    }

    if (isDeletedNangoRecord(raw)) {
      pushSlackDelete(writes, deletedPaths, canonicalPath, context);
      deleted += 1;
    } else {
      writes.push({
        path: canonicalPath,
        contents: JSON.stringify(cleaned),
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
      written += 1;
    }
    appliedAuxRecords.push(toSlackAuxRecord(raw, objectType));
  }

  if (appliedAuxRecords.length === 0) {
    emitSlackExistingDiscoveryIndexWrite(writes, context, objectType);
    return { writes, written, deleted, skipped };
  }

  writes.push({
    path: slackRootIndexPath(),
    contents: slackRootIndexContent(),
    contentType: JSON_CONTENT_TYPE,
    baseRevision: "*",
  });

  if (objectType === "channel") {
    emitSlackChannelAuxWrites(writes, deletedPaths, appliedAuxRecords, job, context);
  } else if (objectType === "user") {
    emitSlackUserAuxWrites(writes, deletedPaths, appliedAuxRecords, job, context);
  } else {
    const priorChannelNameById = readPriorSlackChannelNames(context);
    const channelNameById = new Map(priorChannelNameById);
    const messages: SlackAuxRecord[] = [];
    const threads: SlackAuxRecord[] = [];
    const threadReplies: SlackAuxRecord[] = [];
    for (const record of appliedAuxRecords) {
      const bucket = slackMessageBucket(record);
      if (bucket === "thread_reply") threadReplies.push(record);
      else if (bucket === "thread") threads.push(record);
      else messages.push(record);
    }
    emitSlackMessageAuxWrites(
      writes,
      deletedPaths,
      messages,
      "message",
      job,
      context,
      channelNameById,
    );
    emitSlackMessageAuxWrites(
      writes,
      deletedPaths,
      threads,
      "thread",
      job,
      context,
      channelNameById,
    );
    emitSlackMessageAuxWrites(
      writes,
      deletedPaths,
      threadReplies,
      "thread_reply",
      job,
      context,
      channelNameById,
    );
  }

  return { writes, written, deleted, skipped };
}

function planConfluenceRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const writes: PlannedRelayfileWrite[] = [];
  const deletedPaths = new Set<string>();
  const appliedPages: Record<string, unknown>[] = [];
  const appliedSpaces: Record<string, unknown>[] = [];
  const removedPageIds = new Set<string>();
  const removedSpaceIds = new Set<string>();
  let written = 0;
  let deleted = 0;
  let skipped = 0;

  const pushDelete = (path: string) => {
    if (deletedPaths.has(path)) return;
    deletedPaths.add(path);
    writes.push(deleteWrite(path, context));
  };

  for (const raw of records) {
    const objectType = normalizeConfluenceObjectType(job.model);
    const cleaned = stripNangoMetadata(raw);
    const objectId = objectType === "space" ? readId(cleaned) || readId(cleaned, "key") : readId(cleaned);
    if (!objectId) throw new Error(`Missing Confluence ${objectType} id`);

    if (objectType === "page") {
      const title = readFirstString(cleaned, "title") ?? undefined;
      const spaceId = readFirstString(cleaned, "spaceId", "space_id") ?? undefined;
      const canonicalPath = confluencePagePath(objectId, title, spaceId);
      const previousAlias = readJsonObject(context, confluencePageByIdAliasPath(objectId));
      const previousIndexRow = readJsonArray(context, confluencePagesIndexPath())
        .find((row) => readId(row) === objectId) ?? null;
      if (isStaleAgainstAny(raw, [previousAlias, previousIndexRow])) {
        skipped += 1;
        continue;
      }
      const prior = extractPriorPageState(previousAlias);
      if (!isDeletedNangoRecord(raw) && prior?.title) {
        const previousPath = confluencePagePath(objectId, prior.title, prior.spaceId);
        if (previousPath !== canonicalPath) pushDelete(previousPath);
      }
      if (isDeletedNangoRecord(raw)) {
        pushDelete(canonicalPath);
        removedPageIds.add(objectId);
        deleted += 1;
      } else {
        writes.push({
          path: canonicalPath,
          contents: JSON.stringify(cleaned),
          contentType: JSON_CONTENT_TYPE,
          baseRevision: "*",
          semantics: buildConfluenceSyncSemantics("page", objectId, cleaned, job),
        });
        appliedPages.push(cleaned);
        written += 1;
      }
      continue;
    }

    const name = readFirstString(cleaned, "name", "title") ?? readFirstString(cleaned, "key") ?? undefined;
    const key = readFirstString(cleaned, "key") ?? undefined;
    const canonicalPath = confluenceSpacePath(objectId, name);
    const previousAlias = readJsonObject(context, confluenceSpaceByIdAliasPath(objectId));
    const prior = extractPriorSpaceState(previousAlias);
    if (!isDeletedNangoRecord(raw) && prior?.name) {
      const previousPath = confluenceSpacePath(objectId, prior.name ?? prior.key);
      if (previousPath !== canonicalPath) pushDelete(previousPath);
    }
    if (isDeletedNangoRecord(raw)) {
      pushDelete(canonicalPath);
      removedSpaceIds.add(objectId);
      deleted += 1;
    } else {
      writes.push({
        path: canonicalPath,
        contents: JSON.stringify(cleaned),
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
        semantics: buildConfluenceSyncSemantics("space", objectId, cleaned, job),
      });
      appliedSpaces.push(cleaned);
      written += 1;
    }
  }

  if (
    appliedPages.length > 0 ||
    appliedSpaces.length > 0 ||
    removedPageIds.size > 0 ||
    removedSpaceIds.size > 0
  ) {
    writes.push({
      path: "/confluence/_index.json",
      contents: "[{\"id\":\"pages\",\"title\":\"Pages\"},{\"id\":\"spaces\",\"title\":\"Spaces\"}]\n",
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }

  if (appliedPages.length > 0 || removedPageIds.size > 0) {
    for (const page of appliedPages) {
      const id = readId(page);
      const title = readFirstString(page, "title") ?? undefined;
      const status = readFirstString(page, "status") ?? undefined;
      const spaceId = readFirstString(page, "spaceId", "space_id") ?? undefined;
      const parentId = readFirstString(page, "parentId", "parent_id") ?? undefined;
      const editedDate = editedDateSegment(confluencePageEditedAt(page));
      const previous = extractPriorPageState(readJsonObject(context, confluencePageByIdAliasPath(id)));
      const nextPaths = confluencePagePaths({ id, title, status, spaceId, parentId, editedDate });
      if (previous) {
        for (const stalePath of diffPaths(confluencePagePaths({ id, ...previous }), nextPaths)) {
          pushDelete(stalePath);
        }
      }
      const contents = wrappedConfluenceContent("page", id, page, job);
      for (const path of nextPaths) {
        writes.push({ path, contents, contentType: JSON_CONTENT_TYPE, baseRevision: "*" });
      }
    }
    for (const id of removedPageIds) {
      const previous = extractPriorPageState(readJsonObject(context, confluencePageByIdAliasPath(id)));
      for (const path of confluencePagePaths({ id, ...(previous ?? {}) })) {
        pushDelete(path);
      }
    }
    const indexRows = mergeIndexRows(
      readJsonArray(context, confluencePagesIndexPath()),
      appliedPages.map(pageIndexRow),
      removedPageIds,
    );
    writes.push({
      path: confluencePagesIndexPath(),
      contents: sortedIndexContent(indexRows),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }

  if (appliedSpaces.length > 0 || removedSpaceIds.size > 0) {
    for (const space of appliedSpaces) {
      const id = readId(space) || readId(space, "key");
      const name = readFirstString(space, "name", "title") ?? readFirstString(space, "key") ?? undefined;
      const key = readFirstString(space, "key") ?? undefined;
      const previous = extractPriorSpaceState(readJsonObject(context, confluenceSpaceByIdAliasPath(id)));
      const nextPaths = confluenceSpacePaths({ id, name, key });
      if (previous) {
        for (const stalePath of diffPaths(confluenceSpacePaths({ id, ...previous }), nextPaths)) {
          pushDelete(stalePath);
        }
      }
      const contents = wrappedConfluenceContent("space", id, space, job);
      for (const path of nextPaths) {
        writes.push({ path, contents, contentType: JSON_CONTENT_TYPE, baseRevision: "*" });
      }
    }
    for (const id of removedSpaceIds) {
      const previous = extractPriorSpaceState(readJsonObject(context, confluenceSpaceByIdAliasPath(id)));
      for (const path of confluenceSpacePaths({ id, ...(previous ?? {}) })) {
        pushDelete(path);
      }
    }
    const indexRows = mergeIndexRows(
      readJsonArray(context, confluenceSpacesIndexPath()),
      appliedSpaces.map(spaceIndexRow),
      removedSpaceIds,
    );
    writes.push({
      path: confluenceSpacesIndexPath(),
      contents: sortedIndexContent(indexRows),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }

  return { writes, written, deleted, skipped };
}

type JiraPlannerObjectType = "issue" | "project" | "sprint";

const JIRA_PATH_ROOT = "/jira";
const GITLAB_PATH_ROOT = "/gitlab";

function encodeProviderSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Provider path segment must be a non-empty string");
  return encodeURIComponent(trimmed);
}

function normalizeJiraPlannerObjectType(model: string): JiraPlannerObjectType {
  const normalized = model.trim().toLowerCase();
  if (normalized === "jiraissue" || normalized === "issue") return "issue";
  if (normalized === "jiraproject" || normalized === "project") return "project";
  if (normalized === "jirasprint" || normalized === "sprint") return "sprint";
  throw new Error(`Unsupported Jira model: ${model}`);
}

function jiraFields(record: Record<string, unknown>): Record<string, unknown> | null {
  return isObject(record.fields) ? record.fields : null;
}

function jiraIssueSummary(record: Record<string, unknown>): string | undefined {
  const fields = jiraFields(record);
  return (fields ? readFirstString(fields, "summary") : null) ?? undefined;
}

function jiraIssueStatus(record: Record<string, unknown>): string | undefined {
  const status = jiraFields(record)?.status;
  return (isObject(status) ? readFirstString(status, "name") : null) ?? undefined;
}

function jiraIssueAssignee(record: Record<string, unknown>): string | undefined {
  const assignee = jiraFields(record)?.assignee;
  return (isObject(assignee) ? readFirstString(assignee, "accountId", "account_id", "name") : null) ?? undefined;
}

function jiraIssueUpdatedAt(record: Record<string, unknown>): string | undefined {
  const fields = jiraFields(record);
  return (fields ? readFirstString(fields, "updated") : null) ?? readFirstString(record, "updated") ?? undefined;
}

function jiraCanonicalPath(objectType: JiraPlannerObjectType, id: string, record: Record<string, unknown>): string {
  if (objectType === "issue") {
    return `${JIRA_PATH_ROOT}/issues/${nameWithId(jiraIssueSummary(record), id)}.json`;
  }
  if (objectType === "project") {
    return `${JIRA_PATH_ROOT}/projects/${nameWithId(readFirstString(record, "name", "key") ?? undefined, id)}.json`;
  }
  return `${JIRA_PATH_ROOT}/sprints/${nameWithId(readFirstString(record, "name") ?? undefined, id)}.json`;
}

function jiraIndexPath(objectType: JiraPlannerObjectType): string {
  const resource = objectType === "issue" ? "issues" : objectType === "project" ? "projects" : "sprints";
  return `${JIRA_PATH_ROOT}/${resource}/_index.json`;
}

function jiraByIdAliasPath(objectType: JiraPlannerObjectType, id: string): string {
  const resource = objectType === "issue" ? "issues" : objectType === "project" ? "projects" : "sprints";
  return `${JIRA_PATH_ROOT}/${resource}/by-id/${encodeProviderSegment(id)}.json`;
}

function jiraIssueByKeyAliasPath(key: string): string {
  return `${JIRA_PATH_ROOT}/issues/by-key/${encodeProviderSegment(key)}.json`;
}

function jiraIssueByStateAliasPath(status: string, id: string): string {
  return `${JIRA_PATH_ROOT}/issues/by-state/${encodeProviderSegment(slugifyAlias(status))}/${encodeProviderSegment(id)}.json`;
}

function jiraIssueByAssigneeAliasPath(assignee: string, id: string): string {
  return `${JIRA_PATH_ROOT}/issues/by-assignee/${encodeProviderSegment(assignee)}/${encodeProviderSegment(id)}.json`;
}

function jiraIssueByEditedAliasPath(date: string, id: string): string {
  return `${JIRA_PATH_ROOT}/issues/by-edited/${encodeProviderSegment(date)}/${encodeProviderSegment(id)}.json`;
}

type JiraPriorState = {
  canonicalPath?: string;
  key?: string;
  status?: string;
  assignee?: string;
  editedDate?: string;
};

function jiraRecordAliasPaths(
  objectType: JiraPlannerObjectType,
  id: string,
  state: JiraPriorState,
): string[] {
  const paths = [
    state.canonicalPath,
    jiraByIdAliasPath(objectType, id),
  ];
  if (objectType === "issue") {
    paths.push(
      state.key ? jiraIssueByKeyAliasPath(state.key) : undefined,
      state.status ? jiraIssueByStateAliasPath(state.status, id) : undefined,
      state.assignee ? jiraIssueByAssigneeAliasPath(state.assignee, id) : undefined,
      state.editedDate ? jiraIssueByEditedAliasPath(state.editedDate, id) : undefined,
    );
  }
  return paths.filter((path): path is string => typeof path === "string" && path.length > 0);
}

function jiraIssueStateFromRecord(record: Record<string, unknown>): JiraPriorState {
  return {
    key: readFirstString(record, "key") ?? undefined,
    status: jiraIssueStatus(record),
    assignee: jiraIssueAssignee(record),
    editedDate: editedDateSegment(jiraIssueUpdatedAt(record)),
  };
}

function jiraPriorStateFromAlias(
  context: ProviderWritePlannerContext,
  alias: Record<string, unknown> | null,
): JiraPriorState | null {
  if (!alias) return null;
  const payload = isObject(alias.payload) ? alias.payload : null;
  const canonicalPath = readFirstString(alias, "path", "canonicalPath") ?? undefined;
  const canonical = canonicalPath ? readJsonObject(context, canonicalPath) : null;
  const record = payload ?? canonical;
  return {
    canonicalPath,
    ...(record ? jiraIssueStateFromRecord(record) : {}),
  };
}

function jiraIndexRow(objectType: JiraPlannerObjectType, id: string, record: Record<string, unknown>): Record<string, unknown> {
  if (objectType === "issue") {
    return {
      id,
      key: readFirstString(record, "key") ?? "",
      title: jiraIssueSummary(record) ?? id,
      status: jiraIssueStatus(record) ?? "",
      updated: jiraIssueUpdatedAt(record) ?? "",
    };
  }
  return {
    id,
    title: readFirstString(record, "name", "key") ?? id,
    updated: readFirstString(record, "updated", "updated_at", "startDate", "start_date") ?? "",
  };
}

function planJiraRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const objectType = normalizeJiraPlannerObjectType(job.model);
  const writes: PlannedRelayfileWrite[] = [];
  const applied: Record<string, unknown>[] = [];
  const removedIds = new Set<string>();
  const deletedPaths = new Set<string>();
  let written = 0;
  let deleted = 0;
  let skipped = 0;

  const pushDelete = (path: string) => {
    if (deletedPaths.has(path)) return;
    const write = deleteWriteIfExisting(path, context);
    if (!write) return;
    deletedPaths.add(path);
    writes.push(write);
  };

  for (const raw of records) {
    if (!isObject(raw)) {
      skipped += 1;
      continue;
    }
    const cleaned = stripNangoMetadata(raw);
    const id = readId(cleaned) || (objectType === "project" ? readId(cleaned, "key") : "");
    if (!id) {
      skipped += 1;
      continue;
    }
    const aliasPath = jiraByIdAliasPath(objectType, id);
    const previousAlias = readJsonObject(context, aliasPath);
    const previousIndexRow = readJsonArray(context, jiraIndexPath(objectType)).find((row) => readId(row) === id) ?? null;
    if (isStaleAgainstAny(raw, [previousAlias, previousIndexRow])) {
      skipped += 1;
      continue;
    }
    const canonicalPath = jiraCanonicalPath(objectType, id, cleaned);
    const prior = jiraPriorStateFromAlias(context, previousAlias);
    if (isDeletedNangoRecord(raw)) {
      for (const path of jiraRecordAliasPaths(
        objectType,
        id,
        prior ?? { canonicalPath },
      )) {
        pushDelete(path);
      }
      if (!prior?.canonicalPath) pushDelete(canonicalPath);
      removedIds.add(id);
      deleted += 1;
      continue;
    }
    if (prior) {
      const currentState = objectType === "issue"
        ? { canonicalPath, ...jiraIssueStateFromRecord(cleaned) }
        : { canonicalPath };
      for (const stalePath of diffPaths(
        jiraRecordAliasPaths(objectType, id, prior),
        jiraRecordAliasPaths(objectType, id, currentState),
      )) {
        pushDelete(stalePath);
      }
    }
    writes.push({
      path: canonicalPath,
      contents: JSON.stringify(cleaned),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
    applied.push(cleaned);
    written += 1;
  }

  if (applied.length > 0 || removedIds.size > 0) {
    writes.push({
      path: `${JIRA_PATH_ROOT}/_index.json`,
      contents: "[{\"id\":\"issues\",\"title\":\"Issues\"},{\"id\":\"projects\",\"title\":\"Projects\"},{\"id\":\"sprints\",\"title\":\"Sprints\"}]\n",
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
    for (const record of applied) {
      const id = readId(record) || readId(record, "key");
      const canonicalPath = jiraCanonicalPath(objectType, id, record);
      const wrapped = JSON.stringify({
        provider: "jira",
        objectType,
        objectId: id,
        payload: record,
        path: canonicalPath,
      });
      writes.push({
        path: jiraByIdAliasPath(objectType, id),
        contents: wrapped,
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
      if (objectType === "issue") {
        const key = readFirstString(record, "key");
        const status = jiraIssueStatus(record);
        const assignee = jiraIssueAssignee(record);
        const editedDate = editedDateSegment(jiraIssueUpdatedAt(record));
        for (const path of [
          key ? jiraIssueByKeyAliasPath(key) : null,
          status ? jiraIssueByStateAliasPath(status, id) : null,
          assignee ? jiraIssueByAssigneeAliasPath(assignee, id) : null,
          editedDate ? jiraIssueByEditedAliasPath(editedDate, id) : null,
        ]) {
          if (path) {
            writes.push({ path, contents: wrapped, contentType: JSON_CONTENT_TYPE, baseRevision: "*" });
          }
        }
      }
    }
    writes.push({
      path: jiraIndexPath(objectType),
      contents: sortedIndexContent(mergeIndexRows(
        readJsonArray(context, jiraIndexPath(objectType)),
        applied.map((record) => jiraIndexRow(objectType, readId(record) || readId(record, "key"), record)),
        removedIds,
      )),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }

  return { writes, written, deleted, skipped };
}

type GitLabPlannerObjectType =
  | "project"
  | "merge_requests"
  | "issues"
  | "commits"
  | "pipelines"
  | "pipeline_jobs"
  | "deployments"
  | "tags";

function normalizeGitLabPlannerObjectType(model: string): GitLabPlannerObjectType {
  const normalized = model.trim().toLowerCase();
  if (normalized === "gitlabproject" || normalized === "project") return "project";
  if (normalized === "gitlabmergerequest" || normalized === "mergerequest") return "merge_requests";
  if (normalized === "gitlabissue" || normalized === "issue") return "issues";
  if (normalized === "gitlabcommit" || normalized === "commit") return "commits";
  if (normalized === "gitlabpipeline" || normalized === "pipeline") return "pipelines";
  if (normalized === "gitlabpipelinejob" || normalized === "pipelinejob" || normalized === "job") return "pipeline_jobs";
  if (normalized === "gitlabdeployment" || normalized === "deployment") return "deployments";
  if (normalized === "gitlabtag" || normalized === "tag") return "tags";
  throw new Error(`Unsupported GitLab model: ${model}`);
}

function parseGitLabProjectPathFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/-/")[0]?.split("/").filter(Boolean) ?? [];
    return parts.length >= 2 ? parts.join("/") : null;
  } catch {
    return null;
  }
}

function readGitLabProjectPath(record: Record<string, unknown>): string | null {
  const direct = readFirstString(record, "project_path", "projectPath", "path_with_namespace");
  if (direct) return direct;
  const project = record.project;
  if (isObject(project)) {
    const nested = readFirstString(project, "path_with_namespace", "project_path", "projectPath");
    if (nested) return nested;
  }
  return parseGitLabProjectPathFromUrl(readFirstString(record, "web_url", "url"));
}

function gitLabProjectPrefix(projectPath: string): string {
  return `${GITLAB_PATH_ROOT}/projects/${projectPath.split("/").map(encodeProviderSegment).join("/")}`;
}

function gitLabResourcePathName(objectType: GitLabPlannerObjectType): string {
  return objectType === "pipeline_jobs" ? "jobs" : objectType;
}

function gitLabObjectId(objectType: GitLabPlannerObjectType, record: Record<string, unknown>): string | null {
  if (objectType === "commits") return readFirstString(record, "sha", "id");
  if (objectType === "tags") return readFirstString(record, "ref", "name") ?? readFirstString(record, "id")?.split(":").pop() ?? null;
  if (objectType === "pipeline_jobs") return readFirstString(record, "id", "job_id", "jobId");
  if (objectType === "pipelines" || objectType === "deployments") return readFirstString(record, "id", "iid");
  return readFirstString(record, "iid", "id");
}

function gitLabFlatRecordFilename(value: string): string {
  const id = value.trim().replace(/\.json$/u, "");
  const slug = slugifyAlias(id);
  return !slug || slug === "untitled" || slug === id
    ? encodeProviderSegment(id)
    : `${encodeProviderSegment(slug)}__${encodeProviderSegment(id)}`;
}

function gitLabNumberedFilename(id: string, title?: string): string {
  const slug = title ? slugifyAlias(title) : "";
  return slug ? `${encodeProviderSegment(id)}__${encodeProviderSegment(slug)}` : encodeProviderSegment(id);
}

function gitLabCanonicalPath(objectType: GitLabPlannerObjectType, record: Record<string, unknown>): string {
  const projectPath = readGitLabProjectPath(record);
  if (!projectPath) throw new Error("Missing GitLab project path context");
  if (objectType === "project") return `${gitLabProjectPrefix(projectPath)}/meta.json`;
  if (objectType === "tags") {
    const ref = gitLabObjectId(objectType, record);
    if (!ref) throw new Error("Missing GitLab tag ref");
    return `${gitLabProjectPrefix(projectPath)}/tags/${gitLabFlatRecordFilename(ref)}.json`;
  }
  if (objectType === "pipeline_jobs") {
    const pipelineId = readFirstString(record, "pipeline_id", "pipelineId");
    const jobId = gitLabObjectId(objectType, record);
    if (!pipelineId || !jobId) throw new Error("Missing GitLab pipeline job id context");
    const ref = readFirstString(record, "ref");
    const filename = ref ? `${gitLabFlatRecordFilename(ref)}__${encodeProviderSegment(jobId)}` : encodeProviderSegment(jobId);
    return `${gitLabProjectPrefix(projectPath)}/pipelines/${encodeProviderSegment(pipelineId)}/jobs/${filename}.json`;
  }
  const id = gitLabObjectId(objectType, record);
  if (!id) throw new Error(`Missing GitLab ${objectType} id`);
  const title =
    objectType === "commits"
      ? readFirstString(record, "title", "message") ?? id.slice(0, 12)
      : objectType === "pipelines"
        ? readFirstString(record, "ref", "title", "name")
        : readFirstString(record, "title", "name") ?? id;
  return `${gitLabProjectPrefix(projectPath)}/${gitLabResourcePathName(objectType)}/${gitLabNumberedFilename(id, title ?? undefined)}/meta.json`;
}

function gitLabIndexPath(objectType: GitLabPlannerObjectType, projectPath?: string): string {
  if (objectType === "project") return `${GITLAB_PATH_ROOT}/projects/_index.json`;
  if (!projectPath) throw new Error("Missing GitLab project path context");
  return `${gitLabProjectPrefix(projectPath)}/${gitLabResourcePathName(objectType)}/_index.json`;
}

function gitLabByIdAliasPath(objectType: GitLabPlannerObjectType, projectPath: string, id: string): string {
  if (objectType === "project") return `${GITLAB_PATH_ROOT}/projects/by-id/${encodeProviderSegment(id)}.json`;
  return `${gitLabProjectPrefix(projectPath)}/${gitLabResourcePathName(objectType)}/by-id/${encodeProviderSegment(id)}.json`;
}

function gitLabByRefAliasPath(objectType: GitLabPlannerObjectType, projectPath: string, ref: string, id: string): string {
  return `${gitLabProjectPrefix(projectPath)}/${gitLabResourcePathName(objectType)}/by-ref/${encodeProviderSegment(slugifyAlias(ref))}/${encodeProviderSegment(id)}.json`;
}

function gitLabByStatusAliasPath(objectType: GitLabPlannerObjectType, projectPath: string, status: string, id: string): string {
  return `${gitLabProjectPrefix(projectPath)}/${gitLabResourcePathName(objectType)}/by-status/${encodeProviderSegment(slugifyAlias(status))}/${encodeProviderSegment(id)}.json`;
}

function gitLabTagByRefAliasPath(projectPath: string, ref: string): string {
  return `${gitLabProjectPrefix(projectPath)}/tags/by-ref/${gitLabFlatRecordFilename(ref)}.json`;
}

type GitLabPriorState = {
  canonicalPath?: string;
  projectPath?: string;
  ref?: string;
  status?: string;
};

function gitLabStateFromRecord(
  objectType: GitLabPlannerObjectType,
  record: Record<string, unknown>,
): GitLabPriorState {
  return {
    projectPath: readGitLabProjectPath(record) ?? undefined,
    ref: objectType === "pipelines" || objectType === "tags"
      ? readFirstString(record, "ref") ?? undefined
      : undefined,
    status: objectType === "deployments"
      ? readFirstString(record, "status", "state") ?? undefined
      : undefined,
  };
}

function gitLabPriorStateFromAlias(
  context: ProviderWritePlannerContext,
  alias: Record<string, unknown> | null,
  objectType: GitLabPlannerObjectType,
): GitLabPriorState | null {
  if (!alias) return null;
  const canonicalPath = readFirstString(alias, "canonicalPath", "path") ?? undefined;
  const canonical = canonicalPath ? readJsonObject(context, canonicalPath) : null;
  return {
    canonicalPath,
    projectPath: readFirstString(alias, "projectPath", "path_with_namespace") ?? (canonical ? readGitLabProjectPath(canonical) ?? undefined : undefined),
    ref: readFirstString(alias, "ref") ?? (canonical ? gitLabStateFromRecord(objectType, canonical).ref : undefined),
    status: readFirstString(alias, "status", "state") ?? (canonical ? gitLabStateFromRecord(objectType, canonical).status : undefined),
  };
}

function gitLabRecordAliasPaths(
  objectType: GitLabPlannerObjectType,
  id: string,
  state: GitLabPriorState,
): string[] {
  const paths = [state.canonicalPath];
  if (state.projectPath) {
    paths.push(
      objectType === "tags"
        ? gitLabTagByRefAliasPath(state.projectPath, state.ref ?? id)
        : gitLabByIdAliasPath(objectType, state.projectPath, id),
    );
    if (objectType === "pipelines" && state.ref) {
      paths.push(gitLabByRefAliasPath(objectType, state.projectPath, state.ref, id));
    }
    if (objectType === "deployments" && state.status) {
      paths.push(gitLabByStatusAliasPath(objectType, state.projectPath, state.status, id));
    }
  }
  return paths.filter((path): path is string => typeof path === "string" && path.length > 0);
}

function gitLabTitle(record: Record<string, unknown>, fallback: string): string {
  return readFirstString(record, "title", "name", "ref", "message") ?? fallback;
}

function gitLabUpdated(record: Record<string, unknown>): string {
  return readFirstString(
    record,
    "updated_at",
    "updatedAt",
    "last_activity_at",
    "committed_date",
    "commit_date",
    "finished_at",
    "created_at",
  ) ?? "";
}

function gitLabIndexRow(
  objectType: GitLabPlannerObjectType,
  id: string,
  record: Record<string, unknown>,
  projectPath: string,
): Record<string, unknown> {
  if (objectType === "project") {
    return {
      id: projectPath,
      title: readFirstString(record, "name_with_namespace", "name", "path_with_namespace") ?? projectPath,
      updated: gitLabUpdated(record),
    };
  }
  return {
    id,
    title: gitLabTitle(record, id),
    updated: gitLabUpdated(record),
    ...(readFirstString(record, "iid") ? { iid: Number(readFirstString(record, "iid")) } : {}),
    ...(readFirstString(record, "state", "status") ? { state: readFirstString(record, "state", "status") } : {}),
  };
}

function planGitLabRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const objectType = normalizeGitLabPlannerObjectType(job.model);
  const writes: PlannedRelayfileWrite[] = [];
  const applied: Array<{ record: Record<string, unknown>; id: string; projectPath: string; canonicalPath: string }> = [];
  const deletedPaths = new Set<string>();
  const indexGroups = new Map<string, { upserts: Record<string, unknown>[]; removes: Set<string> }>();
  let written = 0;
  let deleted = 0;
  let skipped = 0;

  const pushDelete = (path: string) => {
    if (deletedPaths.has(path)) return;
    const write = deleteWriteIfExisting(path, context);
    if (!write) return;
    deletedPaths.add(path);
    writes.push(write);
  };

  const groupForIndex = (indexPath: string) => {
    let group = indexGroups.get(indexPath);
    if (!group) {
      group = { upserts: [], removes: new Set<string>() };
      indexGroups.set(indexPath, group);
    }
    return group;
  };

  for (const raw of records) {
    if (!isObject(raw)) {
      skipped += 1;
      continue;
    }
    const cleaned = stripNangoMetadata(raw);
    const id = objectType === "project" ? readId(cleaned) : gitLabObjectId(objectType, cleaned);
    if (!id) {
      skipped += 1;
      continue;
    }
    const recordProjectPath = readGitLabProjectPath(cleaned);
    const projectAliasPath = objectType === "project" ? gitLabByIdAliasPath(objectType, "", id) : null;
    const aliasPath = recordProjectPath
      ? objectType === "tags"
        ? gitLabTagByRefAliasPath(recordProjectPath, id)
        : gitLabByIdAliasPath(objectType, recordProjectPath, id)
      : projectAliasPath;
    if (!aliasPath) {
      skipped += 1;
      continue;
    }
    const previousAlias = readJsonObject(context, aliasPath);
    const prior = gitLabPriorStateFromAlias(context, previousAlias, objectType);
    const projectPath = recordProjectPath ?? prior?.projectPath;
    if (!projectPath) {
      skipped += 1;
      continue;
    }
    const canonicalPath = gitLabCanonicalPath(objectType, { ...cleaned, project_path: projectPath });
    const indexPath = gitLabIndexPath(objectType, projectPath);
    const previousIndexRow = readJsonArray(context, indexPath).find((row) => readId(row) === (objectType === "project" ? projectPath : id)) ?? null;
    if (isStaleAgainstAny(raw, [previousAlias, previousIndexRow])) {
      skipped += 1;
      continue;
    }
    if (isDeletedNangoRecord(raw)) {
      for (const path of gitLabRecordAliasPaths(
        objectType,
        id,
        prior ?? { ...gitLabStateFromRecord(objectType, cleaned), canonicalPath, projectPath },
      )) {
        pushDelete(path);
      }
      if (!prior?.canonicalPath) pushDelete(canonicalPath);
      groupForIndex(indexPath).removes.add(objectType === "project" ? projectPath : id);
      deleted += 1;
      continue;
    }
    if (prior) {
      const currentState = {
        ...gitLabStateFromRecord(objectType, cleaned),
        canonicalPath,
        projectPath,
      };
      for (const stalePath of diffPaths(
        gitLabRecordAliasPaths(objectType, id, prior),
        gitLabRecordAliasPaths(objectType, id, currentState),
      )) {
        pushDelete(stalePath);
      }
    }
    writes.push({
      path: canonicalPath,
      contents: JSON.stringify(cleaned),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
    applied.push({ record: cleaned, id, projectPath, canonicalPath });
    groupForIndex(indexPath).upserts.push(gitLabIndexRow(objectType, id, cleaned, projectPath));
    written += 1;
  }

  if (applied.length > 0 || indexGroups.size > 0) {
    writes.push({
      path: `${GITLAB_PATH_ROOT}/_index.json`,
      contents: "[{\"id\":\"projects\",\"title\":\"Projects\"}]\n",
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
    for (const { record, id, projectPath, canonicalPath } of applied) {
      const alias = {
        id,
        canonicalPath,
        projectPath,
        title: gitLabTitle(record, id),
      };
      if (objectType === "tags") {
        writes.push({
          path: gitLabTagByRefAliasPath(projectPath, id),
          contents: `${JSON.stringify({ ...alias, ref: id })}\n`,
          contentType: JSON_CONTENT_TYPE,
          baseRevision: "*",
        });
      } else {
        writes.push({
          path: gitLabByIdAliasPath(objectType, projectPath, id),
          contents: `${JSON.stringify(alias)}\n`,
          contentType: JSON_CONTENT_TYPE,
          baseRevision: "*",
        });
      }
      const ref = readFirstString(record, "ref");
      const status = readFirstString(record, "status", "state");
      if (objectType === "pipelines" && ref) {
        writes.push({
          path: gitLabByRefAliasPath(objectType, projectPath, ref, id),
          contents: `${JSON.stringify(alias)}\n`,
          contentType: JSON_CONTENT_TYPE,
          baseRevision: "*",
        });
      } else if (objectType === "deployments" && status) {
        writes.push({
          path: gitLabByStatusAliasPath(objectType, projectPath, status, id),
          contents: `${JSON.stringify(alias)}\n`,
          contentType: JSON_CONTENT_TYPE,
          baseRevision: "*",
        });
      }
    }
    for (const [indexPath, group] of indexGroups) {
      writes.push({
        path: indexPath,
        contents: sortedIndexContent(mergeIndexRows(
          readJsonArray(context, indexPath),
          group.upserts,
          group.removes,
        )),
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
    }
  }

  return { writes, written, deleted, skipped };
}

type GitHubObjectType = "repository" | "pull_request" | "issue" | "review" | "review_comment" | "check_run" | "commit";

const GITHUB_PATH_ROOT = "/github";
const GITHUB_REPOS_ROOT = `${GITHUB_PATH_ROOT}/repos`;

function encodeGitHubPathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("GitHub path segment must be a non-empty string");
  return encodeURIComponent(trimmed);
}

function githubNumberSlug(number: string, title?: string): string {
  const slug = title ? slugify(title) : "";
  return slug ? `${number}__${slug}` : number;
}

function githubRepoPrefix(owner: string, repo: string): string {
  return `${GITHUB_REPOS_ROOT}/${encodeGitHubPathSegment(owner)}/${encodeGitHubPathSegment(repo)}`;
}

function githubAliasRepoPrefix(owner: string, repo: string): string {
  return `${GITHUB_REPOS_ROOT}/${encodeGitHubPathSegment(`${owner}__${repo}`)}`;
}

function githubRootIndexPath(): string {
  return `${GITHUB_PATH_ROOT}/_index.json`;
}

function githubReposIndexPath(): string {
  return `${GITHUB_REPOS_ROOT}/_index.json`;
}

function githubRepositoryMetadataPath(owner: string, repo: string): string {
  return `${githubRepoPrefix(owner, repo)}/metadata.json`;
}

function githubRepositoryMetaPath(owner: string, repo: string): string {
  return `${githubRepoPrefix(owner, repo)}/meta.json`;
}

function githubIssuePath(owner: string, repo: string, number: string, title?: string): string {
  return `${githubRepoPrefix(owner, repo)}/issues/${githubNumberSlug(number, title)}/meta.json`;
}

function githubPullRequestPath(owner: string, repo: string, number: string, title?: string): string {
  return `${githubRepoPrefix(owner, repo)}/pulls/${githubNumberSlug(number, title)}/meta.json`;
}

function githubReviewPath(owner: string, repo: string, id: string): string {
  return `${githubRepoPrefix(owner, repo)}/reviews/${encodeGitHubPathSegment(id)}.json`;
}

function githubReviewCommentPath(owner: string, repo: string, id: string): string {
  return `${githubRepoPrefix(owner, repo)}/comments/${encodeGitHubPathSegment(id)}.json`;
}

function githubCheckRunPath(owner: string, repo: string, id: string): string {
  return `${githubRepoPrefix(owner, repo)}/checks/${encodeGitHubPathSegment(id)}.json`;
}

function githubCommitPath(owner: string, repo: string, sha: string): string {
  return `${githubRepoPrefix(owner, repo)}/commits/${encodeGitHubPathSegment(sha)}/metadata.json`;
}

function githubRepoIssuesIndexPath(owner: string, repo: string): string {
  return `${githubRepoPrefix(owner, repo)}/issues/_index.json`;
}

function githubRepoPullsIndexPath(owner: string, repo: string): string {
  return `${githubRepoPrefix(owner, repo)}/pulls/_index.json`;
}

function githubByIdAliasPath(owner: string, repo: string, kind: "issues" | "pulls", number: string): string {
  return `${githubAliasRepoPrefix(owner, repo)}/${kind}/by-id/${encodeGitHubPathSegment(number)}.json`;
}

function githubByTitleAliasPath(owner: string, repo: string, kind: "issues" | "pulls", title: string): string {
  return `${githubAliasRepoPrefix(owner, repo)}/${kind}/by-title/${encodeGitHubPathSegment(slugifyAlias(title))}.json`;
}

function githubNumberedByTitleAliasPath(owner: string, repo: string, kind: "issues" | "pulls", title: string, number: string): string {
  return `${githubAliasRepoPrefix(owner, repo)}/${kind}/by-title/${encodeGitHubPathSegment(`${slugifyAlias(title)}__${number}`)}.json`;
}

function githubByStateAliasPath(owner: string, repo: string, kind: "issues" | "pulls", state: string, number: string): string {
  return `${githubAliasRepoPrefix(owner, repo)}/${kind}/by-state/${encodeGitHubPathSegment(slugifyAlias(state))}/${encodeGitHubPathSegment(number)}.json`;
}

function githubByEditedAliasPath(owner: string, repo: string, kind: "issues" | "pulls", editedDate: string, number: string): string {
  return `${githubAliasRepoPrefix(owner, repo)}/${kind}/by-edited/${encodeGitHubPathSegment(editedDate)}/${encodeGitHubPathSegment(number)}.json`;
}

function normalizeGitHubObjectType(model: string): GitHubObjectType {
  switch (model.trim().toLowerCase()) {
    case "repo":
    case "repository":
      return "repository";
    case "pullrequest":
    case "pull_request":
    case "pull":
    case "pr":
      return "pull_request";
    case "issue":
      return "issue";
    case "review":
      return "review";
    case "reviewcomment":
    case "review_comment":
      return "review_comment";
    case "checkrun":
    case "check_run":
      return "check_run";
    case "commit":
      return "commit";
    default:
      throw new Error(`Unsupported GitHub object type: ${model}`);
  }
}

function parseGitHubRepoFromRecord(record: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = readFirstString(record, "owner");
  const repo = readFirstString(record, "repo");
  if (owner && repo) return { owner, repo };

  for (const candidate of [
    readFirstString(record, "full_name"),
    readFirstString(record, "url"),
    readFirstString(record, "html_url"),
  ]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname === "github.com") {
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] };
      }
    } catch {
      // Not a URL; try owner/repo text below.
    }
    const parts = candidate.split("/", 2);
    if (parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

function readGitHubNumber(record: Record<string, unknown>): string | null {
  const value = record.number ?? record.id;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^[0-9]+$/u.test(value.trim())) return value.trim();
  return null;
}

function githubCanonicalPath(
  objectType: GitHubObjectType,
  owner: string,
  repo: string,
  record: Record<string, unknown>,
): string {
  if (objectType === "repository") return githubRepositoryMetadataPath(owner, repo);
  if (objectType === "pull_request") {
    const number = readGitHubNumber(record);
    if (!number) throw new Error("Missing GitHub pull request number");
    return githubPullRequestPath(owner, repo, number, readFirstString(record, "title", "name") ?? undefined);
  }
  if (objectType === "issue") {
    const number = readGitHubNumber(record);
    if (!number) throw new Error("Missing GitHub issue number");
    return githubIssuePath(owner, repo, number, readFirstString(record, "title", "name") ?? undefined);
  }
  const id = objectType === "commit"
    ? readFirstString(record, "sha", "id")
    : readFirstString(record, "id");
  if (!id) throw new Error(`Missing GitHub ${objectType} id`);
  if (objectType === "review") return githubReviewPath(owner, repo, id);
  if (objectType === "review_comment") return githubReviewCommentPath(owner, repo, id);
  if (objectType === "check_run") return githubCheckRunPath(owner, repo, id);
  return githubCommitPath(owner, repo, id);
}

function githubRootIndexContent(): string {
  return "[{\"id\":\"repos\",\"title\":\"Repositories\"}]\n";
}

function githubRepoIndexRow(owner: string, repo: string, record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `${owner}/${repo}`,
    title: `${owner}/${repo}`,
    updated: readFirstString(record, "updated_at", "updatedAt", "pushed_at") ?? "",
  };
}

function githubRecordIndexRow(number: string, record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: number,
    title: readFirstString(record, "title") ?? number,
    updated: readFirstString(record, "updated_at", "updatedAt", "pushed_at") ?? "",
    number: Number(number),
    state: readFirstString(record, "state") ?? "",
  };
}

function githubSortedRepoIndexContent(rows: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify([...rows].sort((left, right) => {
    const updated = String(right.updated ?? "").localeCompare(String(left.updated ?? ""));
    return updated || String(left.id ?? "").localeCompare(String(right.id ?? ""));
  }))}\n`;
}

function githubSortedNumberedIndexContent(rows: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify([...rows].sort((left, right) => {
    const updated = String(right.updated ?? "").localeCompare(String(left.updated ?? ""));
    const leftNumber = typeof left.number === "number" ? left.number : Number(left.number ?? 0);
    const rightNumber = typeof right.number === "number" ? right.number : Number(right.number ?? 0);
    return updated || leftNumber - rightNumber || String(left.id ?? "").localeCompare(String(right.id ?? ""));
  }))}\n`;
}

function githubWrappedContent(
  objectType: GitHubObjectType,
  objectId: string,
  payload: Record<string, unknown>,
  job: NangoSyncJob,
): string {
  return JSON.stringify({
    provider: "github",
    objectType,
    objectId,
    deleted: false,
    payload,
    connectionId: job.connectionId,
  }, null, 2);
}

function extractPriorGitHubNumberedState(record: Record<string, unknown> | null): { title?: string; state?: string; editedDate?: string } | null {
  const payload = pickPayload(record);
  if (!payload) return null;
  return {
    title: readFirstString(payload, "title", "name") ?? undefined,
    state: readFirstString(payload, "state") ?? undefined,
    editedDate: extractDateSegment(payload),
  };
}

function githubNumberedPaths(args: {
  owner: string;
  repo: string;
  aliasKind: "issues" | "pulls";
  number: string;
  title?: string;
  state?: string;
  editedDate?: string;
}, options: { includeLegacyTitleAlias?: boolean } = {}): string[] {
  const paths = [
    args.aliasKind === "issues"
      ? githubIssuePath(args.owner, args.repo, args.number, args.title)
      : githubPullRequestPath(args.owner, args.repo, args.number, args.title),
    githubByIdAliasPath(args.owner, args.repo, args.aliasKind, args.number),
  ];
  if (args.title && slugifies(args.title)) {
    paths.push(githubNumberedByTitleAliasPath(args.owner, args.repo, args.aliasKind, args.title, args.number));
    if (options.includeLegacyTitleAlias) {
      paths.push(githubByTitleAliasPath(args.owner, args.repo, args.aliasKind, args.title));
    }
  }
  if (args.state && slugifies(args.state)) {
    paths.push(githubByStateAliasPath(args.owner, args.repo, args.aliasKind, args.state, args.number));
  }
  if (args.editedDate) {
    paths.push(githubByEditedAliasPath(args.owner, args.repo, args.aliasKind, args.editedDate, args.number));
  }
  return paths;
}

function planGitHubRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const objectType = normalizeGitHubObjectType(job.model);
  const writes: PlannedRelayfileWrite[] = [];
  const appliedRecords: Record<string, unknown>[] = [];
  const deletedRecords: Record<string, unknown>[] = [];
  const deletedPaths = new Set<string>();
  let written = 0;
  let deleted = 0;
  let skipped = 0;

  const pushDelete = (path: string) => {
    if (!readContextValue(context.existingFiles, path)) return;
    if (deletedPaths.has(path)) return;
    deletedPaths.add(path);
    writes.push(deleteWrite(path, context));
  };

  for (const raw of records) {
    const cleaned = stripNangoMetadata(raw);
    const repoInfo = parseGitHubRepoFromRecord(cleaned);
    if (!repoInfo) throw new Error("Missing GitHub repository context");
    const canonicalPath = githubCanonicalPath(objectType, repoInfo.owner, repoInfo.repo, cleaned);
    const number = objectType === "issue" || objectType === "pull_request" ? readGitHubNumber(cleaned) : null;
    const aliasKind = objectType === "issue" ? "issues" : objectType === "pull_request" ? "pulls" : null;
    const staleAlias = number && aliasKind ? githubByIdAliasPath(repoInfo.owner, repoInfo.repo, aliasKind, number) : null;
    if (isStaleAgainstAny(raw, [
      readJsonObject(context, canonicalPath),
      ...(staleAlias ? [readJsonObject(context, staleAlias)] : []),
    ])) {
      skipped += 1;
      continue;
    }

    if (isDeletedNangoRecord(raw)) {
      pushDelete(canonicalPath);
      deletedRecords.push(cleaned);
      deleted += 1;
      continue;
    }

    writes.push({
      path: canonicalPath,
      contents: JSON.stringify(cleaned),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
    appliedRecords.push(cleaned);
    written += 1;
  }

  if (appliedRecords.length === 0 && deletedRecords.length === 0) {
    return { writes, written, deleted, skipped };
  }

  writes.push({
    path: githubRootIndexPath(),
    contents: githubRootIndexContent(),
    contentType: JSON_CONTENT_TYPE,
    baseRevision: "*",
  });

  if (objectType === "repository") {
    const removedIds = new Set<string>();
    const upserts: Record<string, unknown>[] = [];
    for (const record of appliedRecords) {
      const repoInfo = parseGitHubRepoFromRecord(record);
      if (!repoInfo) continue;
      writes.push({
        path: githubRepositoryMetaPath(repoInfo.owner, repoInfo.repo),
        contents: githubWrappedContent("repository", `${repoInfo.owner}/${repoInfo.repo}`, record, job),
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
      upserts.push(githubRepoIndexRow(repoInfo.owner, repoInfo.repo, record));
    }
    for (const record of deletedRecords) {
      const repoInfo = parseGitHubRepoFromRecord(record);
      const id = repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : readFirstString(record, "id");
      if (id) removedIds.add(id);
      if (repoInfo) {
        pushDelete(githubRepositoryMetaPath(repoInfo.owner, repoInfo.repo));
        pushDelete(githubRepositoryMetadataPath(repoInfo.owner, repoInfo.repo));
      }
    }
    writes.push({
      path: githubReposIndexPath(),
      contents: githubSortedRepoIndexContent(mergeIndexRows(
        readJsonArray(context, githubReposIndexPath()),
        upserts,
        removedIds,
      )),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }

  if ((objectType === "issue" || objectType === "pull_request")) {
    const aliasKind = objectType === "issue" ? "issues" : "pulls";
    const indexGroups = new Map<string, {
      owner: string;
      repo: string;
      upserts: Record<string, unknown>[];
      removes: Set<string>;
      path: string;
    }>();
    const groupFor = (owner: string, repo: string) => {
      const key = `${owner}/${repo}`;
      let group = indexGroups.get(key);
      if (!group) {
        group = {
          owner,
          repo,
          upserts: [],
          removes: new Set<string>(),
          path: objectType === "issue"
            ? githubRepoIssuesIndexPath(owner, repo)
            : githubRepoPullsIndexPath(owner, repo),
        };
        indexGroups.set(key, group);
      }
      return group;
    };

    for (const record of appliedRecords) {
      const repoInfo = parseGitHubRepoFromRecord(record);
      const number = readGitHubNumber(record);
      if (!repoInfo || !number) continue;
      const title = readFirstString(record, "title") ?? undefined;
      const state = readFirstString(record, "state") ?? undefined;
      const editedDate = extractDateSegment(record);
      const prior = extractPriorGitHubNumberedState(readJsonObject(context, githubByIdAliasPath(repoInfo.owner, repoInfo.repo, aliasKind, number)));
      if (prior) {
        for (const stalePath of diffPaths(
          githubNumberedPaths({ owner: repoInfo.owner, repo: repoInfo.repo, aliasKind, number, ...prior }, { includeLegacyTitleAlias: true }),
          githubNumberedPaths({ owner: repoInfo.owner, repo: repoInfo.repo, aliasKind, number, title, state, editedDate }),
        )) {
          pushDelete(stalePath);
        }
      }
      const content = githubWrappedContent(objectType, number, record, job);
      for (const path of githubNumberedPaths({ owner: repoInfo.owner, repo: repoInfo.repo, aliasKind, number, title, state, editedDate })) {
        writes.push({ path, contents: content, contentType: JSON_CONTENT_TYPE, baseRevision: "*" });
      }
      groupFor(repoInfo.owner, repoInfo.repo).upserts.push(githubRecordIndexRow(number, record));
    }

    for (const record of deletedRecords) {
      const repoInfo = parseGitHubRepoFromRecord(record);
      const number = readGitHubNumber(record);
      if (!repoInfo || !number) continue;
      const byId = githubByIdAliasPath(repoInfo.owner, repoInfo.repo, aliasKind, number);
      const prior = extractPriorGitHubNumberedState(readJsonObject(context, byId));
      for (const path of githubNumberedPaths(
        { owner: repoInfo.owner, repo: repoInfo.repo, aliasKind, number, ...(prior ?? {}) },
        { includeLegacyTitleAlias: true },
      )) {
        pushDelete(path);
      }
      groupFor(repoInfo.owner, repoInfo.repo).removes.add(number);
    }

    for (const group of indexGroups.values()) {
      writes.push({
        path: group.path,
        contents: githubSortedNumberedIndexContent(mergeIndexRows(
          readJsonArray(context, group.path),
          group.upserts,
          group.removes,
        )),
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
    }
  }

  return { writes, written, deleted, skipped };
}

type LinearObjectType =
  | "issue"
  | "comment"
  | "label"
  | "user"
  | "team"
  | "project"
  | "cycle"
  | "milestone"
  | "roadmap";

const LINEAR_PATH_ROOT = "/linear";
const LINEAR_PUBLIC_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/u;
const LINEAR_CANONICAL_STATE_SLUGS: Record<string, string> = {
  Todo: "todo",
  "In Progress": "in-progress",
  Done: "done",
  Backlog: "backlog",
  Canceled: "canceled",
};

function encodeLinearPathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Linear path segment must be a non-empty string");
  return encodeURIComponent(trimmed);
}

function normalizeLinearHumanReadable(value: string | undefined): string {
  if (!value) return "";
  return LINEAR_PUBLIC_IDENTIFIER_PATTERN.test(value) ? value : slugify(value);
}

function linearNameWithId(humanReadable: string | undefined, id: string): string {
  const normalizedHumanReadable = normalizeLinearHumanReadable(humanReadable);
  return normalizedHumanReadable
    ? `${normalizedHumanReadable}__${encodeLinearPathSegment(id)}`
    : encodeLinearPathSegment(id);
}

function normalizeLinearObjectType(model: string): LinearObjectType {
  switch (model.trim().toLowerCase()) {
    case "linearissue":
    case "issue":
      return "issue";
    case "linearcomment":
    case "comment":
      return "comment";
    case "linearlabel":
    case "label":
      return "label";
    case "linearuser":
    case "user":
      return "user";
    case "linearteam":
    case "team":
      return "team";
    case "linearproject":
    case "project":
      return "project";
    case "linearcycle":
    case "cycle":
      return "cycle";
    case "linearmilestone":
    case "milestone":
    case "projectmilestone":
      return "milestone";
    case "linearroadmap":
    case "roadmap":
      return "roadmap";
    default:
      throw new Error(`Unsupported Linear object type: ${model}`);
  }
}

function linearRootIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/_index.json`;
}

function linearIssuesIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/issues/_index.json`;
}

function linearCommentsIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/comments/_index.json`;
}

function linearLabelsIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/labels/_index.json`;
}

function linearUsersIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/users/_index.json`;
}

function linearTeamsIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/teams/_index.json`;
}

function linearProjectsIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/projects/_index.json`;
}

function linearProjectPath(id: string): string {
  return `${LINEAR_PATH_ROOT}/projects/${encodeLinearPathSegment(id)}/meta.json`;
}

function linearCyclesIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/cycles/_index.json`;
}

function linearMilestonesIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/milestones/_index.json`;
}

function linearRoadmapsIndexPath(): string {
  return `${LINEAR_PATH_ROOT}/roadmaps/_index.json`;
}

function linearIssuePath(id: string, humanReadable?: string): string {
  return `${LINEAR_PATH_ROOT}/issues/${linearNameWithId(humanReadable, id)}.json`;
}

function linearCommentPath(id: string, humanReadable?: string): string {
  return `${LINEAR_PATH_ROOT}/comments/${linearNameWithId(humanReadable, id)}/meta.json`;
}

function linearCanonicalPath(objectType: LinearObjectType, id: string, humanReadable?: string): string {
  if (objectType === "issue") return linearIssuePath(id, humanReadable);
  if (objectType === "comment") return linearCommentPath(id, humanReadable);
  if (objectType === "project") return linearProjectPath(id);
  return `${LINEAR_PATH_ROOT}/${objectType === "user" ? "users" : `${objectType}s`}/${encodeLinearPathSegment(id)}.json`;
}

function linearByUuidAliasPath(id: string): string {
  return `${LINEAR_PATH_ROOT}/issues/by-uuid/${encodeLinearPathSegment(id)}.json`;
}

function linearByIdAliasPath(identifier: string): string {
  return `${LINEAR_PATH_ROOT}/issues/by-id/${encodeLinearPathSegment(identifier)}.json`;
}

function linearByTitleAliasPath(title: string, id: string): string {
  void id;
  return `${LINEAR_PATH_ROOT}/issues/by-title/${encodeLinearPathSegment(slugifyAlias(title))}.json`;
}

function linearScopedByIdAliasPath(scope: string, id: string): string {
  return `${scope}/by-id/${encodeLinearPathSegment(id)}.json`;
}

function linearScopedByNameAliasPath(scope: string, name: string): string {
  return `${scope}/by-name/${encodeLinearPathSegment(slugifyAlias(name))}.json`;
}

function linearStateSlug(stateName: string): string {
  const canonical = LINEAR_CANONICAL_STATE_SLUGS[stateName.trim()];
  if (canonical) return canonical;
  let slug = "";
  let previousWasSeparator = false;
  for (const character of stateName.trim().normalize("NFC").toLowerCase()) {
    if (/\s/u.test(character)) {
      if (!previousWasSeparator && slug.length > 0) slug += "-";
      previousWasSeparator = true;
      continue;
    }
    previousWasSeparator = false;
    if (/[a-z0-9]/u.test(character)) {
      slug += character;
      continue;
    }
    if (character === "-") {
      slug += "%2D";
      continue;
    }
    slug += encodeURIComponent(character);
  }
  if (!slug) throw new Error("Linear state slug must be a non-empty string");
  return slug;
}

function linearIssueByStatePath(stateName: string, identifier: string): string {
  return `${LINEAR_PATH_ROOT}/issues/by-state/${linearStateSlug(stateName)}/${encodeLinearPathSegment(identifier)}.json`;
}

function linearProjectByStatePath(stateName: string, id: string): string {
  return `${LINEAR_PATH_ROOT}/projects/by-state/${linearStateSlug(stateName)}/${encodeLinearPathSegment(id)}.json`;
}

function linearProjectByTeamPath(teamId: string, id: string): string {
  return `${LINEAR_PATH_ROOT}/projects/by-team/${encodeLinearPathSegment(teamId)}/${encodeLinearPathSegment(id)}.json`;
}

function linearLabelByTeamPath(teamId: string, id: string): string {
  return `${LINEAR_PATH_ROOT}/labels/by-team/${encodeLinearPathSegment(teamId)}/${encodeLinearPathSegment(id)}.json`;
}

function linearIssueByEditedPath(editedDate: string, id: string): string {
  return `${LINEAR_PATH_ROOT}/issues/by-edited/${encodeLinearPathSegment(editedDate)}/${encodeLinearPathSegment(id)}.json`;
}

function linearRootIndexContent(): string {
  return "[{\"id\":\"issues\",\"title\":\"Issues\"},{\"id\":\"comments\",\"title\":\"Comments\"},{\"id\":\"labels\",\"title\":\"Labels\"},{\"id\":\"teams\",\"title\":\"Teams\"},{\"id\":\"users\",\"title\":\"Users\"},{\"id\":\"projects\",\"title\":\"Projects\"},{\"id\":\"states\",\"title\":\"Workflow States\"},{\"id\":\"cycles\",\"title\":\"Cycles\"},{\"id\":\"milestones\",\"title\":\"Milestones\"},{\"id\":\"roadmaps\",\"title\":\"Roadmaps\"}]\n";
}

function linearReadStateName(record: Record<string, unknown>): string | undefined {
  const state = isObject(record.state) ? record.state : null;
  return state ? readFirstString(state, "name") ?? readFirstString(record, "state_name", "state_type") ?? undefined : readFirstString(record, "state_name", "state_type") ?? undefined;
}

function linearIssueHumanReadable(record: Record<string, unknown>): string | undefined {
  return readFirstString(record, "identifier", "title") ?? undefined;
}

function linearCommentHumanReadable(record: Record<string, unknown>): string | undefined {
  return readFirstString(record, "issue_identifier", "body") ?? undefined;
}

function linearCommentIssueHumanReadable(record: Record<string, unknown>): string | undefined {
  const issue = isObject(record.issue) ? record.issue : null;
  return readFirstString(record, "issue_identifier")
    ?? (issue ? readFirstString(issue, "identifier", "title") : null)
    ?? readFirstString(record, "body")
    ?? undefined;
}

function linearWrappedContent(
  objectType: LinearObjectType,
  objectId: string,
  payload: Record<string, unknown>,
  job: NangoSyncJob,
): string {
  return JSON.stringify({
    provider: "linear",
    objectType,
    objectId,
    deleted: false,
    payload,
    connectionId: job.connectionId,
  }, null, 2);
}

function linearIssuePaths(id: string, state: { identifier?: string; title?: string; stateName?: string; editedDate?: string }): string[] {
  const paths = [linearIssuePath(id, state.identifier ?? state.title), linearByUuidAliasPath(id)];
  if (state.identifier) paths.push(linearByIdAliasPath(state.identifier));
  if (state.title && slugifies(state.title)) paths.push(linearByTitleAliasPath(state.title, id));
  if (state.stateName && state.identifier) paths.push(linearIssueByStatePath(state.stateName, state.identifier));
  if (state.editedDate) paths.push(linearIssueByEditedPath(state.editedDate, id));
  return paths;
}

function extractPriorLinearIssueState(record: Record<string, unknown> | null): { identifier?: string; title?: string; stateName?: string; editedDate?: string } | null {
  const payload = pickPayload(record);
  if (!payload) return null;
  return {
    identifier: readFirstString(payload, "identifier") ?? undefined,
    title: readFirstString(payload, "title") ?? undefined,
    stateName: linearReadStateName(payload),
    editedDate: extractDateSegment(payload),
  };
}

function linearIndexPath(objectType: LinearObjectType): string {
  if (objectType === "issue") return linearIssuesIndexPath();
  if (objectType === "comment") return linearCommentsIndexPath();
  if (objectType === "label") return linearLabelsIndexPath();
  if (objectType === "user") return linearUsersIndexPath();
  if (objectType === "team") return linearTeamsIndexPath();
  if (objectType === "project") return linearProjectsIndexPath();
  if (objectType === "cycle") return linearCyclesIndexPath();
  if (objectType === "milestone") return linearMilestonesIndexPath();
  return linearRoadmapsIndexPath();
}

function linearAliasPaths(objectType: LinearObjectType, record: Record<string, unknown>): string[] {
  const id = readId(record);
  if (!id) return [];
  if (objectType === "team") {
    const name = readFirstString(record, "name", "key");
    return [
      linearScopedByIdAliasPath(`${LINEAR_PATH_ROOT}/teams`, id),
      ...(name && slugifies(name) ? [linearScopedByNameAliasPath(`${LINEAR_PATH_ROOT}/teams`, name)] : []),
    ];
  }
  if (objectType === "project") {
    const name = readFirstString(record, "name");
    const state = readFirstString(record, "state");
    return [
      linearScopedByIdAliasPath(`${LINEAR_PATH_ROOT}/projects`, id),
      ...(name && slugifies(name) ? [linearScopedByNameAliasPath(`${LINEAR_PATH_ROOT}/projects`, name)] : []),
      ...(state && slugifies(state) ? [linearProjectByStatePath(state, id)] : []),
      ...linearProjectTeamIds(record).map((teamId) => linearProjectByTeamPath(teamId, id)),
    ];
  }
  if (objectType === "label") {
    const name = readFirstString(record, "name");
    const teamId = linearLabelTeamId(record);
    return [
      linearScopedByIdAliasPath(`${LINEAR_PATH_ROOT}/labels`, id),
      ...(name && slugifies(name)
        ? [linearScopedByNameAliasPath(`${LINEAR_PATH_ROOT}/labels`, name)]
        : []),
      ...(teamId ? [linearLabelByTeamPath(teamId, id)] : []),
    ];
  }
  return [];
}

function linearProjectTeamIds(record: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const teamId of readStringArray(record.team_ids)) {
    ids.add(teamId);
  }
  const teams = record.teams;
  if (Array.isArray(teams)) {
    for (const team of teams) {
      if (!isObject(team)) continue;
      const teamId = readFirstString(team, "id");
      if (teamId) ids.add(teamId);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function linearLabelTeamId(record: Record<string, unknown>): string | undefined {
  const team = isObject(record["team"]) ? record["team"] : null;
  return (
    (team ? readFirstString(team, "id") : null) ??
    readFirstString(record, "team_id") ??
    undefined
  );
}

function linearIndexRow(objectType: LinearObjectType, record: Record<string, unknown>): Record<string, unknown> {
  const updated = readFirstString(record, "updatedAt", "updated_at", "createdAt", "created_at") ?? "";
  if (objectType === "issue") {
    return {
      id: readId(record),
      title: readFirstString(record, "title") ?? "",
      updated,
      identifier: readFirstString(record, "identifier") ?? "",
      state: linearReadStateName(record) ?? "",
    };
  }
  if (objectType === "comment") {
    const issue = isObject(record.issue) ? record.issue : null;
    return {
      id: readId(record),
      title: readFirstString(record, "body") ?? (issue ? readFirstString(issue, "title") : null) ?? "",
      updated,
    };
  }
  if (objectType === "user") {
    return {
      id: readId(record),
      title: readFirstString(record, "displayName", "display_name", "name", "email") ?? "",
      updated,
    };
  }
  if (objectType === "team") {
    return {
      id: readId(record),
      title: readFirstString(record, "name", "key") ?? "",
      updated,
    };
  }
  if (objectType === "cycle") {
    return {
      id: readId(record),
      title: readFirstString(record, "name") ?? (typeof record.number === "number" ? String(record.number) : ""),
      updated: readFirstString(record, "updatedAt", "updated_at", "createdAt", "created_at", "startsAt", "endsAt") ?? "",
    };
  }
  return {
    id: readId(record),
    title: readFirstString(record, "name") ?? "",
    updated,
  };
}

function buildLinearSyncSemanticsLocal(
  objectType: LinearObjectType,
  objectId: string,
  record: Record<string, unknown>,
  job: NangoSyncJob,
): PlannedRelayfileSemantics {
  const properties: Record<string, string> = {
    provider: "linear",
    "provider.object_id": objectId,
    "provider.object_type": objectType,
    "linear.id": objectId,
    "linear.object_type": objectType,
    "nango.connection_id": job.connectionId,
    "nango.model": job.model,
    "nango.provider_config_key": job.providerConfigKey,
    "nango.sync_name": job.syncName,
  };
  const add = (key: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0) properties[key] = value;
    if (typeof value === "number" && Number.isFinite(value)) properties[key] = String(value);
    if (typeof value === "boolean") properties[key] = String(value);
  };
  add("linear.url", record.url);
  if (objectType === "issue") {
    add("linear.identifier", record.identifier);
    add("linear.title", record.title);
    add("linear.created_at", record.createdAt ?? record.created_at);
    add("linear.updated_at", record.updatedAt ?? record.updated_at);
    add("linear.completed_at", record.completedAt ?? record.completed_at);
    add("linear.canceled_at", record.canceledAt ?? record.canceled_at);
    add("linear.state_name", linearReadStateName(record));
  } else if (objectType === "comment") {
    add("linear.created_at", record.createdAt ?? record.created_at);
    add("linear.updated_at", record.updatedAt ?? record.updated_at);
    add("linear.comment_length", typeof record.body === "string" ? record.body.length : undefined);
    const issue = isObject(record.issue) ? record.issue : null;
    add("linear.issue_id", issue?.id ?? record.issue_id);
    add("linear.issue_identifier", issue?.identifier ?? record.issue_identifier);
    add("linear.issue_title", issue?.title ?? record.issue_title);
    return {
      properties,
      comments: typeof record.body === "string" && record.body.length > 0 ? [record.body] : undefined,
      relations: issue?.id
        ? [linearIssuePath(
          String(issue.id),
          readFirstString(issue, "identifier", "title") ?? undefined,
        )]
        : undefined,
    };
  } else {
    if (objectType === "project") {
      add("linear.name", record.name);
      add("linear.state", record.state);
      add("linear.description", record.description);
      add("linear.target_date", record.targetDate ?? record.target_date);
      add("linear.started_at", record.startedAt ?? record.started_at);
      add("linear.completed_at", record.completedAt ?? record.completed_at);
      add("linear.created_at", record.createdAt ?? record.created_at);
      add("linear.updated_at", record.updatedAt ?? record.updated_at);
      add("linear.progress", record.progress);
      const teamIds = linearProjectTeamIds(record);
      if (teamIds.length > 0) {
        add("linear.team_ids", teamIds.join(","));
        add("linear.team_count", teamIds.length);
        return {
          properties,
          relations: teamIds.map((teamId) => linearCanonicalPath("team", teamId)),
        };
      }
    } else if (objectType === "label") {
      add("linear.name", record.name);
      add("linear.description", record.description);
      add("linear.color", record.color);
      add("linear.created_at", record.createdAt ?? record.created_at);
      add("linear.updated_at", record.updatedAt ?? record.updated_at);
      const team = isObject(record.team) ? record.team : null;
      const teamId = linearLabelTeamId(record);
      const parent = isObject(record.parent) ? record.parent : null;
      const parentId =
        (parent ? readFirstString(parent, "id") : null) ??
        readFirstString(record, "parentId", "parent_id");
      add("linear.team_id", teamId);
      add(
        "linear.team_name",
        (team ? readFirstString(team, "name") : null) ?? record.team_name,
      );
      add("linear.parent_id", parentId);
      add("linear.parent_name", parent ? readFirstString(parent, "name") : null);
      const relations = [
        ...(teamId ? [linearCanonicalPath("team", teamId)] : []),
        ...(parentId ? [linearCanonicalPath("label", parentId)] : []),
      ];
      if (relations.length > 0) {
        return { properties, relations };
      }
    } else if (objectType === "cycle") {
      add("linear.number", record.number);
      add("linear.name", record.name);
      add("linear.starts_at", record.startsAt);
      add("linear.ends_at", record.endsAt);
      add("linear.completed_at", record.completedAt);
    } else if (objectType === "team") {
      add("linear.name", record.name);
      add("linear.key", record.key);
      add("linear.description", record.description);
      add("linear.created_at", record.createdAt ?? record.created_at);
      add("linear.updated_at", record.updatedAt ?? record.updated_at);
    } else if (objectType === "user") {
      add("linear.name", record.name);
      add("linear.display_name", record.displayName ?? record.display_name);
      add("linear.first_name", record.firstName ?? record.first_name);
      add("linear.last_name", record.lastName ?? record.last_name);
      add("linear.email", record.email);
      add("linear.admin", record.admin);
      add("linear.avatar_url", record.avatarUrl ?? record.avatar_url);
      add("linear.updated_at", record.updatedAt ?? record.updated_at);
    } else if (objectType === "milestone") {
      add("linear.name", record.name);
      add("linear.status", record.status);
      add("linear.description", record.description);
      add("linear.created_at", record.createdAt ?? record.created_at);
      add("linear.updated_at", record.updatedAt ?? record.updated_at);
      add("linear.progress", record.progress);
      const project = isObject(record.project) ? record.project : null;
      add("linear.project_id", project?.id ?? record.project_id);
      add("linear.project_name", project?.name ?? record.project_name);
    } else if (objectType === "roadmap") {
      add("linear.name", record.name);
      add("linear.description", record.description);
      add("linear.created_at", record.createdAt ?? record.created_at);
      add("linear.updated_at", record.updatedAt ?? record.updated_at);
    }
  }
  return { properties };
}

function planLinearRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const objectType = normalizeLinearObjectType(job.model);
  const writes: PlannedRelayfileWrite[] = [];
  const appliedRecords: Record<string, unknown>[] = [];
  const removedIds = new Set<string>();
  const deletedPaths = new Set<string>();
  let written = 0;
  let deleted = 0;
  let skipped = 0;

  const pushDelete = (path: string) => {
    if (!readContextValue(context.existingFiles, path)) return;
    if (deletedPaths.has(path)) return;
    deletedPaths.add(path);
    writes.push(deleteWrite(path, context));
  };

  for (const raw of records) {
    const cleaned = stripNangoMetadata(raw);
    const id = readId(cleaned);
    if (!id) throw new Error("Missing Linear record id");
    const humanReadable = objectType === "issue"
      ? linearIssueHumanReadable(cleaned)
      : objectType === "comment"
        ? linearCommentHumanReadable(cleaned)
        : undefined;
    const canonicalPath = linearCanonicalPath(objectType, id, humanReadable);
    const staleRecords = [
      readJsonObject(context, canonicalPath),
      ...(objectType === "issue" ? [readJsonObject(context, linearByUuidAliasPath(id))] : []),
      ...(objectType === "comment"
        ? [readJsonArray(context, linearCommentsIndexPath()).find((row) => readId(row) === id) ?? null]
        : []),
    ];
    if (isStaleAgainstAny(raw, staleRecords)) {
      skipped += 1;
      continue;
    }
    if (isDeletedNangoRecord(raw)) {
      pushDelete(canonicalPath);
      removedIds.add(id);
      deleted += 1;
      continue;
    }
    writes.push({
      path: canonicalPath,
      contents: JSON.stringify(cleaned),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
      semantics: buildLinearSyncSemanticsLocal(objectType, id, cleaned, job),
    });
    appliedRecords.push(cleaned);
    written += 1;
  }

  if (appliedRecords.length === 0 && removedIds.size === 0) {
    return { writes, written, deleted, skipped };
  }

  writes.push({
    path: linearRootIndexPath(),
    contents: linearRootIndexContent(),
    contentType: JSON_CONTENT_TYPE,
    baseRevision: "*",
  });

  if (objectType === "issue") {
    for (const issue of appliedRecords) {
      const id = readId(issue);
      const state = {
        identifier: readFirstString(issue, "identifier") ?? undefined,
        title: readFirstString(issue, "title") ?? undefined,
        stateName: linearReadStateName(issue),
        editedDate: extractDateSegment(issue),
      };
      const prior = extractPriorLinearIssueState(readJsonObject(context, linearByUuidAliasPath(id)));
      const nextPaths = linearIssuePaths(id, state);
      if (prior) {
        for (const stalePath of diffPaths(linearIssuePaths(id, prior), nextPaths)) {
          pushDelete(stalePath);
        }
      }
      const content = linearWrappedContent("issue", id, issue, job);
      for (const path of nextPaths) {
        writes.push({ path, contents: content, contentType: JSON_CONTENT_TYPE, baseRevision: "*" });
      }
    }
    for (const id of removedIds) {
      const prior = extractPriorLinearIssueState(readJsonObject(context, linearByUuidAliasPath(id)));
      for (const path of linearIssuePaths(id, prior ?? {})) {
        pushDelete(path);
      }
    }
  } else {
    for (const record of appliedRecords) {
      const id = readId(record);
      const content = linearWrappedContent(objectType, id, record, job);
      for (const path of [
        linearCanonicalPath(objectType, id, objectType === "comment" ? linearCommentIssueHumanReadable(record) : undefined),
        ...linearAliasPaths(objectType, record),
      ]) {
        writes.push({
          path,
          contents: content,
          contentType: JSON_CONTENT_TYPE,
          baseRevision: "*",
        });
      }
    }
    for (const id of removedIds) {
      pushDelete(linearCanonicalPath(objectType, id));
    }
  }

  const indexPath = linearIndexPath(objectType);
  writes.push({
    path: indexPath,
    contents: sortedIndexContent(mergeIndexRows(
      readJsonArray(context, indexPath),
      appliedRecords.map((record) => linearIndexRow(objectType, record)),
      removedIds,
    )),
    contentType: JSON_CONTENT_TYPE,
    baseRevision: "*",
  });

  return { writes, written, deleted, skipped };
}

type NotionObjectType = "page" | "page_content" | "database" | "user";

const NOTION_PATH_ROOT = "/notion";
const NOTION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTION_BARE_HEX_PATTERN = /^[0-9a-f]{32}$/i;

function normalizeNotionObjectType(model: string): NotionObjectType {
  if (model === "NotionPageContent") return "page_content";
  if (model === "NotionUser" || model.trim().toLowerCase() === "notionuser") return "user";
  if (model === "NotionPage") return "page";
  if (model === "NotionDatabase") return "database";
  throw new Error(`Unsupported Notion object type: ${model}`);
}

function encodeNotionPathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Notion path segment must be a non-empty string");
  }
  return encodeURIComponent(trimmed);
}

function notionAliasShortId(id: string): string {
  if (NOTION_UUID_PATTERN.test(id)) {
    return id.replace(/-/g, "").toLowerCase().slice(-8);
  }
  if (NOTION_BARE_HEX_PATTERN.test(id)) {
    return id.toLowerCase().slice(-8);
  }
  return aliasCollisionSuffix(id);
}

function notionNameWithId(humanReadable: string | undefined, id: string): string {
  return nameWithId(humanReadable, id);
}

function notionAliasFilename(label: string, id: string): string {
  const slug = slugifyAlias(label);
  if (slug === "untitled") {
    throw new Error("Notion alias label must slug to a non-empty string");
  }
  return `${slug}__${notionAliasShortId(id)}`;
}

function notionRootIndexPath(): string {
  return `${NOTION_PATH_ROOT}/_index.json`;
}

function notionPagesIndexPath(): string {
  return `${NOTION_PATH_ROOT}/pages/_index.json`;
}

function notionDatabasesIndexPath(): string {
  return `${NOTION_PATH_ROOT}/databases/_index.json`;
}

function notionUsersIndexPath(): string {
  return `${NOTION_PATH_ROOT}/users/_index.json`;
}

function notionStandalonePagePath(pageId: string, title?: string): string {
  return `${NOTION_PATH_ROOT}/pages/${notionNameWithId(title, pageId)}/meta.json`;
}

function notionStandalonePageContentPath(pageId: string, title?: string): string {
  return `${NOTION_PATH_ROOT}/pages/${notionNameWithId(title, pageId)}/content.md`;
}

function notionDatabaseMetadataPath(databaseId: string, title?: string): string {
  return `${NOTION_PATH_ROOT}/databases/${notionNameWithId(title, databaseId)}/metadata.json`;
}

function notionDatabasePagePath(databaseId: string, pageId: string, pageTitle?: string, databaseTitle?: string): string {
  return `${NOTION_PATH_ROOT}/databases/${notionNameWithId(databaseTitle, databaseId)}/pages/${notionNameWithId(pageTitle, pageId)}/meta.json`;
}

function notionByIdAliasPath(parentScope: string, id: string): string {
  const suffix = NOTION_UUID_PATTERN.test(id) ? id.replace(/-/g, "").toLowerCase() : id;
  return `${parentScope}/by-id/${encodeNotionPathSegment(suffix)}.json`;
}

function notionByEditedAliasPath(parentScope: string, editedDate: string, id: string): string {
  const suffix = NOTION_UUID_PATTERN.test(id) ? id.replace(/-/g, "").toLowerCase() : id;
  return `${parentScope}/by-edited/${encodeNotionPathSegment(editedDate)}/${encodeNotionPathSegment(suffix)}.json`;
}

function notionByTitleAliasPath(parentScope: string, title: string, id: string): string {
  return `${parentScope}/by-title/${encodeNotionPathSegment(notionAliasFilename(title, id))}.json`;
}

function notionByNameAliasPath(parentScope: string, name: string, id: string): string {
  return `${parentScope}/by-name/${encodeNotionPathSegment(notionAliasFilename(name, id))}.json`;
}

function notionPageByDatabaseAliasPath(
  databaseId: string,
  pageId: string,
  databaseTitle: string,
  pageTitle: string,
): string {
  return `${NOTION_PATH_ROOT}/pages/by-database/${encodeNotionPathSegment(notionAliasFilename(databaseTitle, databaseId))}/${encodeNotionPathSegment(notionAliasFilename(pageTitle, pageId))}.json`;
}

function notionPageByParentAliasPath(
  parentType: string,
  parentId: string,
  pageId: string,
  parentTitle: string | undefined,
  pageTitle: string,
): string {
  const parentLabel = parentTitle && slugifies(parentTitle) ? parentTitle : parentId;
  const parentSegment = `${parentType}-${notionAliasFilename(parentLabel, parentId)}`;
  return `${NOTION_PATH_ROOT}/pages/by-parent/${encodeNotionPathSegment(parentSegment)}/${encodeNotionPathSegment(notionAliasFilename(pageTitle, pageId))}.json`;
}

function notionCanonicalPath(objectType: NotionObjectType, id: string): string {
  if (objectType === "page") return notionStandalonePagePath(id);
  if (objectType === "page_content") return notionStandalonePageContentPath(id);
  if (objectType === "database") return notionDatabaseMetadataPath(id);
  return `${NOTION_PATH_ROOT}/users/${encodeNotionPathSegment(id)}.json`;
}

function notionReadPageTitle(page: Record<string, unknown>): string | undefined {
  const direct = readFirstString(page, "title");
  if (direct) return direct;
  const properties = isObject(page.properties) ? page.properties : null;
  if (!properties) return undefined;
  for (const value of Object.values(properties)) {
    if (!isObject(value) || value.type !== "title" || !Array.isArray(value.title)) continue;
    const joined = value.title
      .map((item) => (isObject(item) && typeof item.plain_text === "string" ? item.plain_text : ""))
      .join("")
      .trim();
    if (joined) return joined;
  }
  return undefined;
}

function notionReadDatabaseTitle(database: Record<string, unknown>): string | undefined {
  const raw = database.title;
  if (typeof raw === "string") return raw.trim() || undefined;
  if (Array.isArray(raw)) {
    const joined = raw
      .map((item) => (isObject(item) && typeof item.plain_text === "string" ? item.plain_text : ""))
      .join("")
      .trim();
    return joined || undefined;
  }
  return undefined;
}

function notionReadParent(parent: unknown): { id?: string; type?: "database" | "page" | "workspace" } {
  if (!isObject(parent)) return {};
  if (parent.type === "database_id") return { id: readFirstString(parent, "database_id") ?? undefined, type: "database" };
  if (parent.type === "page_id") return { id: readFirstString(parent, "page_id") ?? undefined, type: "page" };
  if (parent.type === "block_id") return { id: readFirstString(parent, "block_id") ?? undefined, type: "page" };
  if (parent.type === "workspace") return { type: "workspace" };
  return {};
}

function notionReadPageEditedAt(page: Record<string, unknown>): string | undefined {
  return (
    readFirstString(page, "last_edited_time") ??
    readFirstString(page, "lastEditedTime") ??
    readFirstString(page, "created_time") ??
    readFirstString(page, "createdTime") ??
    undefined
  );
}

type NotionPageState = {
  title?: string;
  databaseId?: string;
  databaseTitle?: string;
  parentType?: "database" | "page" | "workspace";
  parentId?: string;
  parentTitle?: string;
  editedDate?: string;
};

type NotionNamedState = {
  title?: string;
  name?: string;
};

function deriveNotionPageState(page: Record<string, unknown>): NotionPageState {
  const fromParent = notionReadParent(page.parent);
  const parentType = readFirstString(page, "parent_type") as NotionPageState["parentType"] | null ?? fromParent.type;
  const parentId = readFirstString(page, "parent_id") ?? fromParent.id;
  return {
    title: notionReadPageTitle(page),
    parentType,
    parentId: parentId ?? undefined,
    databaseId:
      readFirstString(page, "database_id") ??
      readFirstString(page, "databaseId") ??
      (parentType === "database" ? parentId ?? undefined : undefined),
    databaseTitle: readFirstString(page, "database_title") ?? readFirstString(page, "databaseTitle") ?? undefined,
    parentTitle: readFirstString(page, "parent_title") ?? readFirstString(page, "parentTitle") ?? undefined,
    editedDate: editedDateSegment(notionReadPageEditedAt(page)),
  };
}

function notionPagePaths(id: string, state: NotionPageState): string[] {
  const paths = [];
  if (state.parentType === "database" && state.databaseId) {
    paths.push(notionDatabasePagePath(state.databaseId, id));
  } else {
    paths.push(notionStandalonePagePath(id));
  }
  const pagesScope = `${NOTION_PATH_ROOT}/pages`;
  paths.push(notionByIdAliasPath(pagesScope, id));
  if (state.editedDate) {
    paths.push(notionByEditedAliasPath(pagesScope, state.editedDate, id));
  }
  if (state.title && slugifies(state.title)) {
    paths.push(notionByTitleAliasPath(pagesScope, state.title, id));
  }
  if (
    state.parentType === "database" &&
    state.databaseId &&
    state.databaseTitle &&
    slugifies(state.databaseTitle) &&
    state.title &&
    slugifies(state.title)
  ) {
    paths.push(notionPageByDatabaseAliasPath(state.databaseId, id, state.databaseTitle, state.title));
  }
  if (state.parentType === "page" && state.parentId && state.title && slugifies(state.title)) {
    paths.push(notionPageByParentAliasPath(state.parentType, state.parentId, id, state.parentTitle, state.title));
  }
  return paths;
}

function notionDatabasePaths(id: string, title?: string): string[] {
  const databasesScope = `${NOTION_PATH_ROOT}/databases`;
  const paths = [notionDatabaseMetadataPath(id), notionByIdAliasPath(databasesScope, id)];
  if (title && slugifies(title)) paths.push(notionByTitleAliasPath(databasesScope, title, id));
  return paths;
}

function notionUserPaths(id: string, name?: string): string[] {
  const usersScope = `${NOTION_PATH_ROOT}/users`;
  const paths = [`${usersScope}/${encodeNotionPathSegment(id)}.json`, notionByIdAliasPath(usersScope, id)];
  if (name && slugifies(name)) paths.push(notionByNameAliasPath(usersScope, name, id));
  return paths;
}

function extractPriorNotionPageState(record: Record<string, unknown> | null): NotionPageState | null {
  const payload = pickPayload(record);
  if (!payload) return null;
  return deriveNotionPageState(payload);
}

function extractPriorNotionDatabaseState(record: Record<string, unknown> | null): NotionNamedState | null {
  const payload = pickPayload(record);
  if (!payload) return null;
  return { title: notionReadDatabaseTitle(payload) };
}

function extractPriorNotionUserState(record: Record<string, unknown> | null): NotionNamedState | null {
  const payload = pickPayload(record);
  if (!payload) return null;
  return { name: readFirstString(payload, "name") ?? undefined };
}

function renderNotionWrappedContent(
  objectType: Exclude<NotionObjectType, "page_content">,
  objectId: string,
  payload: Record<string, unknown>,
  job: NangoSyncJob,
): string {
  return JSON.stringify(
    {
      provider: "notion",
      objectType,
      objectId,
      deleted: false,
      payload,
      connectionId: job.connectionId,
    },
    null,
    2,
  );
}

function notionPageIndexRow(id: string, state: NotionPageState, page: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    title: state.title ?? "",
    updated:
      readFirstString(page, "last_edited_time") ??
      readFirstString(page, "lastEditedTime") ??
      readFirstString(page, "created_time") ??
      readFirstString(page, "createdTime") ??
      "",
    parent_id: state.parentId ?? null,
    parent_type: state.parentType ?? "workspace",
  };
}

function notionDatabaseIndexRow(id: string, title: string | undefined, database: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    title: title ?? "",
    updated:
      readFirstString(database, "last_edited_time") ??
      readFirstString(database, "lastEditedTime") ??
      readFirstString(database, "created_time") ??
      readFirstString(database, "createdTime") ??
      "",
    parent_id: null,
    parent_type: "workspace",
  };
}

function notionUserIndexRow(id: string, name: string | undefined, user: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    title: name ?? "",
    updated:
      readFirstString(user, "last_edited_time") ??
      readFirstString(user, "lastEditedTime") ??
      readFirstString(user, "created_time") ??
      readFirstString(user, "createdTime") ??
      "",
    is_bot: readFirstString(user, "type") === "bot",
  };
}

function planNotionRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const objectType = normalizeNotionObjectType(job.model);
  const writes: PlannedRelayfileWrite[] = [];
  const appliedRecords: Record<string, unknown>[] = [];
  const removedIds = new Set<string>();
  const deletedPaths = new Set<string>();
  let written = 0;
  let deleted = 0;
  let skipped = 0;

  const pushDelete = (path: string) => {
    if (!readContextValue(context.existingFiles, path)) return;
    if (deletedPaths.has(path)) return;
    deletedPaths.add(path);
    writes.push(deleteWrite(path, context));
  };

  for (const raw of records) {
    const cleaned = stripNangoMetadata(raw);
    const objectId = readId(cleaned);
    if (!objectId) throw new Error("Missing Notion record id");
    const canonicalPath = notionCanonicalPath(objectType, objectId);
    if (isStaleAgainstAny(raw, [readJsonObject(context, canonicalPath)])) {
      skipped += 1;
      continue;
    }
    if (isDeletedNangoRecord(raw)) {
      pushDelete(canonicalPath);
      removedIds.add(objectId);
      deleted += 1;
      continue;
    }
    if (objectType === "page_content") {
      writes.push({
        path: canonicalPath,
        contents: typeof cleaned.content === "string" ? cleaned.content : "",
        contentType: "text/markdown; charset=utf-8",
        baseRevision: "*",
      });
    } else {
      writes.push({
        path: canonicalPath,
        contents: JSON.stringify(cleaned),
        contentType: JSON_CONTENT_TYPE,
        baseRevision: "*",
      });
    }
    appliedRecords.push(cleaned);
    written += 1;
  }

  if (appliedRecords.length > 0 || removedIds.size > 0) {
    writes.push({
      path: notionRootIndexPath(),
      contents: "[{\"id\":\"pages\",\"title\":\"Pages\"},{\"id\":\"databases\",\"title\":\"Databases\"},{\"id\":\"users\",\"title\":\"Users\"}]\n",
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }

  if (objectType === "page" && (appliedRecords.length > 0 || removedIds.size > 0)) {
    for (const page of appliedRecords) {
      const id = readId(page);
      const state = deriveNotionPageState(page);
      const previous = extractPriorNotionPageState(readJsonObject(context, notionByIdAliasPath(`${NOTION_PATH_ROOT}/pages`, id)));
      const nextPaths = notionPagePaths(id, state);
      if (previous) {
        for (const stalePath of diffPaths(notionPagePaths(id, previous), nextPaths)) {
          pushDelete(stalePath);
        }
      }
      const contents = renderNotionWrappedContent("page", id, page, job);
      for (const path of nextPaths) {
        writes.push({ path, contents, contentType: JSON_CONTENT_TYPE, baseRevision: "*" });
      }
    }
    for (const id of removedIds) {
      const previous = extractPriorNotionPageState(readJsonObject(context, notionByIdAliasPath(`${NOTION_PATH_ROOT}/pages`, id)));
      for (const path of notionPagePaths(id, previous ?? {})) {
        pushDelete(path);
      }
    }
    writes.push({
      path: notionPagesIndexPath(),
      contents: sortedIndexContent(mergeIndexRows(
        readJsonArray(context, notionPagesIndexPath()),
        appliedRecords.map((page) => notionPageIndexRow(readId(page), deriveNotionPageState(page), page)),
        removedIds,
      )),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }

  if (objectType === "database" && (appliedRecords.length > 0 || removedIds.size > 0)) {
    for (const database of appliedRecords) {
      const id = readId(database);
      const title = notionReadDatabaseTitle(database);
      const previous = extractPriorNotionDatabaseState(readJsonObject(context, notionByIdAliasPath(`${NOTION_PATH_ROOT}/databases`, id)));
      const nextPaths = notionDatabasePaths(id, title);
      if (previous) {
        for (const stalePath of diffPaths(notionDatabasePaths(id, previous.title), nextPaths)) {
          pushDelete(stalePath);
        }
      }
      const contents = renderNotionWrappedContent("database", id, database, job);
      for (const path of nextPaths) {
        writes.push({ path, contents, contentType: JSON_CONTENT_TYPE, baseRevision: "*" });
      }
    }
    for (const id of removedIds) {
      const previous = extractPriorNotionDatabaseState(readJsonObject(context, notionByIdAliasPath(`${NOTION_PATH_ROOT}/databases`, id)));
      for (const path of notionDatabasePaths(id, previous?.title)) {
        pushDelete(path);
      }
    }
    writes.push({
      path: notionDatabasesIndexPath(),
      contents: sortedIndexContent(mergeIndexRows(
        readJsonArray(context, notionDatabasesIndexPath()),
        appliedRecords.map((database) => notionDatabaseIndexRow(readId(database), notionReadDatabaseTitle(database), database)),
        removedIds,
      )),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }

  if (objectType === "user" && (appliedRecords.length > 0 || removedIds.size > 0)) {
    for (const user of appliedRecords) {
      const id = readId(user);
      const name = readFirstString(user, "name") ?? undefined;
      const previous = extractPriorNotionUserState(readJsonObject(context, notionByIdAliasPath(`${NOTION_PATH_ROOT}/users`, id)));
      const nextPaths = notionUserPaths(id, name);
      if (previous) {
        for (const stalePath of diffPaths(notionUserPaths(id, previous.name), nextPaths)) {
          pushDelete(stalePath);
        }
      }
      const contents = renderNotionWrappedContent("user", id, user, job);
      for (const path of nextPaths) {
        writes.push({ path, contents, contentType: JSON_CONTENT_TYPE, baseRevision: "*" });
      }
    }
    for (const id of removedIds) {
      const previous = extractPriorNotionUserState(readJsonObject(context, notionByIdAliasPath(`${NOTION_PATH_ROOT}/users`, id)));
      for (const path of notionUserPaths(id, previous?.name)) {
        pushDelete(path);
      }
    }
    writes.push({
      path: notionUsersIndexPath(),
      contents: sortedIndexContent(mergeIndexRows(
        readJsonArray(context, notionUsersIndexPath()),
        appliedRecords.map((user) => notionUserIndexRow(readId(user), readFirstString(user, "name") ?? undefined, user)),
        removedIds,
      )),
      contentType: JSON_CONTENT_TYPE,
      baseRevision: "*",
    });
  }

  return { writes, written, deleted, skipped };
}

const X_PATH_ROOT = "/x";
const GOOGLE_MAIL_PATH_ROOT = "/google-mail";
const GOOGLE_CALENDAR_PATH_ROOT = "/google-calendar";

function encodeGenericPathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Provider path segment must be a non-empty string");
  return encodeURIComponent(trimmed).replace(/\./gu, "%2E");
}

function xFlatRecordFilename(objectId: string, title?: string | null): string {
  const id = objectId.trim().replace(/\.json$/u, "");
  const slug = title ? slugifyAlias(title) : slugifyAlias(id);
  if (!slug || slug === "untitled" || slug === id) {
    return `${encodeGenericPathSegment(id)}.json`;
  }
  return `${encodeGenericPathSegment(slug)}__${encodeGenericPathSegment(id)}.json`;
}

function xDirectoryRecordSegment(objectId: string, title?: string | null): string {
  const id = objectId.trim();
  const encodedId = id.includes("__")
    ? encodeGenericPathSegment(id).replace(/_/gu, "%5F")
    : encodeGenericPathSegment(id);
  const slug = title ? slugifyAlias(title) : "";
  return slug ? `${encodedId}__${encodeGenericPathSegment(slug)}` : encodedId;
}

function xSearchMetaPath(searchId: string, titleOrQuery?: string | null): string {
  return `${X_PATH_ROOT}/searches/${xDirectoryRecordSegment(searchId, titleOrQuery)}/meta.json`;
}

function xSearchResultsIndexPath(searchId: string, titleOrQuery?: string | null): string {
  return `${X_PATH_ROOT}/searches/${xDirectoryRecordSegment(searchId, titleOrQuery)}/results/_index.json`;
}

function xSearchResultPath(searchId: string, titleOrQuery: string | null | undefined, postId: string): string {
  return `${X_PATH_ROOT}/searches/${xDirectoryRecordSegment(searchId, titleOrQuery)}/results/${encodeGenericPathSegment(postId)}.json`;
}

function xPostPath(postId: string, textOrTitle?: string | null): string {
  return `${X_PATH_ROOT}/posts/${xFlatRecordFilename(postId, textOrTitle)}`;
}

function xUserPath(userId: string, usernameOrName?: string | null): string {
  return `${X_PATH_ROOT}/users/${xFlatRecordFilename(userId, usernameOrName)}`;
}

function xSearchByIdAliasPath(searchId: string): string {
  return `${X_PATH_ROOT}/searches/by-id/${encodeGenericPathSegment(searchId)}.json`;
}

function xSearchByQueryAliasPath(query: string, searchId: string): string {
  return `${X_PATH_ROOT}/searches/by-query/${encodeGenericPathSegment(`${slugifyAlias(query)}__${searchId}`)}.json`;
}

function xPostByIdAliasPath(postId: string): string {
  return `${X_PATH_ROOT}/posts/by-id/${encodeGenericPathSegment(postId)}.json`;
}

function xPostByAuthorAliasPath(authorIdOrUsername: string, postId: string): string {
  return `${X_PATH_ROOT}/posts/by-author/${encodeGenericPathSegment(slugifyAlias(authorIdOrUsername))}/${encodeGenericPathSegment(postId)}.json`;
}

function xUserByIdAliasPath(userId: string): string {
  return `${X_PATH_ROOT}/users/by-id/${encodeGenericPathSegment(userId)}.json`;
}

function xUserByUsernameAliasPath(username: string, userId: string): string {
  return `${X_PATH_ROOT}/users/by-username/${encodeGenericPathSegment(`${slugifyAlias(username)}__${userId}`)}.json`;
}

function googleMailMessagePath(id: string): string {
  return `${GOOGLE_MAIL_PATH_ROOT}/messages/${encodeGenericPathSegment(id)}.json`;
}

function googleMailThreadPath(id: string): string {
  return `${GOOGLE_MAIL_PATH_ROOT}/threads/${encodeGenericPathSegment(id)}.json`;
}

function googleMailLabelPath(id: string): string {
  return `${GOOGLE_MAIL_PATH_ROOT}/labels/${encodeGenericPathSegment(id)}.json`;
}

function googleMailFilterPath(id: string): string {
  return `${GOOGLE_MAIL_PATH_ROOT}/filters/${encodeGenericPathSegment(id)}.json`;
}

function googleMailSendAsPath(id: string): string {
  return `${GOOGLE_MAIL_PATH_ROOT}/send-as/${encodeGenericPathSegment(id)}.json`;
}

function googleMailWatchRenewalPath(id: string): string {
  return `${GOOGLE_MAIL_PATH_ROOT}/watch-renewals/${encodeGenericPathSegment(id)}.json`;
}

function googleCalendarCalendarPath(id: string): string {
  return `${GOOGLE_CALENDAR_PATH_ROOT}/calendars/${encodeGenericPathSegment(id)}.json`;
}

function googleCalendarSettingPath(id: string): string {
  return `${GOOGLE_CALENDAR_PATH_ROOT}/settings/${encodeGenericPathSegment(id)}.json`;
}

function googleCalendarColorPath(record: Record<string, unknown>): string {
  const colorType = readFirstString(record, "colorType", "color_type") ?? "unknown";
  const colorId = readFirstString(record, "colorId", "color_id") ?? readId(record);
  if (!colorId) throw new Error("Missing Google Calendar color id");
  return `${GOOGLE_CALENDAR_PATH_ROOT}/colors/${encodeGenericPathSegment(colorType)}/${encodeGenericPathSegment(colorId)}.json`;
}

function splitCompositeId(value: string | null): { left: string; right: string } | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator >= value.length - 1) return null;
  const left = value.slice(0, separator).trim();
  const right = value.slice(separator + 1).trim();
  return left && right ? { left, right } : null;
}

function googleCalendarEventPath(record: Record<string, unknown>): string {
  const id = readId(record);
  const composite = splitCompositeId(id);
  const calendarId = readFirstString(record, "calendarId", "calendar_id") ?? composite?.left ?? null;
  const eventId = readFirstString(record, "eventId", "event_id") ?? composite?.right ?? id;
  if (!eventId) throw new Error("Missing Google Calendar event id");
  if (!calendarId) return `${GOOGLE_CALENDAR_PATH_ROOT}/events/${encodeGenericPathSegment(eventId)}.json`;
  return `${GOOGLE_CALENDAR_PATH_ROOT}/calendars/${encodeGenericPathSegment(calendarId)}/events/${encodeGenericPathSegment(eventId)}.json`;
}

function googleCalendarAclPath(record: Record<string, unknown>): string {
  const id = readId(record);
  const composite = splitCompositeId(id);
  const calendarId = readFirstString(record, "calendarId", "calendar_id") ?? composite?.left ?? null;
  const ruleId = readFirstString(record, "ruleId", "rule_id") ?? composite?.right ?? id;
  if (!ruleId) throw new Error("Missing Google Calendar ACL rule id");
  if (!calendarId) return `${GOOGLE_CALENDAR_PATH_ROOT}/acls/${encodeGenericPathSegment(ruleId)}.json`;
  return `${GOOGLE_CALENDAR_PATH_ROOT}/calendars/${encodeGenericPathSegment(calendarId)}/acls/${encodeGenericPathSegment(ruleId)}.json`;
}

function googleCalendarWatchRenewalPath(id: string): string {
  return `${GOOGLE_CALENDAR_PATH_ROOT}/watch-renewals/${encodeGenericPathSegment(id)}.json`;
}

function jsonWrite(path: string, contents: string, context: ProviderWritePlannerContext): PlannedRelayfileWrite {
  return {
    path,
    contents,
    contentType: JSON_CONTENT_TYPE,
    baseRevision: revisionFor(context, path) ?? "*",
  };
}

function sortedRowsContent(rows: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify([...rows].sort((left, right) => {
    const updated = String(right.updated ?? "").localeCompare(String(left.updated ?? ""));
    return updated || String(left.id ?? "").localeCompare(String(right.id ?? ""));
  }))}\n`;
}

function xSearchIndexRow(search: Record<string, unknown>): Record<string, unknown> {
  const id = readId(search);
  const costEstimate = isObject(search.costEstimate) ? search.costEstimate : null;
  return {
    id,
    title: readFirstString(search, "title", "query") ?? id,
    updated: readProviderTimestampForIndex(search),
    query: readFirstString(search, "query") ?? "",
    mode: readFirstString(search, "mode") ?? "recent",
    resultCount: typeof search.resultCount === "number" ? search.resultCount : undefined,
    estimatedUsd: typeof costEstimate?.estimatedUsd === "number" ? costEstimate.estimatedUsd : undefined,
  };
}

function xPostIndexRow(post: Record<string, unknown>, username?: string): Record<string, unknown> {
  const id = readId(post);
  return {
    id,
    title: readFirstString(post, "text", "title") ?? id,
    updated: readFirstString(post, "created_at", "createdAt") ?? "",
    authorId: readFirstString(post, "author_id", "authorId") ?? undefined,
    username,
    conversationId: readFirstString(post, "conversation_id", "conversationId") ?? undefined,
    lang: readFirstString(post, "lang") ?? undefined,
  };
}

function xUserIndexRow(user: Record<string, unknown>): Record<string, unknown> {
  const id = readId(user);
  return {
    id,
    title: readFirstString(user, "name", "username") ?? id,
    updated: readProviderTimestampForIndex(user),
    username: readFirstString(user, "username") ?? undefined,
    verified: user.verified === true,
  };
}

function xSearchResultIndexRow(result: Record<string, unknown>): Record<string, unknown> {
  return {
    id: readId(result),
    searchId: readFirstString(result, "searchId", "search_id") ?? undefined,
    postId: readFirstString(result, "postId", "post_id") ?? undefined,
    rank: typeof result.rank === "number" ? result.rank : undefined,
    canonicalPath: readFirstString(result, "canonicalPath") ?? undefined,
    query: readFirstString(result, "query") ?? undefined,
  };
}

function googleSimpleIndexRow(record: Record<string, unknown>, canonicalPath: string): Record<string, unknown> {
  const id = readId(record);
  return {
    id,
    title: readFirstString(record, "summaryOverride", "summary", "name", "displayName", "sendAsEmail", "id") ?? id,
    updated: readProviderTimestampForIndex(record),
    canonicalPath,
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function parseInternalDateDay(value: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = parseTimestampMs(value);
  return parsed === null ? undefined : new Date(parsed).toISOString().slice(0, 10);
}

function parseCalendarStartDay(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  return readFirstString(value, "date") ?? readFirstString(value, "dateTime")?.slice(0, 10);
}

function parseEmailAddress(value: string | null): string | undefined {
  if (!value) return undefined;
  const angleMatch = /<([^>]+)>/u.exec(value);
  return (angleMatch?.[1] ?? value).trim().toLowerCase() || undefined;
}

function readGmailHeader(record: Record<string, unknown>, name: string): string | null {
  const payload = readNestedRecord(record, "payload");
  const headers = payload && Array.isArray(payload.headers) ? payload.headers : [];
  const header = headers.find((item): item is Record<string, unknown> =>
    isObject(item) && readFirstString(item, "name")?.toLowerCase() === name.toLowerCase(),
  );
  return header ? readFirstString(header, "value") : null;
}

function readNullableStringField(
  record: Record<string, unknown>,
  field: string,
): string | null {
  return typeof record[field] === "string" ? record[field] : null;
}

function readGmailFlattenedHeader(
  record: Record<string, unknown>,
  headerName: string,
  field: string,
): string | null {
  return readGmailHeader(record, headerName) ??
    readNullableStringField(record, field);
}

function decodeGmailBodyData(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
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
  if (!payload) return { bodyText: null, bodyHtml: null, attachments: [] };
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

function normalizeGoogleMailMessageRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const extracted = extractGmailMessageBodies(record);
  const payload = readNestedRecord(record, "payload");
  const existingAttachments = Array.isArray(record.attachments)
    ? record.attachments
    : [];
  const base = { ...record };
  delete base.payload;
  delete base.raw;
  delete base.raw_json;
  return {
    ...base,
    subject: readGmailFlattenedHeader(record, "Subject", "subject"),
    from: readGmailFlattenedHeader(record, "From", "from"),
    to: readGmailFlattenedHeader(record, "To", "to"),
    cc: readGmailFlattenedHeader(record, "Cc", "cc"),
    bcc: readGmailFlattenedHeader(record, "Bcc", "bcc"),
    date: readGmailFlattenedHeader(record, "Date", "date"),
    messageId: readGmailFlattenedHeader(record, "Message-ID", "messageId"),
    inReplyTo: readGmailFlattenedHeader(record, "In-Reply-To", "inReplyTo"),
    references: readGmailFlattenedHeader(record, "References", "references"),
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
  kind: GoogleMailModelKind,
): Record<string, unknown> {
  if (kind === "message") return normalizeGoogleMailMessageRecord(record);
  if (kind === "thread") {
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

function googleMailMessageIndexRow(record: Record<string, unknown>): Record<string, unknown> {
  const id = readId(record);
  const fromHeader =
    readFirstString(record, "from") ?? readGmailHeader(record, "From");
  const senderEmail = parseEmailAddress(fromHeader);
  return {
    id,
    threadId: readFirstString(record, "threadId", "thread_id") ?? "",
    subject:
      readFirstString(record, "subject") ??
      readGmailHeader(record, "Subject") ??
      undefined,
    sender: fromHeader ?? undefined,
    senderEmail,
    senderKey: senderEmail ?? fromHeader ?? "unknown",
    labelIds: readStringArray(record.labelIds),
    snippet: readFirstString(record, "snippet") ?? undefined,
    internalDate: readFirstString(record, "internalDate", "internal_date") ?? undefined,
    day: parseInternalDateDay(readFirstString(record, "internalDate", "internal_date")),
    canonicalPath: googleMailMessagePath(id),
  };
}

function googleCalendarEventIndexRow(record: Record<string, unknown>): Record<string, unknown> {
  const organizer = isObject(record.organizer) ? record.organizer : null;
  const creator = isObject(record.creator) ? record.creator : null;
  const organizerEmail =
    (organizer ? readFirstString(organizer, "email") : null) ??
    (creator ? readFirstString(creator, "email") : null);
  const id = readId(record);
  return {
    id,
    calendarId: readFirstString(record, "calendarId", "calendar_id") ?? undefined,
    eventId: readFirstString(record, "eventId", "event_id") ?? undefined,
    summary: readFirstString(record, "summary") ?? undefined,
    status: (readFirstString(record, "status") ?? "confirmed").toLowerCase(),
    organizerEmail: organizerEmail ?? undefined,
    organizerKey: organizerEmail?.toLowerCase() ?? "unknown",
    startDay: parseCalendarStartDay(record.start),
    updated: readProviderTimestampForIndex(record),
    canonicalPath: googleCalendarEventPath(record),
  };
}

function readProviderTimestampForIndex(record: Record<string, unknown>): string {
  const timestampMs = extractTimestampMs(record);
  return timestampMs === null ? "" : new Date(timestampMs).toISOString();
}

type TelegramModelKind =
  | "bot-config"
  | "update"
  | "chat"
  | "message"
  | "callback-query"
  | "inline-query"
  | "reaction";

function telegramKind(model: string): TelegramModelKind {
  const normalized = model.trim().toLowerCase();
  if (
    normalized === "telegrambotconfig" ||
    normalized === "botconfig" ||
    normalized === "bot-config"
  ) {
    return "bot-config";
  }
  if (normalized === "telegramupdate" || normalized === "update") {
    return "update";
  }
  if (normalized === "telegramchat" || normalized === "chat") {
    return "chat";
  }
  if (normalized === "telegrammessage" || normalized === "message") {
    return "message";
  }
  if (
    normalized === "telegramcallbackquery" ||
    normalized === "callbackquery" ||
    normalized === "callback-query"
  ) {
    return "callback-query";
  }
  if (
    normalized === "telegraminlinequery" ||
    normalized === "inlinequery" ||
    normalized === "inline-query"
  ) {
    return "inline-query";
  }
  if (normalized === "telegramreaction" || normalized === "reaction") {
    return "reaction";
  }
  throw new Error(`Unsupported Telegram model: ${model}`);
}

function telegramPathSegment(value: string | number | undefined, fallback = "unknown"): string {
  const trimmed = value === undefined ? "" : String(value).trim();
  return trimmed.replace(/[^A-Za-z0-9._+=@-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function telegramSlug(value: string | undefined): string {
  if (!value) {
    return "";
  }

  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "untitled") {
    return "";
  }
  if (normalized.length <= 80) {
    return normalized;
  }

  const head = normalized.slice(0, 80);
  const boundary = head.lastIndexOf("-");
  return (boundary > 0 ? head.slice(0, boundary) : head).replace(/-+$/g, "");
}

function telegramNested(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = readNestedRecord(record, key);
  return nested ?? {};
}

function telegramMessageRecord(record: Record<string, unknown>): Record<string, unknown> {
  return readNestedRecord(record, "message") ?? readNestedRecord(record, "edited_message") ?? {};
}

function telegramChatRecord(record: Record<string, unknown>): Record<string, unknown> {
  return readNestedRecord(record, "chat") ?? telegramNested(telegramMessageRecord(record), "chat");
}

function telegramChatId(record: Record<string, unknown>): string | null {
  const chat = telegramChatRecord(record);
  return (readFirstString(record, "chatId", "chat_id") ?? readId(chat)) || null;
}

function telegramChatTitle(record: Record<string, unknown>): string | undefined {
  const chat = telegramChatRecord(record);
  return readFirstString(record, "chatTitle", "chat_title", "title") ??
    readFirstString(chat, "title", "username", "first_name") ??
    undefined;
}

function telegramMessageId(record: Record<string, unknown>): string | null {
  return readFirstString(record, "messageId", "message_id") ??
    readFirstString(telegramMessageRecord(record), "message_id");
}

function telegramThreadId(record: Record<string, unknown>): string | null {
  return readFirstString(record, "messageThreadId", "message_thread_id") ??
    readFirstString(telegramMessageRecord(record), "messageThreadId", "message_thread_id", "threadId");
}

function telegramChatDir(chatId: string, title?: string): string {
  const slug = telegramSlug(title);
  return `/telegram/chats/${telegramPathSegment(chatId)}${slug ? `__${slug}` : ""}`;
}

function telegramCanonicalPath(record: Record<string, unknown>, kind: TelegramModelKind): string {
  const id = readId(record);
  if (kind === "bot-config") return "/telegram/bot/config.json";
  if (kind === "chat") {
    const chatId = telegramChatId(record) ?? id;
    if (!chatId) throw new Error("Missing Telegram chat id");
    return `${telegramChatDir(chatId, telegramChatTitle(record))}/meta.json`;
  }
  if (kind === "message") {
    const chatId = telegramChatId(record);
    const messageId = telegramMessageId(record);
    if (!chatId || !messageId) throw new Error("Missing Telegram message chat id or message id");
    const threadId = telegramThreadId(record);
    const dir = telegramChatDir(chatId, telegramChatTitle(record));
    return threadId
      ? `${dir}/threads/${telegramPathSegment(threadId)}/messages/${telegramPathSegment(messageId)}/meta.json`
      : `${dir}/messages/${telegramPathSegment(messageId)}/meta.json`;
  }
  if (kind === "callback-query") {
    const callbackQueryId = id || readFirstString(record, "callbackQueryId", "callback_query_id");
    if (!callbackQueryId) throw new Error("Missing Telegram callback query id");
    return `/telegram/callback-queries/${telegramPathSegment(callbackQueryId)}.json`;
  }
  if (kind === "inline-query") {
    const inlineQueryId = id || readFirstString(record, "inlineQueryId", "inline_query_id");
    if (!inlineQueryId) throw new Error("Missing Telegram inline query id");
    return `/telegram/inline-queries/${telegramPathSegment(inlineQueryId)}.json`;
  }
  if (kind === "reaction") {
    const chatId = telegramChatId(record);
    const messageId = telegramMessageId(record);
    const updateId = readFirstString(record, "updateId", "update_id") ?? id;
    if (!chatId || !messageId || !updateId) {
      throw new Error("Missing Telegram reaction chat id, message id, or update id");
    }
    return `${telegramChatDir(chatId, telegramChatTitle(record))}/messages/${telegramPathSegment(messageId)}/reactions/${telegramPathSegment(updateId)}.json`;
  }
  const updateId = readFirstString(record, "updateId", "update_id") ?? id;
  if (!updateId) throw new Error("Missing Telegram update id");
  return `/telegram/updates/${telegramPathSegment(updateId)}.json`;
}

function planTelegramRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const kind = telegramKind(job.model);
  const writes: PlannedRelayfileWrite[] = [];
  let written = 0;
  let deleted = 0;

  for (const raw of records) {
    const cleaned = stripNangoMetadata(raw);
    const path = telegramCanonicalPath(cleaned, kind);
    if (isDeletedNangoRecord(raw)) {
      writes.push(deleteWrite(path, context));
      deleted += 1;
      continue;
    }
    writes.push(jsonWrite(path, JSON.stringify(cleaned), context));
    written += 1;
  }

  return { writes, written, deleted, skipped: 0 };
}

function upsertRows(
  context: ProviderWritePlannerContext,
  path: string,
  rows: readonly Record<string, unknown>[],
  removes: ReadonlySet<string> = new Set(),
): PlannedRelayfileWrite {
  return {
    path,
    contents: sortedRowsContent(mergeIndexRows(readJsonArray(context, path), rows, removes)),
    contentType: JSON_CONTENT_TYPE,
    baseRevision: revisionFor(context, path) ?? "*",
  };
}

function planXRecordWrites(
  _job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const writes: PlannedRelayfileWrite[] = [];
  const searches: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const users: Record<string, unknown>[] = [];
  const results: Record<string, unknown>[] = [];
  let written = 0;
  let deleted = 0;

  for (const raw of records) {
    const cleaned = stripNangoMetadata(raw);
    const run = isObject(cleaned.run) ? cleaned.run : cleaned;
    const searchId = readId(run);
    if (!searchId) throw new Error("Missing X search bundle run id");
    const titleOrQuery = readFirstString(run, "title", "query");
    const canonicalPath = xSearchMetaPath(searchId, titleOrQuery);
    if (isDeletedNangoRecord(raw)) {
      writes.push(deleteWrite(canonicalPath, context));
      deleted += 1;
      continue;
    }
    const searchContent = JSON.stringify(cleaned);
    writes.push(jsonWrite(canonicalPath, searchContent, context));
    searches.push(run);

    const bundlePosts = Array.isArray(cleaned.posts)
      ? cleaned.posts.filter((item): item is Record<string, unknown> => isObject(item))
      : [];
    const bundleUsers = Array.isArray(cleaned.users)
      ? cleaned.users.filter((item): item is Record<string, unknown> => isObject(item))
      : [];
    const bundleResults = Array.isArray(cleaned.results)
      ? cleaned.results.filter((item): item is Record<string, unknown> => isObject(item))
      : [];
    const usersById = new Map(bundleUsers.map((user) => [readId(user), user]));

    writes.push(jsonWrite(xSearchByIdAliasPath(searchId), searchContent, context));
    const query = readFirstString(run, "query");
    if (query) writes.push(jsonWrite(xSearchByQueryAliasPath(query, searchId), searchContent, context));

    for (const user of bundleUsers) {
      const userId = readId(user);
      if (!userId) continue;
      const userContent = JSON.stringify(user);
      writes.push(jsonWrite(xUserPath(userId, readFirstString(user, "username", "name")), userContent, context));
      writes.push(jsonWrite(xUserByIdAliasPath(userId), userContent, context));
      const username = readFirstString(user, "username");
      if (username) writes.push(jsonWrite(xUserByUsernameAliasPath(username, userId), userContent, context));
      users.push(user);
    }

    for (const post of bundlePosts) {
      const postId = readId(post);
      if (!postId) continue;
      const postContent = JSON.stringify(post);
      writes.push(jsonWrite(xPostPath(postId, readFirstString(post, "text", "title")), postContent, context));
      writes.push(jsonWrite(xPostByIdAliasPath(postId), postContent, context));
      const author = readFirstString(post, "author_id", "authorId");
      const authorUser = author ? usersById.get(author) : undefined;
      const authorKey = authorUser ? readFirstString(authorUser, "username", "name") : author;
      if (authorKey) writes.push(jsonWrite(xPostByAuthorAliasPath(authorKey, postId), postContent, context));
      posts.push(post);
    }

    for (const result of bundleResults) {
      const postId = readFirstString(result, "postId", "post_id");
      if (!postId) continue;
      writes.push(jsonWrite(xSearchResultPath(searchId, titleOrQuery, postId), JSON.stringify(result), context));
      results.push(result);
    }

    written += 1;
  }

  if (searches.length > 0) {
    writes.push(upsertRows(context, `${X_PATH_ROOT}/searches/_index.json`, searches.map(xSearchIndexRow)));
  }
  if (posts.length > 0) {
    const usersById = new Map(users.map((user) => [readId(user), user]));
    writes.push(upsertRows(context, `${X_PATH_ROOT}/posts/_index.json`, posts.map((post) =>
      xPostIndexRow(
        post,
        readFirstString(usersById.get(readFirstString(post, "author_id", "authorId") ?? "") ?? {}, "username") ?? undefined,
      ),
    )));
  }
  if (users.length > 0) {
    writes.push(upsertRows(context, `${X_PATH_ROOT}/users/_index.json`, users.map(xUserIndexRow)));
  }
  if (results.length > 0) {
    const firstSearch = searches[0];
    const searchId = firstSearch ? readId(firstSearch) : readFirstString(results[0]!, "searchId", "search_id");
    if (searchId) {
      writes.push(upsertRows(
        context,
        xSearchResultsIndexPath(searchId, firstSearch ? readFirstString(firstSearch, "title", "query") : undefined),
        results.map(xSearchResultIndexRow),
      ));
    }
  }

  return { writes, written, deleted, skipped: 0 };
}

type GoogleMailModelKind =
  | "label"
  | "filter"
  | "send-as"
  | "message"
  | "thread"
  | "watch-renewal";

function googleMailKind(model: string): GoogleMailModelKind {
  const normalized = model.trim().toLowerCase();
  if (normalized === "googlemaillabel" || normalized === "label") return "label";
  if (normalized === "googlemailfilter" || normalized === "filter") return "filter";
  if (normalized === "googlemailsendasalias" || normalized === "sendasalias") return "send-as";
  if (normalized === "googlemailmessage" || normalized === "message") return "message";
  if (normalized === "googlemailthread" || normalized === "thread") return "thread";
  if (normalized === "googlemailwatchrenewal" || normalized === "watchrenewal") return "watch-renewal";
  throw new Error(`Unsupported Google Mail model: ${model}`);
}

function googleMailCanonicalPath(record: Record<string, unknown>, kind: GoogleMailModelKind): string {
  const id = kind === "send-as"
    ? readFirstString(record, "id", "sendAsEmail", "send_as_email")
    : readId(record);
  if (!id) throw new Error(`Missing Google Mail ${kind} id`);
  if (kind === "label") return googleMailLabelPath(id);
  if (kind === "filter") return googleMailFilterPath(id);
  if (kind === "send-as") return googleMailSendAsPath(id);
  if (kind === "message") return googleMailMessagePath(id);
  if (kind === "thread") return googleMailThreadPath(id);
  return googleMailWatchRenewalPath(id);
}

function googleMailIndexPath(kind: GoogleMailModelKind): string {
  if (kind === "label") return `${GOOGLE_MAIL_PATH_ROOT}/labels/_index.json`;
  if (kind === "filter") return `${GOOGLE_MAIL_PATH_ROOT}/filters/_index.json`;
  if (kind === "send-as") return `${GOOGLE_MAIL_PATH_ROOT}/send-as/_index.json`;
  if (kind === "message") return `${GOOGLE_MAIL_PATH_ROOT}/messages/_index.json`;
  if (kind === "thread") return `${GOOGLE_MAIL_PATH_ROOT}/threads/_index.json`;
  return `${GOOGLE_MAIL_PATH_ROOT}/watch-renewals/_index.json`;
}

function googleMailStableModelKind(kind: GoogleMailModelKind): GoogleMailStableModel | null {
  if (kind === "message" || kind === "thread") return kind;
  return null;
}

function planGoogleMailRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const kind = googleMailKind(job.model);
  const writes: PlannedRelayfileWrite[] = [];
  const upserts: Record<string, unknown>[] = [];
  const removes = new Set<string>();
  let written = 0;
  let deleted = 0;
  let skipped = 0;
  const stableDedupEnabled = isGoogleMailStableDedupEnabled();

  for (const raw of records) {
    const cleaned = normalizeGoogleMailRecordForStorage(
      stripNangoMetadata(raw),
      kind,
    );
    const path = googleMailCanonicalPath(cleaned, kind);
    const id = kind === "send-as"
      ? readFirstString(cleaned, "id", "sendAsEmail", "send_as_email")
      : readId(cleaned);
    if (!id) throw new Error(`Missing Google Mail ${kind} id`);
    if (isDeletedNangoRecord(raw)) {
      writes.push(deleteWrite(path, context));
      removes.add(id);
      deleted += 1;
      continue;
    }
    const contents = JSON.stringify(cleaned);
    const stableModel = googleMailStableModelKind(kind);
    const existingText = readContextValue(context.existingFiles, path);
    if (
      stableModel &&
      stableDedupEnabled &&
      (existingText === contents ||
        googleMailStableProjectionMatches(existingText, cleaned, stableModel))
    ) {
      skipped += 1;
      continue;
    }
    writes.push(jsonWrite(path, contents, context));
    if (kind === "message") {
      const row = googleMailMessageIndexRow(cleaned);
      upserts.push(row);
      const threadId = readFirstString(cleaned, "threadId", "thread_id");
      if (threadId) {
        writes.push(upsertRows(
          context,
          `${GOOGLE_MAIL_PATH_ROOT}/messages/by-thread/${encodeGenericPathSegment(threadId)}/_index.json`,
          [row],
        ));
      }
    } else {
      upserts.push(googleSimpleIndexRow(cleaned, path));
    }
    written += 1;
  }

  if (upserts.length > 0 || removes.size > 0) {
    writes.push(upsertRows(context, googleMailIndexPath(kind), upserts, removes));
  }

  return { writes, written, deleted, skipped };
}

type GoogleCalendarModelKind =
  | "calendar"
  | "event"
  | "setting"
  | "acl"
  | "color"
  | "watch-renewal";

function googleCalendarKind(model: string): GoogleCalendarModelKind {
  const normalized = model.trim().toLowerCase();
  if (normalized === "googlecalendar" || normalized === "calendar") return "calendar";
  if (normalized === "googlecalendarevent" || normalized === "calendarevent" || normalized === "event") return "event";
  if (normalized === "googlecalendarsetting" || normalized === "calendarsetting" || normalized === "setting") return "setting";
  if (normalized === "googlecalendaracl" || normalized === "calendaracl" || normalized === "acl") return "acl";
  if (normalized === "googlecalendarcolor" || normalized === "calendarcolor" || normalized === "color") return "color";
  if (normalized === "googlecalendarwatchrenewal" || normalized === "calendarwatchrenewal" || normalized === "watchrenewal") return "watch-renewal";
  throw new Error(`Unsupported Google Calendar model: ${model}`);
}

function googleCalendarCanonicalPath(record: Record<string, unknown>, kind: GoogleCalendarModelKind): string {
  const id = readId(record);
  if (kind === "event") return googleCalendarEventPath(record);
  if (kind === "acl") return googleCalendarAclPath(record);
  if (kind === "color") return googleCalendarColorPath(record);
  if (!id) throw new Error(`Missing Google Calendar ${kind} id`);
  if (kind === "calendar") return googleCalendarCalendarPath(id);
  if (kind === "setting") return googleCalendarSettingPath(id);
  return googleCalendarWatchRenewalPath(id);
}

function googleCalendarIndexPath(kind: GoogleCalendarModelKind): string {
  if (kind === "calendar") return `${GOOGLE_CALENDAR_PATH_ROOT}/calendars/_index.json`;
  if (kind === "event") return `${GOOGLE_CALENDAR_PATH_ROOT}/events/_index.json`;
  if (kind === "acl") return `${GOOGLE_CALENDAR_PATH_ROOT}/acls/_index.json`;
  if (kind === "watch-renewal") return `${GOOGLE_CALENDAR_PATH_ROOT}/watch-renewals/_index.json`;
  if (kind === "setting") return `${GOOGLE_CALENDAR_PATH_ROOT}/settings/_index.json`;
  return `${GOOGLE_CALENDAR_PATH_ROOT}/colors/_index.json`;
}

function planGoogleCalendarRecordWrites(
  job: NangoSyncJob,
  records: readonly Record<string, unknown>[],
  context: ProviderWritePlannerContext,
): ProviderWritePlan {
  const kind = googleCalendarKind(job.model);
  const writes: PlannedRelayfileWrite[] = [];
  const upserts: Record<string, unknown>[] = [];
  const removes = new Set<string>();
  let written = 0;
  let deleted = 0;

  for (const raw of records) {
    const cleaned = stripNangoMetadata(raw);
    const path = googleCalendarCanonicalPath(cleaned, kind);
    const id = readId(cleaned);
    if (!id) throw new Error(`Missing Google Calendar ${kind} id`);
    if (isDeletedNangoRecord(raw)) {
      writes.push(deleteWrite(path, context));
      removes.add(id);
      deleted += 1;
      continue;
    }
    const contents = JSON.stringify(cleaned);
    writes.push(jsonWrite(path, contents, context));
    if (kind === "event") {
      const row = googleCalendarEventIndexRow(cleaned);
      upserts.push(row);
      const calendarId = readFirstString(cleaned, "calendarId", "calendar_id");
      if (calendarId) {
        writes.push(upsertRows(
          context,
          `${GOOGLE_CALENDAR_PATH_ROOT}/events/by-calendar/${encodeGenericPathSegment(calendarId)}/_index.json`,
          [row],
        ));
      }
    } else if (kind === "acl") {
      const row = googleSimpleIndexRow(cleaned, path);
      upserts.push(row);
      const calendarId = readFirstString(cleaned, "calendarId", "calendar_id");
      if (calendarId) {
        writes.push(upsertRows(
          context,
          `${GOOGLE_CALENDAR_PATH_ROOT}/acls/by-calendar/${encodeGenericPathSegment(calendarId)}/_index.json`,
          [row],
        ));
      }
    } else {
      upserts.push(googleSimpleIndexRow(cleaned, path));
    }
    written += 1;
  }

  if (upserts.length > 0 || removes.size > 0) {
    writes.push(upsertRows(context, googleCalendarIndexPath(kind), upserts, removes));
  }

  return { writes, written, deleted, skipped: 0 };
}
