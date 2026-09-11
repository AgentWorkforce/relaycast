import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeNodeStack, createWorkspace, type TestStack } from '../../__tests__/conformance/harness.js';
import { agents, channels, channelMembers } from '../../db/schema.js';
import { listChannels } from '../channel.js';
import { generateId } from '../snowflake.js';

// D1 caps a single statement at 100 bound parameters. In production, a
// workspace with >100 channelType=0 channels (e.g. rw_7ccfea89 at 111) trips
// this on GET /v1/channels?include_archived=true because the member-count
// subquery packs every channel id into one `IN (?, ?, ..., ?)`. Emulate that
// ceiling here so the fix is verified against the exact SQL Drizzle emits.
function installD1BindCap(stack: TestStack): void {
  const sqlite = stack.runtime.handle.sqlite;
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((source: string) => {
    const parameterCount = (source.match(/\?/g) ?? []).length;
    if (parameterCount > 100) {
      throw new Error(`D1_ERROR: too many SQL variables at offset 100 (${parameterCount})`);
    }
    return prepare(source);
  }) as typeof sqlite.prepare;
}

describe('listChannels — D1 bind-cap safety', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  it('returns all channels when the workspace has >100 channelType=0 rows (D1 bind cap)', async () => {
    const ws = await createWorkspace(stack.app, 'over-100-channels');
    const db = stack.runtime.deps.db;
    // Insert directly to avoid the subscription channel side effect that a
    // full registerAgent would create — that would inflate the channelType=0
    // count by one per agent and blur the exact ceiling under test.
    const seedAgentId = generateId();
    await db.insert(agents).values({
      id: seedAgentId,
      workspaceId: ws.workspaceId,
      name: 'seed-agent',
      tokenHash: `hash-${seedAgentId}`,
    });

    // 111 matches the production trigger workspace (rw_7ccfea89: 68 active,
    // 43 archived). We split the same way to prove include_archived=true is
    // the path that exceeds the cap while the default path stays under it.
    const activeCount = 68;
    const archivedCount = 43;
    const rows = [
      ...Array.from({ length: activeCount }, (_, i) => ({
        id: generateId(),
        workspaceId: ws.workspaceId,
        name: `active-${i}`,
        isArchived: false,
      })),
      ...Array.from({ length: archivedCount }, (_, i) => ({
        id: generateId(),
        workspaceId: ws.workspaceId,
        name: `archived-${i}`,
        isArchived: true,
      })),
    ];
    await db.insert(channels).values(rows);
    // One membership per channel so the count map has an entry for every id.
    await db.insert(channelMembers).values(rows.map((r) => ({
      channelId: r.id,
      agentId: seedAgentId,
      role: 'member' as const,
    })));

    installD1BindCap(stack);

    // Every channel we seeded has exactly one member. `createWorkspace` may
    // seed extras (e.g. a default #general) — count those separately so the
    // assertion is truthful across changes to workspace bootstrap.
    const seededActiveIds = new Set(rows.filter((r) => !r.isArchived).map((r) => r.id));
    const seededArchivedIds = new Set(rows.filter((r) => r.isArchived).map((r) => r.id));

    const activeOnly = await listChannels(db, ws.workspaceId, false);
    const activeSeeded = activeOnly.filter((c) => seededActiveIds.has(c.id));
    expect(activeSeeded).toHaveLength(activeCount);
    for (const ch of activeSeeded) {
      expect(ch.member_count).toBe(1);
    }
    expect(activeOnly.some((c) => seededArchivedIds.has(c.id))).toBe(false);

    const includeArchived = await listChannels(db, ws.workspaceId, true);
    const bothSeeded = includeArchived.filter((c) => seededActiveIds.has(c.id) || seededArchivedIds.has(c.id));
    expect(bothSeeded).toHaveLength(activeCount + archivedCount);
    for (const ch of bothSeeded) {
      expect(ch.member_count).toBe(1);
    }
  });
});
