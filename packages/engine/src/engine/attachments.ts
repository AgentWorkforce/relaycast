import { and, asc, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messageAttachments, files } from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

/** A message attachment rendered onto the snake_case JSON wire. */
export type AttachmentRow = {
  file_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
};

/**
 * Load attachments for a batch of message ids, grouped by message id.
 *
 * Shared by every read path that hydrates attachments (channel messages,
 * threads, DMs, group DMs, delivery payloads) so they all scope by workspace
 * and order attachments by their stored `position` identically. Returns an
 * empty map for an empty id list without touching the database.
 */
export async function fetchAttachmentsBatch(
  db: Db,
  workspaceId: string,
  msgIds: string[],
): Promise<Map<string, AttachmentRow[]>> {
  const map = new Map<string, AttachmentRow[]>();
  if (msgIds.length === 0) return map;

  const rows = await db
    .select({
      messageId: messageAttachments.messageId,
      fileId: messageAttachments.fileId,
      filename: files.filename,
      contentType: files.contentType,
      sizeBytes: files.sizeBytes,
    })
    .from(messageAttachments)
    .innerJoin(files, eq(messageAttachments.fileId, files.id))
    .where(and(inArray(messageAttachments.messageId, msgIds), eq(files.workspaceId, workspaceId)))
    .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position));

  for (const row of rows) {
    const list = map.get(row.messageId) || [];
    list.push({
      file_id: row.fileId,
      filename: row.filename,
      content_type: row.contentType,
      size_bytes: row.sizeBytes,
    });
    map.set(row.messageId, list);
  }
  return map;
}
