import {
  type DiffExpansion,
  FeatureNotImplementedError,
  type FullExpansion,
  type SummaryExpansion,
  type ThreadExpansion,
  type ThreadItem,
  type ThreadExpansionOptions,
} from "@agent-relay/events";
import { fetchThread as fetchAsanaAdapterThread } from "@relayfile/adapter-asana";
import { fetchThread as fetchGitHubAdapterThread } from "@relayfile/adapter-github";
import { fetchThread as fetchJiraAdapterThread } from "@relayfile/adapter-jira";
import { fetchThread as fetchLinearAdapterThread } from "@relayfile/adapter-linear";
import { fetchThread as fetchNotionAdapterThread } from "@relayfile/adapter-notion";
import { fetchThread as fetchSlackAdapterThread } from "@relayfile/adapter-slack";
import { fetchThread as fetchZendeskAdapterThread } from "@relayfile/adapter-zendesk";
import { DEFAULT_RELAYFILE_BASE_URL, RelayFileClient, type FileReadResponse } from "@relayfile/sdk";
import type { FilesystemEvent } from "@relayfile/sdk";

import type { AgentEvent } from "./envelope-builder.js";

type EventFeedResponse = {
  events: FilesystemEvent[];
  nextCursor: string | null;
};

type FileQueryResponse = {
  items: Array<{
    path: string;
    revision: string;
    contentType: string;
    size: number;
    lastEditedAt: string;
  }>;
  nextCursor: string | null;
};
const MAX_CHANGE_LOOKBACK = 64;

export type GatewayExpandLevel = "summary" | "full" | "diff" | "thread";

export type GatewayExpandResult =
  | SummaryExpansion
  | (FullExpansion<unknown> & { digest?: string; url?: string })
  | DiffExpansion
  | ThreadExpansion;

export type GatewayExpandInput = {
  workspace: string;
  event: AgentEvent;
  level: GatewayExpandLevel;
  threadOptions?: ThreadExpansionOptions;
  relayfileAccessToken: string;
  relayfileUrl?: string;
  relayfileClient?: RelayfileExpansionClient;
  nangoSecretKey?: string;
  nangoBaseUrl?: string;
};

export type RelayfileResourceAtEvent = {
  path: string;
  data: unknown;
  digest?: string;
  url?: string;
};

type RelayfileChangeRecord = {
  eventId: string;
  path: string;
  timestamp?: string;
  type?: string;
  revision?: string;
  provider?: string;
};

type RelayfileExpansionClient = {
  getResourceAtEvent(
    eventId: string,
    options: { workspace: string; path: string },
  ): Promise<RelayfileResourceAtEvent>;
  listRecentChanges(
    workspace: string,
    options: { path: string; limit: number },
  ): Promise<RelayfileChangeRecord[]>;
  readResource(
    workspace: string,
    path: string,
  ): Promise<RelayfileResourceAtEvent>;
  queryResources(
    workspace: string,
    options: {
      path?: string;
      relation?: string;
      provider?: string;
      properties?: Record<string, string>;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: Array<{ path: string }>; nextCursor: string | null }>;
  writeResource?(
    workspace: string,
    resource: RelayfileResourceAtEvent,
  ): Promise<void>;
};

type AirtableFetchOnDemand = (
  event: AgentEvent,
  resource?: RelayfileResourceAtEvent,
) => Promise<RelayfileResourceAtEvent | void>;

type ThreadFetcher = (input: {
  client: RelayfileExpansionClient;
  workspace: string;
  event: AgentEvent;
  threadOptions?: ThreadExpansionOptions;
}) => Promise<ThreadExpansion>;

let airtableFetchOnDemand: AirtableFetchOnDemand | null = null;
const threadFetchers = new Map<string, ThreadFetcher>();

export function setAirtableFetchOnDemand(handler: AirtableFetchOnDemand): void {
  airtableFetchOnDemand = handler;
}

export function registerThreadFetcher(
  provider: string,
  fetcher: ThreadFetcher,
): void {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    throw new Error("provider is required");
  }
  threadFetchers.set(normalized, fetcher);
}

export async function expandGatewayEvent(
  input: GatewayExpandInput,
): Promise<GatewayExpandResult> {
  if (input.level === "summary") {
    return {
      level: "summary",
      path: input.event.resource.path,
      summary: cloneSummary(input.event.summary),
    } satisfies SummaryExpansion;
  }

  const client =
    input.relayfileClient
    ?? createRelayfileExpansionClient(input.relayfileAccessToken, input.relayfileUrl);

  if (input.level === "full") {
    const materializedAirtable = await maybeFetchAirtableOnDemand(input.event);
    if (materializedAirtable) {
      return {
        level: "full",
        path: materializedAirtable.path,
        data: materializedAirtable.data,
        ...(materializedAirtable.digest ? { digest: materializedAirtable.digest } : {}),
        ...(materializedAirtable.url ? { url: materializedAirtable.url } : {}),
      } satisfies FullExpansion<unknown> & { digest?: string; url?: string };
    }

    const fullResource = await getExpandedResourceAtEvent(
      client,
      input,
      input.event.id,
      input.event.resource.path,
    );
    return {
      level: "full",
      path: fullResource.path,
      data: fullResource.data,
      ...(fullResource.digest ? { digest: fullResource.digest } : {}),
      ...(fullResource.url ? { url: fullResource.url } : {}),
    } satisfies FullExpansion<unknown> & { digest?: string; url?: string };
  }

  if (input.level === "thread") {
    return await expandGatewayThread(client, input);
  }

  const current = await getExpandedResourceAtEvent(
    client,
    input,
    input.event.id,
    input.event.resource.path,
  );
  const recentChanges = await client.listRecentChanges(input.workspace, {
    path: input.event.resource.path,
    limit: MAX_CHANGE_LOOKBACK,
  });
  const previousChange = findPreviousChange(recentChanges, input.event);
  const previous = previousChange
    ? await getExpandedResourceAtEvent(
        client,
        input,
        previousChange.eventId,
        previousChange.path,
      )
    : null;
  const fieldsChanged = input.event.summary.fieldsChanged
    ?? diffObjectKeys(
      readRecord(current.data),
      readRecord(previous?.data),
      MAX_CHANGE_LOOKBACK,
    );

  return {
    level: "diff",
    path: current.path,
    diff: {
      current,
      previous,
      currentEventId: input.event.id,
      previousEventId: previousChange?.eventId ?? null,
      ...(fieldsChanged.length > 0 ? { fieldsChanged } : {}),
      changes: buildDiffChanges(
        readRecord(previous?.data),
        readRecord(current.data),
        fieldsChanged,
      ),
    },
  } satisfies DiffExpansion;
}

const DEFAULT_THREAD_LIMIT = 25;
const MAX_THREAD_LIMIT = 100;

async function expandGatewayThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const provider = input.event.resource.provider.trim().toLowerCase();
  const registeredFetcher = threadFetchers.get(provider);
  if (registeredFetcher) {
    return await registeredFetcher({
      client,
      workspace: input.workspace,
      event: input.event,
      threadOptions: input.threadOptions,
    });
  }

  switch (provider) {
    case "clickup":
      return await fetchClickUpThread(client, input);
    case "hubspot":
      return await fetchHubSpotThread(client, input);
    case "salesforce":
      return await fetchSalesforceThread(client, input);
    default:
      throw new FeatureNotImplementedError(
        "M3_NOT_IMPLEMENTED",
        `expand("thread") is not implemented yet for ${input.event.resource.path}`,
      );
  }
}

async function fetchLinearThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const issuePath = await resolveLinearIssuePath(client, input);
  if (!issuePath) {
    return emptyThreadExpansion();
  }

  const page = await client.queryResources(input.workspace, {
    provider: "linear",
    relation: issuePath,
    properties: { "linear.object_type": "comment" },
    cursor: input.threadOptions?.cursor,
    limit: normalizeThreadLimit(input.threadOptions?.limit),
  });

  return buildListedThreadExpansion(client, input.workspace, page);
}

async function fetchGitHubThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const prRoot = extractGitHubPullRequestRoot(input.event.resource.path);
  if (!prRoot) {
    return emptyThreadExpansion();
  }

  const page = await paginateUnionResources(
    client,
    input.workspace,
    [`${prRoot}/reviews`, `${prRoot}/comments`],
    input.threadOptions,
  );

  return await buildListedThreadExpansion(client, input.workspace, page);
}

async function fetchSlackThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const repliesPath = extractSlackRepliesPath(input.event.resource.path);
  if (!repliesPath) {
    return emptyThreadExpansion();
  }

  const page = await client.queryResources(input.workspace, {
    path: repliesPath,
    cursor: input.threadOptions?.cursor,
    limit: normalizeThreadLimit(input.threadOptions?.limit),
  });

  return await buildListedThreadExpansion(client, input.workspace, page);
}

async function fetchNotionThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const commentsPath = toNotionCommentsPath(input.event.resource.path);
  if (!commentsPath) {
    return emptyThreadExpansion();
  }

  const resource = await client.readResource(input.workspace, commentsPath);
  return buildArrayThreadExpansion(
    readArray(resource.data).map((item) => normalizeThreadItem(item)),
    input.threadOptions,
  );
}

async function fetchJiraThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const issueResource = await readJiraIssueResource(client, input);
  if (!issueResource) {
    return emptyThreadExpansion();
  }

  const issue = readRecord(issueResource.data);
  const fields = readRecord(issue?.fields);
  const commentBlock = readRecord(fields?.comment);
  const comments = readArray(commentBlock?.comments).map((item) => normalizeThreadItem(item));
  return buildArrayThreadExpansion(comments, input.threadOptions);
}

async function fetchAsanaThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const resource = await getExpandedResourceAtEvent(
    client,
    input,
    input.event.id,
    input.event.resource.path,
  );
  const record = readRecord(resource.data);
  const stories = readPossibleRecordArray(record?.stories)
    ?? readPossibleRecordArray(record?.story)
    ?? readPossibleRecordArray(record?.comments)
    ?? [];

  return buildArrayThreadExpansion(stories, input.threadOptions);
}

async function fetchZendeskThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const ticketResource = await readZendeskTicketResource(client, input);
  if (!ticketResource) {
    return emptyThreadExpansion();
  }

  const ticket = readRecord(ticketResource.data);
  const comments = readArray(ticket?.comments).map((item) => normalizeThreadItem(item));
  return buildArrayThreadExpansion(comments, input.threadOptions);
}

async function fetchClickUpThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const resource = await getExpandedResourceAtEvent(
    client,
    input,
    input.event.id,
    input.event.resource.path,
  );
  const record = readRecord(resource.data);
  const comments =
    readPossibleRecordArray(record?.comments)
    ?? readPossibleRecordArray(readRecord(record?.task)?.comments)
    ?? [];

  return buildArrayThreadExpansion(comments, input.threadOptions);
}

async function fetchHubSpotThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const resource = await getExpandedResourceAtEvent(
    client,
    input,
    input.event.id,
    input.event.resource.path,
  );
  const record = readRecord(resource.data);
  const engagements =
    readPossibleRecordArray(record?.engagements)
    ?? readPossibleRecordArray(readRecord(record?.timeline)?.engagements)
    ?? readPossibleRecordArray(record?.comments)
    ?? [];

  return buildArrayThreadExpansion(engagements, input.threadOptions);
}

async function fetchSalesforceThread(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<ThreadExpansion> {
  const resource = await getExpandedResourceAtEvent(
    client,
    input,
    input.event.id,
    input.event.resource.path,
  );
  const record = readRecord(resource.data);
  const chatterFeed =
    readPossibleRecordArray(record?.ChatterFeed)
    ?? readPossibleRecordArray(readRecord(record?.ChatterFeed)?.records)
    ?? readPossibleRecordArray(record?.FeedItems)
    ?? readPossibleRecordArray(record?.comments)
    ?? [];

  return buildArrayThreadExpansion(chatterFeed, input.threadOptions);
}

async function buildListedThreadExpansion(
  client: RelayfileExpansionClient,
  workspace: string,
  page: { items: Array<{ path: string }>; nextCursor: string | null },
): Promise<ThreadExpansion> {
  const items = await Promise.all(
    page.items.map(async (entry) => {
      const resource = await client.readResource(workspace, entry.path);
      return normalizeThreadItem(resource.data, entry.path);
    }),
  );

  return {
    level: "thread",
    items,
    hasMore: page.nextCursor !== null,
    ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
  } satisfies ThreadExpansion;
}

async function paginateUnionResources(
  client: RelayfileExpansionClient,
  workspace: string,
  paths: string[],
  options?: ThreadExpansionOptions,
): Promise<{ items: Array<{ path: string }>; nextCursor: string | null }> {
  const decoded = decodeOpaqueCursor(options?.cursor);
  const limit = normalizeThreadLimit(options?.limit);
  const items: Array<{ path: string }> = [];
  const startSource = readNumericCursorValue(decoded?.source) ?? 0;
  const startCursor = readStringValue(decoded?.cursor);

  for (let index = startSource; index < paths.length && items.length < limit; index += 1) {
    const page = await client.queryResources(workspace, {
      path: paths[index],
      cursor: index === startSource ? startCursor : undefined,
      limit: limit - items.length,
    });
    items.push(...page.items);

    if (page.nextCursor) {
      return {
        items,
        nextCursor: encodeOpaqueCursor({
          source: index,
          cursor: page.nextCursor,
        }),
      };
    }
  }

  return { items, nextCursor: null };
}

function buildArrayThreadExpansion(
  items: ThreadItem[],
  options?: ThreadExpansionOptions,
): ThreadExpansion {
  const limit = normalizeThreadLimit(options?.limit);
  const decoded = decodeOpaqueCursor(options?.cursor);
  const offset = readNumericCursorValue(decoded?.offset) ?? 0;
  const nextOffset = offset + limit;

  return {
    level: "thread",
    items: items.slice(offset, nextOffset),
    hasMore: nextOffset < items.length,
    ...(nextOffset < items.length
      ? { cursor: encodeOpaqueCursor({ offset: nextOffset }) }
      : {}),
  } satisfies ThreadExpansion;
}

function emptyThreadExpansion(): ThreadExpansion {
  return {
    level: "thread",
    items: [],
    hasMore: false,
  };
}

async function resolveLinearIssuePath(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<string | null> {
  if (/^\/linear\/issues\/[^/]+\.json$/u.test(input.event.resource.path)) {
    return input.event.resource.path;
  }

  const resource = await getExpandedResourceAtEvent(
    client,
    input,
    input.event.id,
    input.event.resource.path,
  );
  const comment = readRecord(resource.data);
  const issue = readRecord(comment?.issue);
  const issueId = readStringValue(issue?.id) ?? readStringValue(comment?.issue_id);
  if (!issueId) {
    return null;
  }

  const humanReadable =
    readStringValue(issue?.identifier)
    ?? readStringValue(issue?.title)
    ?? readStringValue(comment?.issue_identifier)
    ?? readStringValue(comment?.issue_title);
  return buildLinearIssuePath(issueId, humanReadable);
}

function buildLinearIssuePath(issueId: string, humanReadable?: string): string {
  const encodedId = encodeURIComponent(issueId);
  const normalizedHumanReadable = humanReadable?.trim();
  if (!normalizedHumanReadable) {
    return `/linear/issues/${encodedId}.json`;
  }

  const slug = /^[A-Z][A-Z0-9]+-\d+$/u.test(normalizedHumanReadable)
    ? normalizedHumanReadable
    : slugifyPathSegment(normalizedHumanReadable);
  return slug
    ? `/linear/issues/${slug}__${encodedId}.json`
    : `/linear/issues/${encodedId}.json`;
}

function extractGitHubPullRequestRoot(path: string): string | null {
  const match = path.match(/^(.+\/pulls\/[^/]+)(?:\/meta\.json|\/reviews\/[^/]+\.json|\/comments\/[^/]+\.json)$/u);
  return match?.[1] ?? null;
}

function extractSlackRepliesPath(path: string): string | null {
  if (/^\/slack\/channels\/[^/]+\/threads\/[^/]+\/meta\.json$/u.test(path)) {
    return path.replace(/\/meta\.json$/u, "/replies");
  }

  const match = path.match(/^(\/slack\/channels\/[^/]+\/threads\/[^/]+)\/replies\/[^/]+\.json$/u);
  return match?.[1] ? `${match[1]}/replies` : null;
}

function toNotionCommentsPath(path: string): string | null {
  if (/\/comments\.json$/u.test(path)) {
    return path;
  }
  if (/\/content\.md$/u.test(path)) {
    return path.replace(/\/content\.md$/u, "/comments.json");
  }
  if (/\.json$/u.test(path) && /\/notion\/(?:databases\/[^/]+\/pages|pages)\//u.test(path)) {
    return path.replace(/\.json$/u, "/comments.json");
  }
  return null;
}

async function readJiraIssueResource(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<RelayfileResourceAtEvent | null> {
  if (/^\/jira\/issues\/[^/]+\.json$/u.test(input.event.resource.path)) {
    return await getExpandedResourceAtEvent(
      client,
      input,
      input.event.id,
      input.event.resource.path,
    );
  }

  const match = input.event.resource.path.match(/^\/jira\/issues\/([^/]+)\/comments\/[^/]+\.json$/u);
  return match?.[1]
    ? await client.readResource(input.workspace, `/jira/issues/${match[1]}.json`)
    : null;
}

async function readZendeskTicketResource(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
): Promise<RelayfileResourceAtEvent | null> {
  if (/^\/zendesk\/tickets\/[^/]+\.json$/u.test(input.event.resource.path)) {
    return await getExpandedResourceAtEvent(
      client,
      input,
      input.event.id,
      input.event.resource.path,
    );
  }

  const match = input.event.resource.path.match(/^\/zendesk\/tickets\/([^/]+)\/comments\/[^/]+\.json$/u);
  return match?.[1]
    ? await client.readResource(input.workspace, `/zendesk/tickets/${match[1]}.json`)
    : null;
}

function normalizeThreadLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_THREAD_LIMIT;
  }

  const normalized = Math.trunc(limit);
  if (normalized < 1) {
    return DEFAULT_THREAD_LIMIT;
  }

  return Math.min(normalized, MAX_THREAD_LIMIT);
}

function normalizeThreadItem(
  value: unknown,
  path?: string,
): ThreadItem {
  const record = readRecord(value);
  const id =
    readStringValue(record?.id)
    ?? readStringValue(record?.gid)
    ?? readStringValue(record?.uuid)
    ?? readStringValue(readRecord(record?.message)?.id)
    ?? path
    ?? "thread-item";
  const author = normalizeThreadAuthor(record);
  const body = redactThreadText(
    readBodyText(record)
    ?? readStringValue(readRecord(record?.message)?.text)
    ?? readStringValue(readRecord(record?.comment)?.body)
    ?? "",
  );
  const createdAt =
    normalizeTimestamp(
      readStringValue(record?.createdAt)
      ?? readStringValue(record?.created_at)
      ?? readStringValue(record?.createdDate)
      ?? readStringValue(record?.created)
      ?? readStringValue(record?.ts)
      ?? readStringValue(record?.timestamp)
      ?? readStringValue(record?.date)
      ?? readStringValue(readRecord(record?.message)?.createdAt)
      ?? readStringValue(readRecord(record?.message)?.created_at),
    )
    ?? "1970-01-01T00:00:00.000Z";

  return {
    id,
    author,
    createdAt,
    body,
    kind: inferThreadItemKind(record, path, body),
  };
}

function readPossibleRecordArray(value: unknown): ThreadItem[] | undefined {
  const record = readRecord(value);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeThreadItem(item));
  }
  if (record && Array.isArray(record.data)) {
    return record.data.map((item) => normalizeThreadItem(item));
  }
  return undefined;
}

function normalizeThreadAuthor(
  record: Record<string, unknown> | undefined,
): ThreadItem["author"] {
  const candidate =
    readRecord(record?.author)
    ?? readRecord(record?.user)
    ?? readRecord(record?.actor)
    ?? readRecord(record?.from)
    ?? readRecord(record?.created_by)
    ?? readRecord(record?.createdBy)
    ?? readRecord(record?.CreatedBy)
    ?? readRecord(readRecord(record?.message)?.author)
    ?? readRecord(readRecord(record?.message)?.from)
    ?? readRecord(readRecord(record?.message)?.user)
    ?? record;

  const id =
    readStringValue(candidate?.id)
    ?? readStringValue(candidate?.gid)
    ?? readStringValue(candidate?.user_id)
    ?? readStringValue(candidate?.agentId)
    ?? readStringValue(candidate?.agent_id)
    ?? readStringValue(candidate?.accountId)
    ?? readStringValue(candidate?.Id)
    ?? "unknown";
  const displayName = redactThreadText(
    readStringValue(candidate?.displayName)
    ?? readStringValue(candidate?.display_name)
    ?? readStringValue(candidate?.DisplayName)
    ?? readStringValue(candidate?.name)
    ?? readStringValue(candidate?.agentName)
    ?? readStringValue(candidate?.agent_name)
    ?? readStringValue(candidate?.Name)
    ?? id,
  ) || id;

  return { id, displayName };
}

function readBodyText(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }

  const direct =
    readStringValue(record.body)
    ?? readStringValue(record.text)
    ?? readStringValue(record.plain_text)
    ?? readStringValue(record.plainText)
    ?? readStringValue(record.html_body)
    ?? readStringValue(record.htmlBody)
    ?? readStringValue(record.rich_text)
    ?? readStringValue(record.richText)
    ?? readStringValue(record.comment_text)
    ?? readStringValue(record.description)
    ?? readStringValue(record.note);
  if (direct) {
    return direct;
  }

  const textArray = readArray(record.rich_text) ?? readArray(record.richText);
  if (textArray && textArray.length > 0) {
    return textArray
      .map((entry) => {
        const item = readRecord(entry);
        return (
          readStringValue(item?.plain_text)
          ?? readStringValue(item?.text)
          ?? readStringValue(item?.content)
          ?? ""
        );
      })
      .join(" ")
      .trim();
  }

  return undefined;
}

function inferThreadItemKind(
  record: Record<string, unknown> | undefined,
  path: string | undefined,
  body: string,
): ThreadItem["kind"] {
  const explicit =
    readStringValue(record?.kind)
    ?? readStringValue(record?.type)
    ?? readStringValue(record?.resource_subtype)
    ?? readStringValue(readRecord(record?.message)?.type);
  if (explicit === "reply" || explicit === "thread_reply") {
    return "reply";
  }
  if (explicit === "system" || explicit === "story") {
    return body ? "comment" : "system";
  }
  if (explicit === "comment" || explicit === "note") {
    return "comment";
  }
  if (path?.includes("/replies/")) {
    return "reply";
  }
  return body ? "comment" : "system";
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function redactThreadText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-number]")
    .replace(/\b\d{9,}\b/g, "[redacted-number]")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyPathSegment(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]+/g, "");
  return ascii
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function encodeOpaqueCursor(value: Record<string, unknown>): string {
  return base64UrlEncode(JSON.stringify(value));
}

function decodeOpaqueCursor(cursor: string | undefined): Record<string, unknown> | null {
  if (!cursor?.trim()) {
    return null;
  }

  try {
    const decoded = JSON.parse(base64UrlDecode(cursor.trim())) as unknown;
    return readRecord(decoded) ?? null;
  } catch {
    return null;
  }
}

function readNumericCursorValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined;
  }
  return undefined;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function createRelayfileExpansionClient(
  relayfileAccessToken: string,
  relayfileUrl?: string,
): RelayfileExpansionClient {
  const client = new RelayFileClient({
    baseUrl: normalizeRelayfileUrl(relayfileUrl),
    token: relayfileAccessToken,
    readCache: {},
  }) as RelayFileClient & {
    getResourceAtEvent?: (
      eventId: string,
    ) => Promise<RelayfileResourceAtEvent>;
    listLastNChanges?: (
      limit: number,
      options?: { workspace?: string },
    ) => Promise<
      { events?: unknown[] }
      | unknown[]
    >;
  };

  return {
    async getResourceAtEvent(eventId, options) {
      if (typeof client.getResourceAtEvent === "function") {
        try {
          const resource = await client.getResourceAtEvent(eventId);
          return {
            path: resource.path,
            data: resource.data,
            ...(resource.digest ? { digest: resource.digest } : {}),
            ...(resource.url ? { url: resource.url } : {}),
          };
        } catch (error) {
          // The proactive-runtime `/events/{id}/resource` endpoint requires a
          // workspace-scoped JWT with a `workspace_id` claim. Agent tokens
          // minted by the gateway are workspace-scoped but the `@relayfile/sdk`
          // client may still reject them when the runtime guard does not
          // surface the claim (or the caller passes a non-JWT, as the
          // data-trigger e2e tests do). Fall back to the file-read flow that
          // the workspace-scoped agent token already authorizes — this also
          // produces the canonical `url:` we want to surface to consumers of
          // `event.expand("full")`.
          if (!isWorkspaceClaimError(error)) {
            throw error;
          }
        }
      }

      const file = await client.readFile(options.workspace, options.path);
      const digest = readFileDigest(file);
      return {
        path: file.path,
        data: parseRelayfileContent(file),
        ...(digest ? { digest } : {}),
        url: buildRelayfileFileUrl(normalizeRelayfileUrl(relayfileUrl), options.workspace, file.path),
      };
    },
    async listRecentChanges(workspace, options) {
      if (typeof client.listLastNChanges === "function") {
        const response = await client.listLastNChanges(options.limit, { workspace });
        const events = normalizeRetainedChanges(
          Array.isArray(response) ? response : response.events ?? [],
        );
        return events.filter((event) => event.path === options.path);
      }

      const response = await client.getEvents(workspace, {
        limit: options.limit,
      });
      return normalizeEventFeed(response).filter((event) => event.path === options.path);
    },
    async readResource(workspace, path) {
      const file = await client.readFile(workspace, path);
      const digest = readFileDigest(file);
      return {
        path: file.path,
        data: parseRelayfileContent(file),
        ...(digest ? { digest } : {}),
        url: buildRelayfileFileUrl(normalizeRelayfileUrl(relayfileUrl), workspace, file.path),
      };
    },
    async queryResources(workspace, options) {
      const response = await client.queryFiles(workspace, {
        ...(options.path ? { path: options.path } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.relation ? { relation: options.relation } : {}),
        ...(options.properties ? { properties: options.properties } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      });

      return normalizeFileQueryResponse(response);
    },
    async writeResource(workspace, resource) {
      await client.writeFile({
        workspaceId: workspace,
        path: resource.path,
        baseRevision: "*",
        content: JSON.stringify(resource.data, null, 2),
        contentType: "application/json",
      });
    },
  };
}

function normalizeFileQueryResponse(
  response: FileQueryResponse,
): { items: Array<{ path: string }>; nextCursor: string | null } {
  return {
    items: (response.items ?? [])
      .map((item) => ({ path: item.path }))
      .filter((item) => isCanonicalThreadFile(item.path)),
    nextCursor: response.nextCursor ?? null,
  };
}

function isCanonicalThreadFile(path: string): boolean {
  return path.endsWith(".json") && !path.endsWith("/_index.json") && !path.endsWith("/meta.json");
}

function findPreviousChange(
  changes: RelayfileChangeRecord[],
  event: AgentEvent,
): RelayfileChangeRecord | null {
  const currentIndex = changes.findIndex((entry) => entry.eventId === event.id);
  if (currentIndex >= 0) {
    return changes
      .slice(currentIndex + 1)
      .find((entry) => entry.path === event.resource.path)
      ?? null;
  }

  return changes.find((entry) => entry.eventId !== event.id && entry.path === event.resource.path) ?? null;
}

async function getExpandedResourceAtEvent(
  client: RelayfileExpansionClient,
  input: GatewayExpandInput,
  eventId: string,
  path: string,
): Promise<RelayfileResourceAtEvent> {
  const resource = await client.getResourceAtEvent(eventId, {
    workspace: input.workspace,
    path,
  });
  const maybeMaterializedResource = await maybeMaterializeAirtableNotification(
    resource,
    {
      ...input,
      event: {
        ...input.event,
        id: eventId,
        resource: {
          ...input.event.resource,
          path,
        },
      },
    },
    client,
  );
  return maybeMaterializedResource ?? resource;
}

function normalizeEventFeed(response: EventFeedResponse): RelayfileChangeRecord[] {
  return (response.events ?? []).map((event) => ({
    eventId: event.eventId,
    path: event.path,
    timestamp: event.timestamp,
    type: event.type,
    revision: event.revision,
    provider: event.provider,
  }));
}

function normalizeRetainedChanges(events: unknown[]): RelayfileChangeRecord[] {
  return events
    .map((event) => normalizeRetainedChange(event))
    .filter((event): event is RelayfileChangeRecord => Boolean(event));
}

function normalizeRetainedChange(event: unknown): RelayfileChangeRecord | null {
  const record = readRecord(event);
  if (!record) {
    return null;
  }

  const resource = readRecord(record.resource);
  const eventId = readStringValue(record.eventId) ?? readStringValue(record.id);
  const path = readStringValue(record.path) ?? readStringValue(resource?.path);
  if (!eventId || !path) {
    return null;
  }

  return {
    eventId,
    path,
    timestamp: readStringValue(record.timestamp) ?? readStringValue(record.occurredAt),
    type: readStringValue(record.type),
    revision: readStringValue(record.revision),
    provider: readStringValue(record.provider) ?? readStringValue(resource?.provider),
  };
}

function parseRelayfileContent(file: FileReadResponse): unknown {
  if (looksLikeJson(file.contentType)) {
    try {
      return JSON.parse(file.content);
    } catch {
      return file.content;
    }
  }

  return file.content;
}

function readFileDigest(file: FileReadResponse): string | undefined {
  const extended = file as FileReadResponse & { contentHash?: string };
  return extended.contentHash?.trim() || undefined;
}

/**
 * The `@relayfile/sdk` proactive-runtime endpoints (e.g. `getResourceAtEvent`)
 * require the caller's JWT to carry a `workspace_id` claim. Agent tokens minted
 * through the gateway are workspace-scoped, but the SDK guard surfaces this
 * specific error message when a non-JWT or claim-less token is supplied —
 * notably in the agent-gateway e2e tests that mock the relayfile boundary.
 * When we hit that guard we transparently fall back to the workspace-scoped
 * `readFile` path, which produces an equivalent shape (plus the canonical
 * `url:` we surface to consumers of `event.expand("full")`).
 */
function isWorkspaceClaimError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /workspace-scoped JWT|workspace_id claim/i.test(error.message);
}

function normalizeRelayfileUrl(relayfileUrl?: string): string {
  const trimmed = relayfileUrl?.trim();
  if (!trimmed) {
    return DEFAULT_RELAYFILE_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function buildRelayfileFileUrl(
  relayfileUrl: string,
  workspace: string,
  path: string,
): string {
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(workspace)}/fs/file`,
    `${relayfileUrl}/`,
  );
  url.searchParams.set("path", path);
  return url.toString();
}

function looksLikeJson(contentType: string | undefined): boolean {
  return typeof contentType === "string" && /json/i.test(contentType);
}

async function maybeFetchAirtableOnDemand(
  event: AgentEvent,
  resource?: RelayfileResourceAtEvent,
): Promise<RelayfileResourceAtEvent | undefined> {
  if (event.resource.provider !== "airtable" || !airtableFetchOnDemand) {
    return undefined;
  }
  const materialized = await airtableFetchOnDemand(event, resource);
  return materialized ?? undefined;
}

async function maybeMaterializeAirtableNotification(
  resource: RelayfileResourceAtEvent,
  input: GatewayExpandInput,
  client: RelayfileExpansionClient,
): Promise<RelayfileResourceAtEvent | undefined> {
  if (
    input.event.resource.provider !== "airtable"
    || !input.nangoSecretKey?.trim()
    || !isAirtableNotificationPath(input.event.resource.path)
  ) {
    return undefined;
  }

  const notification = readAirtableNotification(resource.data, input.event.resource.path);
  if (!notification.connectionId) {
    throw new Error(
      `Airtable full expansion for ${input.event.resource.path} requires a connectionId in the stored notification payload`,
    );
  }

  const endpoint = `/v0/bases/${encodeURIComponent(notification.baseId)}/webhooks/${encodeURIComponent(notification.webhookId)}/payloads`;
  const payloads: Record<string, unknown>[] = [];
  let cursor = notification.cursor;
  let lastPage: Record<string, unknown> = {};

  while (true) {
    const response = await proxyThroughNango<Record<string, unknown>>({
      secretKey: input.nangoSecretKey.trim(),
      baseUrl: input.nangoBaseUrl,
      method: "GET",
      connectionId: notification.connectionId,
      endpoint,
      providerConfigKey: notification.providerConfigKey ?? "airtable",
      ...(cursor !== undefined ? { query: { cursor: String(cursor) } } : {}),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Airtable webhook payload materialization failed with ${response.status}`);
    }

    const page = readRecord(response.data);
    if (!page) {
      throw new Error("Airtable webhook payload materialization must return a JSON object");
    }

    lastPage = page;
    payloads.push(
      ...readArray(page.payloads)
        .map((entry) => readRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry)),
    );

    const nextCursor = readCursor(page.cursor);
    const mightHaveMore = page.mightHaveMore === true;
    if (!mightHaveMore || nextCursor === undefined || nextCursor === cursor) {
      cursor = nextCursor;
      break;
    }
    cursor = nextCursor;
  }

  const materializedResource = {
    path: resource.path,
    data: {
      baseId: notification.baseId,
      webhookId: notification.webhookId,
      notificationId: notification.notificationId ?? notification.webhookId,
      endpoint,
      path: resource.path,
      payloads,
      data: lastPage,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(typeof lastPage.mightHaveMore === "boolean" ? { mightHaveMore: lastPage.mightHaveMore } : {}),
      ...(readStringValue(lastPage.payloadFormat) ? { payloadFormat: readStringValue(lastPage.payloadFormat) } : {}),
    },
    ...(resource.url ? { url: resource.url } : {}),
  };
  await cacheAirtableMaterializedPayload(client, input.workspace, materializedResource);
  return materializedResource;
}

function isAirtableNotificationPath(path: string): boolean {
  return /^\/airtable\/bases\/[^/]+\/_notifications\/[^/]+\.json$/i.test(path);
}

function readAirtableNotification(
  value: unknown,
  path: string,
): {
  baseId: string;
  webhookId: string;
  notificationId?: string;
  connectionId?: string;
  providerConfigKey?: string;
  cursor?: number;
} {
  const record = readRecord(value) ?? {};
  const [, baseId = "", webhookId = ""] =
    path.match(/^\/airtable\/bases\/([^/]+)\/_notifications\/([^/]+)\.json$/i) ?? [];
  const decodedBaseId = decodeURIComponent(baseId);
  const decodedWebhookId = decodeURIComponent(webhookId);

  return {
    baseId: readStringValue(record.baseId) ?? readStringValue(record.base_id) ?? decodedBaseId,
    webhookId:
      readStringValue(record.webhookId)
      ?? readStringValue(record.webhook_id)
      ?? readStringValue(readRecord(record.webhook)?.id)
      ?? readStringValue(record.id)
      ?? decodedWebhookId,
    notificationId:
      readStringValue(record.notificationId)
      ?? readStringValue(record.notification_id),
    connectionId:
      readStringValue(record.connectionId)
      ?? readStringValue(readRecord(record.metadata)?.connectionId)
      ?? readStringValue(readRecord(record._webhook)?.connectionId),
    providerConfigKey:
      readStringValue(record.providerConfigKey)
      ?? readStringValue(readRecord(record.metadata)?.providerConfigKey)
      ?? readStringValue(readRecord(record._webhook)?.providerConfigKey),
    cursor: readCursor(record.cursor),
  };
}

function readCursor(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cloneSummary(summary: AgentEvent["summary"]): AgentEvent["summary"] {
  return {
    ...(summary.title ? { title: summary.title } : {}),
    ...(summary.status ? { status: summary.status } : {}),
    ...(summary.priority ? { priority: summary.priority } : {}),
    ...(summary.actor ? { actor: { ...summary.actor } } : {}),
    ...(summary.labels ? { labels: [...summary.labels] } : {}),
    ...(summary.fieldsChanged ? { fieldsChanged: [...summary.fieldsChanged] } : {}),
    ...(summary.tags ? { tags: [...summary.tags] } : {}),
  };
}

function diffObjectKeys(
  current: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  limit: number,
): string[] {
  if (!current && !previous) {
    return [];
  }
  const keys = new Set<string>([
    ...Object.keys(previous ?? {}),
    ...Object.keys(current ?? {}),
  ]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(current?.[key]) === JSON.stringify(previous?.[key])) {
      continue;
    }
    changed.push(key);
    if (changed.length >= limit) {
      break;
    }
  }
  return changed;
}

function buildDiffChanges(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined,
  fieldsChanged: string[],
): Record<string, { previous: unknown; current: unknown }> {
  const changes: Record<string, { previous: unknown; current: unknown }> = {};
  for (const field of fieldsChanged) {
    changes[field] = {
      previous: previous?.[field],
      current: current?.[field],
    };
  }
  return changes;
}

async function cacheAirtableMaterializedPayload(
  client: RelayfileExpansionClient,
  workspace: string,
  resource: RelayfileResourceAtEvent,
): Promise<void> {
  if (!client.writeResource) {
    return;
  }

  await client.writeResource(workspace, resource);
  const payload = readRecord(resource.data);
  const baseId = readStringValue(payload?.baseId);
  if (!payload || !baseId) {
    return;
  }

  for (const page of readArray(payload.payloads)) {
    const pageRecord = readRecord(page);
    const changedTablesById = readRecord(pageRecord?.changedTablesById);
    if (!changedTablesById) {
      continue;
    }
    for (const [tableId, tableValue] of Object.entries(changedTablesById)) {
      const changedRecordsById = readRecord(readRecord(tableValue)?.changedRecordsById);
      if (!changedRecordsById) {
        continue;
      }
      for (const [recordId, recordValue] of Object.entries(changedRecordsById)) {
        const current = readRecord(readRecord(recordValue)?.current);
        if (!current) {
          continue;
        }
        await client.writeResource(workspace, {
          path: airtableRecordPath(baseId, tableId, recordId),
          data: current,
        });
      }
    }
  }
}

function airtableRecordPath(baseId: string, tableId: string, recordId: string): string {
  return `/airtable/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}.json`;
}

async function proxyThroughNango<T>(input: {
  secretKey: string;
  baseUrl?: string;
  providerConfigKey: string;
  connectionId: string;
  method: string;
  endpoint: string;
  query?: Record<string, string>;
}): Promise<{ status: number; headers: Record<string, string>; data: T | null }> {
  const url = new URL("/proxy", `${normalizeNangoBaseUrl(input.baseUrl)}/`);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.secretKey}`,
      "connection-id": input.connectionId,
      "content-type": "application/json",
      "provider-config-key": input.providerConfigKey,
    },
    body: JSON.stringify({
      method: input.method,
      endpoint: normalizeNangoEndpoint(input.endpoint),
      ...(input.query && Object.keys(input.query).length > 0
        ? { params: input.query }
        : {}),
    }),
  });
  const headers = Object.fromEntries(response.headers.entries());
  const rawBody = await response.text();
  if (!rawBody) {
    return {
      status: response.status,
      headers,
      data: null,
    };
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/json/i.test(contentType)) {
    return {
      status: response.status,
      headers,
      data: rawBody as T,
    };
  }
  try {
    return {
      status: response.status,
      headers,
      data: JSON.parse(rawBody) as T,
    };
  } catch {
    return {
      status: response.status,
      headers,
      data: rawBody as T,
    };
  }
}

function normalizeNangoBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || "https://api.nango.dev").replace(/\/+$/, "");
}

function normalizeNangoEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function registerBuiltinThreadFetchers(): void {
  registerThreadFetcher("linear", fetchLinearAdapterThread);
  registerThreadFetcher("github", fetchGitHubAdapterThread);
  registerThreadFetcher("slack", fetchSlackAdapterThread);
  registerThreadFetcher("notion", fetchNotionAdapterThread);
  registerThreadFetcher("jira", fetchJiraAdapterThread);
  registerThreadFetcher("asana", fetchAsanaAdapterThread);
  registerThreadFetcher("zendesk", fetchZendeskAdapterThread);
}

registerBuiltinThreadFetchers();
