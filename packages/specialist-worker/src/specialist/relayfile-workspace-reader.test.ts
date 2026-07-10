import type { FileQueryItem, RelayFileClient } from '@relayfile/sdk';
import { describe, expect, it, vi } from 'vitest';

import { RelayFileWorkspaceReader } from './relayfile-workspace-reader.js';

const WORKSPACE_ID = 'workspace-test';
type QueryFilesArgs = Parameters<RelayFileClient['queryFiles']>;
type QueryFilesReturn = ReturnType<RelayFileClient['queryFiles']>;

function createQueryItem(
  path: string,
  properties: Record<string, string> = {},
): FileQueryItem {
  return {
    path,
    revision: `rev-${path}`,
    contentType: 'application/json',
    provider: 'github',
    providerObjectId: path,
    lastEditedAt: '2026-04-25T12:00:00.000Z',
    size: 42,
    properties,
  };
}

function createReader(queryFiles: RelayFileClient['queryFiles']): RelayFileWorkspaceReader {
  return new RelayFileWorkspaceReader({
    client: { queryFiles } as unknown as RelayFileClient,
    workspaceId: WORKSPACE_ID,
  });
}

describe('RelayFileWorkspaceReader.enumerate', () => {
  it('queries a single key and single value filter once and forwards properties', async () => {
    const item = createQueryItem('/github/repos/AgentWorkforce/cloud/pulls/1.json', {
      state: 'open',
      title: 'Fix production empty findings',
    });
    const queryFiles = vi.fn<QueryFilesArgs, QueryFilesReturn>().mockResolvedValue({
      items: [item],
      nextCursor: null,
    });
    const reader = createReader(queryFiles);

    const result = await reader.enumerate({
      roots: ['/github/repos/AgentWorkforce/cloud/pulls/'],
      filters: { state: ['open'] },
      limit: 10,
    });

    expect(queryFiles).toHaveBeenCalledTimes(1);
    expect(queryFiles.mock.calls[0]?.[0]).toBe(WORKSPACE_ID);
    expect(queryFiles.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        path: '/github/repos/AgentWorkforce/cloud/pulls',
        properties: { state: 'open' },
        limit: 10,
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        path: item.path,
        type: 'file',
        provider: 'github',
        title: 'Fix production empty findings',
        properties: item.properties,
      }),
    ]);
  });

  it('fans out a single key with multiple values and dedupes by path', async () => {
    const queryFiles = vi.fn<QueryFilesArgs, QueryFilesReturn>(async (_workspaceId, options) => {
      if (options?.properties?.state === 'open') {
        return {
          items: [
            createQueryItem('/github/repos/AgentWorkforce/cloud/pulls/1.json', { state: 'open' }),
            createQueryItem('/github/repos/AgentWorkforce/cloud/pulls/shared.json', { state: 'open' }),
          ],
          nextCursor: null,
        };
      }

      return {
        items: [
          createQueryItem('/github/repos/AgentWorkforce/cloud/pulls/shared.json', { state: 'closed' }),
          createQueryItem('/github/repos/AgentWorkforce/cloud/pulls/2.json', { state: 'closed' }),
        ],
        nextCursor: null,
      };
    });
    const reader = createReader(queryFiles);

    const result = await reader.enumerate({
      roots: ['/github/repos/AgentWorkforce/cloud/pulls/'],
      filters: { state: ['open', 'closed'] },
      limit: 10,
    });

    expect(queryFiles).toHaveBeenCalledTimes(2);
    expect(queryFiles.mock.calls.map((call) => call[1]!.properties)).toEqual([
      { state: 'open' },
      { state: 'closed' },
    ]);
    // Merged results sorted by recency-then-path. All test items use the
    // default lastEditedAt, so the tiebreaker is alphabetical by path.
    expect(result.map((entry) => entry.path).sort()).toEqual([
      '/github/repos/AgentWorkforce/cloud/pulls/1.json',
      '/github/repos/AgentWorkforce/cloud/pulls/2.json',
      '/github/repos/AgentWorkforce/cloud/pulls/shared.json',
    ]);
  });

  it('combines multi-key filters into one AND query', async () => {
    const queryFiles = vi.fn<QueryFilesArgs, QueryFilesReturn>().mockResolvedValue({
      items: [createQueryItem('/github/repos/AgentWorkforce/cloud/pulls/1.json')],
      nextCursor: null,
    });
    const reader = createReader(queryFiles);

    await reader.enumerate({
      roots: ['/github/repos/AgentWorkforce/cloud/pulls/'],
      filters: { state: ['open'], repo: ['AgentWorkforce/cloud'] },
      limit: 5,
    });

    expect(queryFiles).toHaveBeenCalledTimes(1);
    expect(queryFiles.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        properties: {
          state: 'open',
          repo: 'AgentWorkforce/cloud',
        },
      }),
    );
  });

  it('queries every root and property cartesian cell, then dedupes and applies the limit', async () => {
    const queryFiles = vi.fn<QueryFilesArgs, QueryFilesReturn>(async (_workspaceId, options) => {
      const state = options?.properties?.state ?? 'unknown';
      const repo = options?.properties?.repo ?? 'unknown';
      const root = options?.path ?? '/';

      return {
        items: [
          createQueryItem('/github/repos/AgentWorkforce/cloud/pulls/shared.json', {
            state,
            repo,
          }),
          createQueryItem(`${root}/${state}-${repo}.json`, {
            state,
            repo,
          }),
        ],
        nextCursor: null,
      };
    });
    const reader = createReader(queryFiles);

    const result = await reader.enumerate({
      roots: [
        '/github/repos/AgentWorkforce/cloud/pulls/',
        '/github/repos/AgentWorkforce/cloud/issues/',
      ],
      filters: {
        state: ['open', 'closed'],
        repo: ['AgentWorkforce/cloud', 'AgentWorkforce/agent-assistant'],
      },
      limit: 3,
    });

    expect(queryFiles).toHaveBeenCalledTimes(8);
    expect(queryFiles.mock.calls.map((call) => call[1]!.properties)).toEqual([
      { state: 'open', repo: 'AgentWorkforce/cloud' },
      { state: 'open', repo: 'AgentWorkforce/agent-assistant' },
      { state: 'closed', repo: 'AgentWorkforce/cloud' },
      { state: 'closed', repo: 'AgentWorkforce/agent-assistant' },
      { state: 'open', repo: 'AgentWorkforce/cloud' },
      { state: 'open', repo: 'AgentWorkforce/agent-assistant' },
      { state: 'closed', repo: 'AgentWorkforce/cloud' },
      { state: 'closed', repo: 'AgentWorkforce/agent-assistant' },
    ]);
    // Merged results sort by recency-then-path before slicing. All items
    // share the default lastEditedAt, so the tiebreaker is alphabetical
    // by path. /issues/* sorts before /pulls/* lexicographically, so the
    // first 3 are the alphabetically-first issues paths. (The point of
    // this assertion is that the slice is applied AFTER ordering across
    // all 8 cells, not before — that's the behavior fix from PR #371
    // codex-review feedback.)
    expect(result).toHaveLength(3);
    expect(result.every((entry) => entry.path.startsWith('/github/repos/AgentWorkforce/cloud/issues/'))).toBe(true);
  });

  it('propagates queryFiles errors', async () => {
    const queryFiles = vi
      .fn<QueryFilesArgs, QueryFilesReturn>()
      .mockRejectedValue(new Error('RelayFile query failed'));
    const reader = createReader(queryFiles);

    await expect(
      reader.enumerate({
        roots: ['/github/repos/AgentWorkforce/cloud/pulls/'],
        filters: { state: ['open'] },
        limit: 10,
      }),
    ).rejects.toThrow('RelayFile query failed');
  });

  it('maps FileQueryItem properties onto VfsListEntry properties', async () => {
    const properties = {
      state: 'open',
      repo: 'AgentWorkforce/cloud',
      title: 'Open PR',
    };
    const queryFiles = vi.fn<QueryFilesArgs, QueryFilesReturn>().mockResolvedValue({
      items: [createQueryItem('/github/repos/AgentWorkforce/cloud/pulls/3.json', properties)],
      nextCursor: null,
    });
    const reader = createReader(queryFiles);

    const [entry] = await reader.enumerate({
      roots: ['/github/repos/AgentWorkforce/cloud/pulls/'],
      filters: { state: ['open'] },
      limit: 10,
    });

    expect(entry?.properties).toEqual(properties);
  });

  // Regression for codex P2 review on PR #371 — fan-out for OR-within-key
  // (e.g. `state: ['open', 'closed']`) used to dedupe in iteration order
  // and slice immediately. If the first cell already returned >= input.limit
  // matches, later cells were silently dropped, making the OR behave like
  // "first value only". Sort merged results by lastEditedAt before slicing.
  it('sorts merged fan-out results across cells before applying the limit', async () => {
    // Two cells: 'open' returns 3 OLDER items, 'closed' returns 2 NEWER items.
    // With limit=3, the buggy behavior would keep all 3 'open' (older) and
    // drop the 2 newer 'closed'. Correct behavior keeps the 2 newer 'closed'
    // plus the newest 'open' — i.e. the 3 most recent across both cells.
    const queryFiles = vi.fn<QueryFilesArgs, QueryFilesReturn>(async (_workspaceId, options) => {
      if (options?.properties?.state === 'open') {
        return {
          items: [
            { ...createQueryItem('/pulls/old-1.json', { state: 'open' }), lastEditedAt: '2026-04-01T00:00:00.000Z' },
            { ...createQueryItem('/pulls/old-2.json', { state: 'open' }), lastEditedAt: '2026-04-02T00:00:00.000Z' },
            { ...createQueryItem('/pulls/old-3.json', { state: 'open' }), lastEditedAt: '2026-04-03T00:00:00.000Z' },
          ],
          nextCursor: null,
        };
      }
      return {
        items: [
          { ...createQueryItem('/pulls/new-1.json', { state: 'closed' }), lastEditedAt: '2026-04-25T00:00:00.000Z' },
          { ...createQueryItem('/pulls/new-2.json', { state: 'closed' }), lastEditedAt: '2026-04-24T00:00:00.000Z' },
        ],
        nextCursor: null,
      };
    });
    const reader = createReader(queryFiles);

    const result = await reader.enumerate({
      roots: ['/pulls/'],
      filters: { state: ['open', 'closed'] },
      limit: 3,
    });

    expect(queryFiles).toHaveBeenCalledTimes(2);
    expect(result.map((entry) => entry.path)).toEqual([
      '/pulls/new-1.json',  // 2026-04-25
      '/pulls/new-2.json',  // 2026-04-24
      '/pulls/old-3.json',  // 2026-04-03 — newest 'open', dropped by the bug
    ]);
  });
});
