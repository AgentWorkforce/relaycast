// Notion sync record shapes — Nango-sandbox mirror.
//
// CANONICAL SOURCE: packages/core/src/sync/notion-record-shapes.ts
//
// The Nango sandbox cannot resolve `@cloud/core` imports — only relative
// paths inside `nango-integrations/` and a small allowlist of npm packages
// (zod, nango, crypto, etc.). Until `@relayfile/adapter-notion` exposes
// these helpers we keep a hand-mirrored copy here and assert byte-equality
// (modulo the leading zod schema declarations and this header) in
// `tests/notion-record-shapes-parity.test.ts`.
//
// Update both files together when changing schemas or helper logic.

import * as z from "zod";

export const NotionPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  parent_type: z.string(),
  parent_id: z.string(),
  // `database_id` and `database_title` are populated only when
  // `parent_type === "database"`. The adapter-notion by-database alias
  // emit gate (`adapter-notion/dist/emit-auxiliary-files.js:263`) requires
  // both fields to be present and non-empty; without them
  // `/notion/pages/by-database/<db>/<page>.json` aliases are silently
  // skipped, even on otherwise-successful sync runs.
  database_id: z.string().optional(),
  database_title: z.string().optional(),
  last_edited_time: z.string(),
  content_preview: z.string(),
  archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
});

export const NotionPageContentSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  content: z.string(),
  contentHash: z.string(),
  lastEditedTime: z.string(),
});

export type NotionPageRecord = z.infer<typeof NotionPageSchema>;
export type NotionPageContentRecord = z.infer<typeof NotionPageContentSchema>;

export const NOTION_PAGE_MODEL = "NotionPage" as const;
export const NOTION_PAGE_CONTENT_MODEL = "NotionPageContent" as const;
export type NotionRecordModel =
  | typeof NOTION_PAGE_MODEL
  | typeof NOTION_PAGE_CONTENT_MODEL;

export const NOTION_PREVIEW_CHAR_LIMIT = 500;

// === BEGIN MIRRORED BODY ===
// The block below MUST stay byte-identical to packages/core/src/sync/notion-record-shapes.ts
// (from `function isObject` through end of file). Parity test enforces this.

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function extractNotionPageTitle(
  properties?: Record<string, unknown> | null,
): string {
  if (!properties) return "Untitled";
  for (const property of Object.values(properties)) {
    if (
      !isObject(property) ||
      property["type"] !== "title" ||
      !Array.isArray(property["title"])
    ) {
      continue;
    }
    const title = (property["title"] as unknown[])
      .map((fragment) =>
        isObject(fragment) && isString(fragment["plain_text"])
          ? (fragment["plain_text"] as string)
          : "",
      )
      .join("")
      .trim();
    if (title) return title;
  }
  return "Untitled";
}

export function extractNotionParentInfo(
  parent?: Record<string, unknown> | null,
): { parent_type: string; parent_id: string } {
  if (!parent) return { parent_type: "workspace", parent_id: "" };
  const rawParentType = isString(parent["type"])
    ? (parent["type"] as string)
    : "workspace";
  const parentType = rawParentType.endsWith("_id")
    ? rawParentType.slice(0, -3)
    : rawParentType;
  const parentIdValue = parent[rawParentType];
  const parentId =
    rawParentType !== "workspace" && isString(parentIdValue)
      ? (parentIdValue as string)
      : "";
  return { parent_type: parentType, parent_id: parentId };
}

export function extractNotionContentPreview(
  blocks: Array<Record<string, unknown>>,
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const blockType = isString(block["type"])
      ? (block["type"] as string)
      : "";
    if (!blockType) continue;
    const inner = block[blockType];
    if (!isObject(inner) || !Array.isArray(inner["rich_text"])) continue;
    const text = (inner["rich_text"] as unknown[])
      .map((fragment) =>
        isObject(fragment) && isString(fragment["plain_text"])
          ? (fragment["plain_text"] as string)
          : "",
      )
      .join(" ")
      .trim();
    if (text) parts.push(text);
    if (parts.join(" ").length >= NOTION_PREVIEW_CHAR_LIMIT) break;
  }
  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTION_PREVIEW_CHAR_LIMIT);
}

export function buildNotionPageRecord(input: {
  id: string;
  url?: string | null;
  last_edited_time?: string | null;
  properties?: Record<string, unknown> | null;
  parent?: Record<string, unknown> | null;
  content_preview?: string;
  // Optional database enrichment. When the parent is a database, callers
  // should set `database_title` (and may set `database_id` explicitly; it
  // otherwise falls back to `parent_id`). Required for adapter-notion's
  // `/notion/pages/by-database/` alias emission.
  database_id?: string;
  database_title?: string;
  archived?: boolean;
  in_trash?: boolean;
}): NotionPageRecord {
  const parentInfo = extractNotionParentInfo(input.parent ?? undefined);
  const record: NotionPageRecord = {
    id: input.id,
    title: extractNotionPageTitle(input.properties ?? undefined),
    url: typeof input.url === "string" ? input.url : "",
    ...parentInfo,
    last_edited_time:
      typeof input.last_edited_time === "string" ? input.last_edited_time : "",
    content_preview: input.content_preview ?? "",
    archived: input.archived === true,
    in_trash: input.in_trash === true,
  };
  if (parentInfo.parent_type === "database" && parentInfo.parent_id) {
    record.database_id = input.database_id ?? parentInfo.parent_id;
    if (input.database_title) {
      record.database_title = input.database_title;
    }
  }
  return record;
}

export function buildNotionContentRecord(input: {
  pageId: string;
  markdown: string;
  contentHash: string;
  lastEditedTime: string;
}): NotionPageContentRecord {
  return {
    id: input.pageId,
    pageId: input.pageId,
    content: input.markdown,
    contentHash: input.contentHash,
    lastEditedTime: input.lastEditedTime,
  };
}
// === END MIRRORED BODY ===
