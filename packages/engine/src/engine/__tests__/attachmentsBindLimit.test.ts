import { describe, expect, it } from 'vitest';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import {
  agents,
  channels,
  files,
  messageAttachments,
  messages,
  workspaces,
} from '../../db/schema.js';
import { fetchAttachmentsBatch } from '../attachments.js';

const D1_MAX_BIND_PARAMETERS = 100;

function openDb(): SqliteDbHandle {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  return handle;
}

/** Record each prepared statement's bind count; better-sqlite3 allows far more than D1. */
function recordBindCounts(handle: SqliteDbHandle): number[] {
  const counts: number[] = [];
  const original = handle.sqlite.prepare.bind(handle.sqlite);
  (handle.sqlite as unknown as { prepare: typeof original }).prepare = (sql: string) => {
    counts.push((sql.match(/\?/g) ?? []).length);
    return original(sql);
  };
  return counts;
}

describe('fetchAttachmentsBatch D1 bind limit', () => {
  it('hydrates attachments across a full 100-message page without exceeding D1 limits', async () => {
    const handle = openDb();
    try {
      const { db } = handle;
      await db.insert(workspaces).values({ id: 'ws', name: 'ws', apiKeyHash: 'hash' }).run();
      await db.insert(agents).values({ id: 'agent', workspaceId: 'ws', name: 'agent', tokenHash: 'token' }).run();
      await db.insert(channels).values({ id: 'channel', workspaceId: 'ws', name: 'dm-channel', channelType: 1 }).run();

      const messageIds = Array.from({ length: 100 }, (_, index) => `message-${String(index).padStart(3, '0')}`);
      for (const id of messageIds) {
        await db.insert(messages).values({
          id,
          workspaceId: 'ws',
          channelId: 'channel',
          agentId: 'agent',
          body: 'test',
        }).run();
      }

      const attachmentSpecs = [
        { messageId: messageIds[0], fileId: 'file-0-a', position: 1 },
        { messageId: messageIds[0], fileId: 'file-0-b', position: 0 },
        { messageId: messageIds[89], fileId: 'file-89', position: 0 },
        { messageId: messageIds[90], fileId: 'file-90', position: 0 },
        { messageId: messageIds[99], fileId: 'file-99', position: 0 },
      ];
      for (const { fileId } of attachmentSpecs) {
        await db.insert(files).values({
          id: fileId,
          workspaceId: 'ws',
          uploadedBy: 'agent',
          filename: `${fileId}.txt`,
          contentType: 'text/plain',
          sizeBytes: 1,
          storageKey: fileId,
        }).run();
      }
      for (const attachment of attachmentSpecs) {
        await db.insert(messageAttachments).values(attachment).run();
      }

      const bindCounts = recordBindCounts(handle);
      const result = await fetchAttachmentsBatch(db, 'ws', messageIds);

      expect(bindCounts.length).toBeGreaterThan(1);
      expect(Math.max(...bindCounts)).toBeLessThanOrEqual(D1_MAX_BIND_PARAMETERS);
      // Every chunk includes the workspace predicate in addition to its message ids.
      expect(bindCounts.reduce((sum, count) => sum + count, 0)).toBe(messageIds.length + bindCounts.length);
      expect(result.size).toBe(4);
      expect(result.get(messageIds[0])).toEqual([
        { file_id: 'file-0-b', filename: 'file-0-b.txt', content_type: 'text/plain', size_bytes: 1 },
        { file_id: 'file-0-a', filename: 'file-0-a.txt', content_type: 'text/plain', size_bytes: 1 },
      ]);
      expect(result.get(messageIds[89])?.[0].file_id).toBe('file-89');
      expect(result.get(messageIds[90])?.[0].file_id).toBe('file-90');
      expect(result.get(messageIds[99])?.[0].file_id).toBe('file-99');

      const repeatedIdResult = await fetchAttachmentsBatch(db, 'ws', [
        ...messageIds.slice(0, 90),
        messageIds[0]!,
      ]);
      expect(repeatedIdResult.get(messageIds[0])).toEqual(result.get(messageIds[0]));
    } finally {
      handle.sqlite.close();
    }
  });
});
