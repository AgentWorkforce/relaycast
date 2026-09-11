import { describe, expect, it } from 'vitest';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import { agents, channelMembers, channels, workspaces } from '../../db/schema.js';
import { listChannels } from '../channel.js';

/**
 * `listChannels` fans every channel id of a workspace into a single
 * `inArray(channelMembers.channelId, channelIds)` — one bind per channel, no
 * upper bound. Cloudflare D1 caps a statement at 100 bind parameters
 * (measured against production: 100 succeeds, 101 fails with "too many SQL
 * variables", code 7500), so any workspace past that ceiling fails every call.
 *
 * Live in production: workspace rw_7ccfea89 holds 111 non-DM channels and every
 * `GET /v1/channels?include_archived=true` for it returns 500. The default path
 * survives only because 68 of those are unarchived.
 *
 * These assert the BIND COUNT of each issued statement rather than just calling
 * the function, because the Node test harness cannot reproduce the failure:
 * better-sqlite3's SQLITE_MAX_VARIABLE_NUMBER is 32766, so a 150-channel
 * workspace succeeds here while failing on D1. A test that merely calls
 * listChannels passes on both the broken and fixed code and proves nothing.
 */
const D1_MAX_BIND_PARAMETERS = 100;

function openDb(): SqliteDbHandle {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  return handle;
}

/** Record the bind count of every statement the callee issues. */
function recordBindCounts(handle: SqliteDbHandle): number[] {
  const counts: number[] = [];
  const original = handle.sqlite.prepare.bind(handle.sqlite);
  (handle.sqlite as unknown as { prepare: typeof original }).prepare = (sql: string) => {
    counts.push((sql.match(/\?/g) ?? []).length);
    return original(sql);
  };
  return counts;
}

async function seed(db: SqliteDbHandle['db'], channelCount: number) {
  await db.insert(workspaces).values({ id: 'ws', name: 'ws', apiKeyHash: 'hash' });
  for (let i = 0; i < 3; i++) {
    await db.insert(agents).values({
      id: `agent-${i}`, workspaceId: 'ws', name: `a${i}`, tokenHash: `th${i}`,
    });
  }
  const expectedCounts: Record<string, number> = {};
  for (let i = 0; i < channelCount; i++) {
    const channelId = `chan-${String(i).padStart(4, '0')}`;
    await db.insert(channels).values({
      id: channelId,
      workspaceId: 'ws',
      name: `c${i}`,
      channelType: 0,
      isArchived: false,
    });
    // Varied counts throughout the workspace cover both chunks and zero-member
    // channels, regardless of the database's channel ordering.
    expectedCounts[channelId] = i % 4;
    for (let member = 0; member < expectedCounts[channelId]; member++) {
      await db.insert(channelMembers).values({ channelId, agentId: `agent-${member}` });
    }
  }
  return expectedCounts;
}

describe('listChannels bind-parameter ceiling', () => {
  it('never issues a statement above D1 bind limit for a large workspace', async () => {
    const handle = openDb();
    try {
      const expectedCounts = await seed(handle.db, 150);
      const counts = recordBindCounts(handle);
      const result = await listChannels(handle.db, 'ws', false);

      const over = counts.filter((n) => n > D1_MAX_BIND_PARAMETERS);
      expect({ over, max: Math.max(0, ...counts) })
        .toEqual({ over: [], max: Math.max(0, ...counts) });
      expect(Math.max(0, ...counts)).toBeLessThanOrEqual(D1_MAX_BIND_PARAMETERS);

      // Chunking must not lose rows or drop the member-count join: a fix that
      // simply removed the join would satisfy the bind assertion above.
      expect(result).toHaveLength(150);
      expect(Object.fromEntries(result.map((c) => [c.id, c.member_count])))
        .toEqual(expectedCounts);
    } finally {
      handle.sqlite.close();
    }
  });

  it('is unchanged for a workspace under the ceiling', async () => {
    const handle = openDb();
    try {
      const expectedCounts = await seed(handle.db, 12);
      const counts = recordBindCounts(handle);
      const result = await listChannels(handle.db, 'ws', false);
      expect(Math.max(0, ...counts)).toBeLessThanOrEqual(D1_MAX_BIND_PARAMETERS);
      expect(result).toHaveLength(12);
      expect(Object.fromEntries(result.map((c) => [c.id, c.member_count])))
        .toEqual(expectedCounts);
    } finally {
      handle.sqlite.close();
    }
  });
});
