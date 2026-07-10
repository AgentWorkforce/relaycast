import type {
  NotionEnumerationType,
  NotionLibrarianOptions,
} from "@agent-assistant/specialists";
import type { VfsEntry } from "@agent-assistant/vfs";
import {
  NOTION_PROVIDER_NAME,
  richTextToPlainText,
  serializePropertyValue,
} from "@relayfile/adapter-notion";
import type {
  NotionPageProperty,
  NotionRichText,
  SerializedPropertyValue,
} from "@relayfile/adapter-notion";

export interface NotionIntegration {
  listPages?: (options?: NotionPageListOptions) => Promise<unknown>;
  searchPages?: (query: string, options?: NotionSearchOptions) => Promise<unknown>;
  listDatabases?: (options?: NotionListOptions) => Promise<unknown>;
  searchDatabases?: (query: string, options?: NotionSearchOptions) => Promise<unknown>;
  listBlocks?: (pageId: string, options?: NotionBlockListOptions) => Promise<unknown>;
  searchBlocks?: (query: string, options?: NotionBlockSearchOptions) => Promise<unknown>;
}

const LOG_PREFIX = "[specialist/api-fallback]";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SUPPORTED_TYPES = ["page", "database", "block"] as const;

type SupportedNotionEnumerationType = (typeof SUPPORTED_TYPES)[number];
// Narrow the upstream union to the function-call variant. The agent-assistant
// LibrarianApiFallback<T> type accepts EITHER `(req) => Promise<entries>` OR
// `{ list?, search? }`, but every cloud-side fallback (github + linear +
// notion) implements the function variant, and tests need a concrete callable
// type to invoke without an `as` cast. Same narrowing as linear-api-fallback.ts.
type NotionLibrarianApiFallback = Extract<
  NonNullable<NotionLibrarianOptions["apiFallback"]>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (...args: any[]) => unknown
>;
type JsonObject = Record<string, unknown>;
type WrappedResult<T> = { data: T; summary?: string; source?: string; timestamp?: string } | T;
type FallbackVfsEntry = VfsEntry & {
  content: string;
  contentType: "application/json";
};
type SerializedNotionProperty = SerializedPropertyValue | null;

interface NotionPageListOptions extends NotionListOptions {
  database?: string;
  query?: string;
}

interface NotionListOptions {
  limit?: number;
}

interface NotionSearchOptions extends NotionListOptions {
  database?: string;
  pageId?: string;
  parentId?: string;
}

interface NotionBlockListOptions extends NotionListOptions {
  pageId?: string;
}

interface NotionBlockSearchOptions extends NotionSearchOptions {
  pageId?: string;
}

interface LoadContext {
  filters: Record<string, string[]>;
  limit: number;
}

interface NotionParentHint {
  pageId?: string;
  pageTitle?: string;
  databaseId?: string;
  databaseTitle?: string;
}

interface NotionPageRef {
  id: string;
  title?: string;
  databaseId?: string;
  databaseTitle?: string;
}

export function createNotionLibrarianApiFallback(
  notion: NotionIntegration,
): NotionLibrarianApiFallback {
  return async (request: unknown): Promise<readonly FallbackVfsEntry[]> => {
    const filters = filtersFromRequest(request);
    const types = typesFromRequest(request, filters);
    const limit = limitFromRequest(request);

    logInvocation("notion librarian fallback invoked", {
      types,
      filterKeys: Object.keys(filters).sort(),
      limit,
    });

    try {
      const context: LoadContext = { filters, limit };
      const entries: FallbackVfsEntry[] = [];

      for (const type of types) {
        entries.push(...(await loadEnumerationType(notion, type, context)));
        if (entries.length >= limit) {
          break;
        }
      }

      return dedupeEntries(entries).slice(0, limit);
    } catch (error) {
      logFailure("notion librarian fallback failed", error);
      return [];
    }
  };
}

async function loadEnumerationType(
  notion: NotionIntegration,
  type: SupportedNotionEnumerationType,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  switch (type) {
    case "database":
      return loadDatabaseEntries(notion, context);
    case "page":
      return loadPageEntries(notion, context);
    case "block":
      return loadBlockEntries(notion, context);
  }
}

async function loadDatabaseEntries(
  notion: NotionIntegration,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  const entries: FallbackVfsEntry[] = [];

  if (notion.searchDatabases) {
    const searchDatabases = notion.searchDatabases;
    const queries = databaseSearchQueries(context.filters);
    for (const query of queries) {
      const result = await safeNotionCall(`search databases for ${query}`, () =>
        searchDatabases(query, { limit: context.limit }),
      );

      for (const item of recordsFromResult(result)) {
        const entry = toNotionEntry("database", item);
        if (entry) {
          entries.push(entry);
        }
      }

      if (entries.length >= context.limit) {
        return dedupeEntries(entries).slice(0, context.limit);
      }
    }
  }

  if (!notion.listDatabases) {
    return dedupeEntries(entries).slice(0, context.limit);
  }

  const listDatabases = notion.listDatabases;
  const result = await safeNotionCall("list databases", () =>
    listDatabases({ limit: context.limit }),
  );
  for (const item of recordsFromResult(result)) {
    const entry = toNotionEntry("database", item);
    if (entry) {
      entries.push(entry);
    }
  }

  return dedupeEntries(entries).slice(0, context.limit);
}

async function loadPageEntries(
  notion: NotionIntegration,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  const pages = await loadPageRecords(notion, context);
  const entries: FallbackVfsEntry[] = [];

  for (const page of pages) {
    const entry = toNotionEntry("page", page);
    if (entry) {
      entries.push(entry);
    }
    if (entries.length >= context.limit) {
      break;
    }
  }

  return dedupeEntries(entries).slice(0, context.limit);
}

async function loadBlockEntries(
  notion: NotionIntegration,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  const entries: FallbackVfsEntry[] = [];

  const pageHints = await resolveBlockPageHints(notion, context);
  if (pageHints.length > 0 && notion.listBlocks) {
    const listBlocks = notion.listBlocks;
    for (const hint of pageHints) {
      const result = await safeNotionCall(`list blocks for page ${hint.id}`, () =>
        listBlocks(hint.id, { limit: context.limit, pageId: hint.id }),
      );

      for (const item of recordsFromResult(result)) {
        const entry = toNotionEntry("block", item, {
          pageId: hint.id,
          pageTitle: hint.title,
          databaseId: hint.databaseId,
          databaseTitle: hint.databaseTitle,
        });
        if (entry) {
          entries.push(entry);
        }
      }

      if (entries.length >= context.limit) {
        return dedupeEntries(entries).slice(0, context.limit);
      }
    }
  }

  if (entries.length > 0 || !notion.searchBlocks) {
    return dedupeEntries(entries).slice(0, context.limit);
  }

  const searchBlocks = notion.searchBlocks;
  for (const query of blockSearchQueries(context.filters)) {
    const result = await safeNotionCall(`search blocks for ${query}`, () =>
      searchBlocks(query, { limit: context.limit }),
    );

    for (const item of recordsFromResult(result)) {
      const entry = toNotionEntry("block", item);
      if (entry) {
        entries.push(entry);
      }
    }

    if (entries.length >= context.limit) {
      break;
    }
  }

  return dedupeEntries(entries).slice(0, context.limit);
}

async function loadPageRecords(
  notion: NotionIntegration,
  context: LoadContext,
): Promise<JsonObject[]> {
  const entries: JsonObject[] = [];
  const titleQuery = firstFilterValue(context.filters, "title");
  const databaseFilters = context.filters.database ?? [];

  if (databaseFilters.length > 0 && notion.listPages) {
    const listPages = notion.listPages;
    for (const database of databaseFilters) {
      const result = await safeNotionCall(`list pages for database ${database}`, () =>
        listPages({
          database,
          limit: context.limit,
          ...(titleQuery ? { query: titleQuery } : {}),
        }),
      );
      entries.push(...recordsFromResult(result));
      if (entries.length >= context.limit) {
        return dedupeRecordsById(entries).slice(0, context.limit);
      }
    }
    return dedupeRecordsById(entries).slice(0, context.limit);
  }

  const queries = pageSearchQueries(context.filters);
  if (queries.length > 0 && notion.searchPages) {
    const searchPages = notion.searchPages;
    for (const query of queries) {
      const result = await safeNotionCall(`search pages for ${query}`, () =>
        searchPages(query, { limit: context.limit }),
      );
      entries.push(...recordsFromResult(result));
      if (entries.length >= context.limit) {
        return dedupeRecordsById(entries).slice(0, context.limit);
      }
    }
    return dedupeRecordsById(entries).slice(0, context.limit);
  }

  if (!notion.listPages) {
    return [];
  }

  const listPages = notion.listPages;
  const result = await safeNotionCall("list pages", () =>
    listPages({
      limit: context.limit,
      ...(titleQuery ? { query: titleQuery } : {}),
    }),
  );
  entries.push(...recordsFromResult(result));

  return dedupeRecordsById(entries).slice(0, context.limit);
}

async function resolveBlockPageHints(
  notion: NotionIntegration,
  context: LoadContext,
): Promise<NotionPageRef[]> {
  const explicitPageIds = [
    ...(context.filters.page ?? []),
    ...(context.filters.pageId ?? []),
    ...(context.filters.parent ?? []),
    ...(context.filters.parentId ?? []),
  ]
    .map(extractIdentifier)
    .filter(isDefined);

  if (explicitPageIds.length > 0) {
    return dedupePageRefs(explicitPageIds.map((id) => ({ id })));
  }

  const pageRecords = await loadPageRecords(notion, context);
  return dedupePageRefs(
    pageRecords
      .map(pageRefFromRecord)
      .filter(isDefined),
  ).slice(0, context.limit);
}

function pageRefFromRecord(item: JsonObject): NotionPageRef | null {
  const id = notionObjectId(item);
  if (!id) {
    return null;
  }

  const parentInfo = parentInfoFromValue(item.parent);
  return {
    id,
    title: titleFromNotionRecord("page", item),
    databaseId: parentInfo.databaseId,
    databaseTitle: parentInfo.databaseTitle,
  };
}

function toNotionEntry(
  type: SupportedNotionEnumerationType,
  item: JsonObject,
  hint?: NotionParentHint,
): FallbackVfsEntry | null {
  const id = notionObjectId(item);
  if (!id) {
    return null;
  }

  const title = titleFromNotionRecord(type, item) ?? `${capitalize(type)} ${id}`;
  const url = firstString(item.url, item.public_url);
  const createdAt = firstString(item.created_time, item.createdAt);
  const lastEditedAt = firstString(
    item.last_edited_time,
    item.lastEditedTime,
    item.updated_at,
    item.updatedAt,
  );
  const createdBy = userNameFromValue(item.created_by, item.createdBy);
  const lastEditedBy = userNameFromValue(item.last_edited_by, item.lastEditedBy, item.author);
  const author = firstString(authorPropertyFromRecord(item), lastEditedBy, createdBy);
  const tags = tagsFromRecord(item);
  const parentInfo = mergeParentInfo(parentInfoFromValue(item.parent), hint);
  const path = notionPath(type, id);
  const content = safeStringify({
    type,
    id,
    title,
    url,
    createdAt,
    lastEditedAt,
    author,
    tags,
    parent: parentInfo.parent,
    parentId: parentInfo.parentId,
    parentType: parentInfo.parentType,
    databaseId: parentInfo.databaseId,
    databaseTitle: parentInfo.databaseTitle,
    raw: item,
  });

  const properties = compactStringRecord({
    id,
    identifier: id,
    type,
    objectType: firstString(item.object, type),
    entityType: type,
    title,
    name: title,
    url,
    createdAt,
    updatedAt: lastEditedAt,
    lastEditedAt,
    "notion.last_edited_time": lastEditedAt,
    parent: parentInfo.parent,
    parentId: parentInfo.parentId,
    parentType: parentInfo.parentType,
    database: firstString(parentInfo.databaseTitle, parentInfo.databaseId),
    databaseId: parentInfo.databaseId,
    databaseTitle: parentInfo.databaseTitle,
    parentDatabase: parentInfo.databaseTitle,
    author,
    createdBy,
    lastEditedBy,
    lastEditedByName: lastEditedBy,
    tag: tags.join(","),
    tags: tags.length > 0 ? JSON.stringify(tags) : undefined,
    archived: booleanString(item.archived),
    inTrash: booleanString(item.in_trash, item.inTrash),
    ...(type === "page" ? { pageId: id } : {}),
    ...(type === "database" ? { databaseId: id, database: title, databaseTitle: title } : {}),
    ...(type === "block"
      ? {
          blockId: id,
          blockType: firstString(item.type),
          hasChildren: booleanString(item.has_children, item.hasChildren),
        }
      : {}),
  });

  return {
    path,
    type: "file",
    provider: NOTION_PROVIDER_NAME,
    title,
    ...(lastEditedAt ? { updatedAt: lastEditedAt } : {}),
    size: content.length,
    properties,
    content,
    contentType: "application/json",
  };
}

function notionPath(type: SupportedNotionEnumerationType, id: string): string {
  return `/notion/${type}s/${encodeURIComponent(id)}.json`;
}

function titleFromNotionRecord(
  type: SupportedNotionEnumerationType,
  item: JsonObject,
): string | undefined {
  if (type === "database") {
    return firstString(
      item.title,
      plainTextFromRichText(item.title),
      richTextArrayTitle(item.description),
      propertyObjectTitle(item.properties),
    );
  }
  if (type === "page") {
    return firstString(
      item.title,
      propertyObjectTitle(item.properties),
      plainTextFromRichText(item.title),
    );
  }
  return firstString(
    childEntityTitle(item),
    blockTextFromRecord(item),
    item.title,
  );
}

function childEntityTitle(item: JsonObject): string | undefined {
  const blockType = firstString(item.type);
  if (!blockType) {
    return undefined;
  }

  const blockPayload = asRecord(item[blockType]);
  return firstString(blockPayload.title, blockPayload.name, plainTextFromRichText(blockPayload.rich_text));
}

function blockTextFromRecord(item: JsonObject): string | undefined {
  const blockType = firstString(item.type);
  if (!blockType) {
    return undefined;
  }

  const blockPayload = asRecord(item[blockType]);
  return firstString(
    plainTextFromRichText(blockPayload.rich_text),
    plainTextFromRichText(blockPayload.text),
    blockPayload.plain_text,
  );
}

function propertyObjectTitle(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const [key, property] of Object.entries(value)) {
    if (!isRecord(property)) {
      continue;
    }
    const normalizedName = key.trim().toLowerCase();
    const propertyType = firstString(property.type)?.toLowerCase();
    if (propertyType === "title") {
      return firstString(
        plainTextFromRichText(property.title),
        displayValueFromProperty(property),
      );
    }
    if (normalizedName === "title" || normalizedName === "name") {
      return displayValueFromProperty(property);
    }
  }

  return undefined;
}

function tagsFromRecord(item: JsonObject): string[] {
  const direct = readStringArray(item.tags);
  if (direct.length > 0) {
    return unique(direct);
  }

  const properties = asRecord(item.properties);
  const values: string[] = [];
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property)) {
      continue;
    }
    const normalizedName = key.trim().toLowerCase();
    if (!["tag", "tags", "label", "labels"].includes(normalizedName)) {
      continue;
    }
    values.push(...displayValuesFromProperty(property));
  }

  return unique(values);
}

function authorPropertyFromRecord(item: JsonObject): string | undefined {
  const properties = asRecord(item.properties);
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property)) {
      continue;
    }
    const normalizedName = key.trim().toLowerCase();
    if (
      normalizedName === "author" ||
      normalizedName === "owner" ||
      normalizedName === "created by" ||
      normalizedName === "last edited by"
    ) {
      const values = displayValuesFromProperty(property);
      if (values.length > 0) {
        return values[0];
      }
    }
  }
  return undefined;
}

function displayValueFromProperty(property: JsonObject): string | undefined {
  return displayValuesFromProperty(property)[0];
}

function displayValuesFromProperty(property: JsonObject): string[] {
  const displayValue = firstString(property.displayValue, property.display_value);
  if (displayValue) {
    return [displayValue];
  }

  const serialized = serializeNotionProperty(property);
  if (serialized?.displayValue) {
    return expandPropertyValues(serialized.displayValue);
  }

  const propertyType = firstString(property.type)?.toLowerCase();
  switch (propertyType) {
    case "title":
      return expandPropertyValues(plainTextFromRichText(property.title));
    case "rich_text":
      return expandPropertyValues(plainTextFromRichText(property.rich_text));
    case "select":
      return expandPropertyValues(optionName(property.select));
    case "multi_select":
      return Array.isArray(property.multi_select)
        ? property.multi_select.map(optionName).filter(isDefined)
        : [];
    case "status":
      return expandPropertyValues(optionName(property.status));
    case "people":
      return Array.isArray(property.people)
        ? property.people.map((person) => userNameFromValue(person)).filter(isDefined)
        : [];
    case "created_by":
      return expandPropertyValues(userNameFromValue(property.created_by));
    case "last_edited_by":
      return expandPropertyValues(userNameFromValue(property.last_edited_by));
    case "relation":
      return Array.isArray(property.relation)
        ? property.relation
            .map((item) => (isRecord(item) ? firstString(item.id) : undefined))
            .filter(isDefined)
        : [];
    case "date": {
      const dateValue = asRecord(property.date);
      return expandPropertyValues(firstString(dateValue.start, dateValue.end));
    }
    case "number":
      return expandPropertyValues(firstString(property.number));
    case "url":
      return expandPropertyValues(firstString(property.url));
    case "email":
      return expandPropertyValues(firstString(property.email));
    case "phone_number":
      return expandPropertyValues(firstString(property.phone_number));
    case "checkbox":
      return expandPropertyValues(booleanString(property.checkbox));
    case "formula":
      return formulaValues(asRecord(property.formula));
    case "files":
      return Array.isArray(property.files)
        ? property.files
            .map((file) =>
              isRecord(file)
                ? firstString(file.name, asRecord(file.external).url, asRecord(file.file).url)
                : undefined,
            )
            .filter(isDefined)
        : [];
    default:
      return expandPropertyValues(firstString(property.value, property.name, property.id));
  }
}

function serializeNotionProperty(property: JsonObject): SerializedNotionProperty {
  const propertyType = firstString(property.type);
  if (!propertyType) {
    return null;
  }

  try {
    return serializePropertyValue(property as unknown as NotionPageProperty);
  } catch {
    return null;
  }
}

function formulaValues(formula: JsonObject): string[] {
  const formulaType = firstString(formula.type)?.toLowerCase();
  if (formulaType === "string") {
    return expandPropertyValues(firstString(formula.string));
  }
  if (formulaType === "number") {
    return expandPropertyValues(firstString(formula.number));
  }
  if (formulaType === "boolean") {
    return expandPropertyValues(booleanString(formula.boolean));
  }
  if (formulaType === "date") {
    const dateValue = asRecord(formula.date);
    return expandPropertyValues(firstString(dateValue.start, dateValue.end));
  }
  return [];
}

function optionName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return firstString(value.name, value.id);
}

function userNameFromValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      return value.trim() || undefined;
    }
    if (!isRecord(value)) {
      continue;
    }
    const name = firstString(value.name, value.login, value.personName);
    if (name) {
      return name;
    }
    const user = asRecord(value.user);
    const nestedName = firstString(user.name, user.login);
    if (nestedName) {
      return nestedName;
    }
  }
  return undefined;
}

function parentInfoFromValue(value: unknown): {
  parent?: string;
  parentId?: string;
  parentType?: string;
  databaseId?: string;
  databaseTitle?: string;
} {
  if (!isRecord(value)) {
    return {};
  }

  const rawType = firstString(value.type)?.toLowerCase();
  if (!rawType) {
    return {};
  }

  if (rawType === "database_id" || rawType === "data_source_id") {
    const databaseId = firstString(value.database_id, value.data_source_id, value.id);
    return {
      parent: databaseId,
      parentId: databaseId,
      parentType: "database",
      databaseId,
    };
  }

  if (rawType === "page_id") {
    const pageId = firstString(value.page_id, value.id);
    return {
      parent: pageId,
      parentId: pageId,
      parentType: "page",
    };
  }

  if (rawType === "block_id") {
    const blockId = firstString(value.block_id, value.id);
    return {
      parent: blockId,
      parentId: blockId,
      parentType: "block",
    };
  }

  if (rawType === "workspace") {
    return {
      parent: "workspace",
      parentType: "workspace",
    };
  }

  return {
    parent: firstString(value.id, value.name, rawType),
    parentId: firstString(value.id),
    parentType: rawType.replace(/_id$/, ""),
  };
}

function mergeParentInfo(
  current: ReturnType<typeof parentInfoFromValue>,
  hint?: NotionParentHint,
): ReturnType<typeof parentInfoFromValue> {
  const parentType = current.parentType ?? (hint?.pageId ? "page" : hint?.databaseId ? "database" : undefined);
  const parentId = current.parentId ?? hint?.pageId ?? hint?.databaseId;
  const databaseId = current.databaseId ?? hint?.databaseId;
  const databaseTitle = current.databaseTitle ?? hint?.databaseTitle;
  const parent =
    current.parent ??
    hint?.pageTitle ??
    hint?.databaseTitle ??
    parentId;

  return {
    parent,
    parentId,
    parentType,
    databaseId,
    databaseTitle,
  };
}

function pageSearchQueries(filters: Record<string, string[]>): string[] {
  if ((filters.database ?? []).length > 0) {
    return [];
  }
  return unique([
    ...(filters.title ?? []),
    ...(filters.tag ?? []),
    ...(filters.author ?? []),
  ]).filter((value) => value.trim().length > 0);
}

function databaseSearchQueries(filters: Record<string, string[]>): string[] {
  return unique([
    ...(filters.database ?? []),
    ...(filters.title ?? []),
  ]).filter((value) => value.trim().length > 0);
}

function blockSearchQueries(filters: Record<string, string[]>): string[] {
  return unique([
    ...(filters.title ?? []),
    ...(filters.tag ?? []),
    ...(filters.author ?? []),
  ]).filter((value) => value.trim().length > 0);
}

function filtersFromRequest(request: unknown): Record<string, string[]> {
  const record = asRecord(request);
  const params = asRecord(record.params);
  const directFilters = readFilterRecord(record.filters);
  const paramsFilters = readFilterRecord(params.filters);
  const directKeys = readKnownFilterKeys(record);
  const paramsKeys = readKnownFilterKeys(params);

  return mergeFilters(directFilters, paramsFilters, directKeys, paramsKeys);
}

function readKnownFilterKeys(record: Record<string, unknown>): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const key of [
    "type",
    "database",
    "title",
    "tag",
    "author",
    "updated_window",
    "page",
    "pageId",
    "parent",
    "parentId",
  ]) {
    const values = readStringArray(record[key]);
    if (values.length > 0) {
      output[key] = values;
    }
  }
  return output;
}

function limitFromRequest(request: unknown): number {
  const record = asRecord(request);
  const params = asRecord(record.params);
  const requested = readNumber(params.limit) ?? readNumber(record.limit) ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)));
}

function typesFromRequest(
  request: unknown,
  filters: Record<string, string[]>,
): SupportedNotionEnumerationType[] {
  const record = asRecord(request);
  const params = asRecord(record.params);
  const requested = [
    ...readStringArray(record.types),
    ...readStringArray(params.types),
    ...(filters.type ?? []),
  ]
    .map(normalizeEnumerationType)
    .filter(isDefined);
  const deduped = [...new Set(requested)];
  return deduped.length > 0 ? deduped : [...SUPPORTED_TYPES];
}

function normalizeEnumerationType(
  value: string,
): SupportedNotionEnumerationType | undefined {
  const normalized = value.trim().toLowerCase();
  if (["page", "pages"].includes(normalized)) {
    return "page";
  }
  if (["database", "databases"].includes(normalized)) {
    return "database";
  }
  if (["block", "blocks"].includes(normalized)) {
    return "block";
  }
  return undefined;
}

function recordsFromResult(value: unknown): JsonObject[] {
  if (isFailedIntegrationResult(value)) {
    return [];
  }

  const data = unwrapData(value);
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (isRecord(data) && Array.isArray(data.items)) {
    return data.items.filter(isRecord);
  }
  if (isRecord(data) && Array.isArray(data.results)) {
    return data.results.filter(isRecord);
  }
  if (isRecord(data) && Array.isArray(data.data)) {
    return data.data.filter(isRecord);
  }
  return [];
}

function unwrapData(value: unknown): unknown {
  if (
    isRecord(value) &&
    "data" in value &&
    ("summary" in value || "source" in value || "timestamp" in value)
  ) {
    return value.data;
  }
  return value;
}

function isFailedIntegrationResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const summary = firstString(value.summary)?.toLowerCase();
  return Boolean(
    summary &&
      (summary.includes("request failed") ||
        summary.includes("rate limit") ||
        summary.includes("not found") ||
        summary.includes("missing connection") ||
        summary.includes("connection not found")),
  );
}

async function safeNotionCall<T>(
  action: string,
  loader: () => Promise<T | null | undefined>,
): Promise<T | null> {
  try {
    return (await loader()) ?? null;
  } catch (error) {
    logFailure(`notion ${action} failed`, error);
    return null;
  }
}

function plainTextFromRichText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const richText = value.filter(isNotionRichText);
  if (richText.length === value.length) {
    const text = richTextToPlainText(richText).trim();
    return text || undefined;
  }

  const text = value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!isRecord(item)) {
        return "";
      }
      return firstString(item.plain_text, asRecord(item.text).content, item.href) ?? "";
    })
    .join("")
    .trim();
  return text || undefined;
}

function richTextArrayTitle(value: unknown): string | undefined {
  return plainTextFromRichText(value);
}

function isNotionRichText(value: unknown): value is NotionRichText {
  return isRecord(value) && typeof value.plain_text === "string";
}

function notionObjectId(value: JsonObject): string | undefined {
  return firstString(value.id, value.page_id, value.database_id, value.block_id, value.comment_id);
}

function extractIdentifier(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match =
    trimmed.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ??
    trimmed.match(/\/([0-9a-zA-Z_-]+)(?:\.json)?$/);
  return match?.[1] ?? trimmed;
}

function compactStringRecord(input: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value.length > 0) {
      output[key] = value;
    }
  }
  return output;
}

function mergeFilters(...sources: Record<string, string[]>[]): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const source of sources) {
    for (const [key, values] of Object.entries(source)) {
      output[key] = [...new Set([...(output[key] ?? []), ...values])];
    }
  }
  return output;
}

function readFilterRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  const output: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const values = readStringArray(raw);
    if (values.length > 0) {
      output[key] = values;
    }
  }
  return output;
}

function firstFilterValue(filters: Record<string, string[]>, key: string): string | undefined {
  return filters[key]?.find((value) => value.trim().length > 0);
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => firstString(item)).filter(isDefined);
  }
  const text = firstString(value);
  return text ? [text] : [];
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function booleanString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }
  }
  return undefined;
}

function expandPropertyValues(...values: Array<string | undefined>): string[] {
  return unique(
    values.flatMap((value) => {
      if (!value) {
        return [];
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }
      if (trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (Array.isArray(parsed)) {
            return parsed.filter((item): item is string => typeof item === "string");
          }
        } catch {
          // Fall through to comma-separated parsing.
        }
      }
      return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    }),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function dedupeEntries(entries: FallbackVfsEntry[]): FallbackVfsEntry[] {
  const seen = new Set<string>();
  const output: FallbackVfsEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    output.push(entry);
  }
  return output;
}

function dedupeRecordsById(records: JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  const output: JsonObject[] = [];
  for (const record of records) {
    const id = notionObjectId(record) ?? safeStringify(record);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    output.push(record);
  }
  return output;
}

function dedupePageRefs(pages: NotionPageRef[]): NotionPageRef[] {
  const seen = new Set<string>();
  const output: NotionPageRef[] = [];
  for (const page of pages) {
    const key = page.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(page);
  }
  return output;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function logInvocation(message: string, metadata: Record<string, unknown>): void {
  console.info(LOG_PREFIX, message, metadata);
}

function logFailure(message: string, error: unknown): void {
  console.warn(LOG_PREFIX, message, errorMessage(error));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (isRecord(error)) {
    const response = asRecord(error.response);
    const status = firstString(response.status);
    const data = asRecord(response.data);
    const message = firstString(data.message, error.message);
    return [status ? `status ${status}` : undefined, message].filter(isDefined).join(": ");
  }
  return String(error);
}
