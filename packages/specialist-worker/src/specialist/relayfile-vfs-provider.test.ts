import { describe, expect, it, vi } from 'vitest';

import {
  createRelayFileVfsProvider,
  type RelayFileVfsReader,
} from './relayfile-vfs-provider.js';
import type { VfsEnumerateInput, VfsListEntry } from './relayfile-workspace-reader.js';

type EnumerateArgs = [VfsEnumerateInput];
type EnumerateReturn = Promise<VfsListEntry[]>;
type ListTreeArgs = Parameters<RelayFileVfsReader['listTree']>;
type ListTreeReturn = ReturnType<RelayFileVfsReader['listTree']>;

function createReader(overrides: Partial<RelayFileVfsReader> = {}): RelayFileVfsReader {
  return {
    isEnabled: vi.fn(() => true),
    listTree: vi.fn(async () => []),
    enumerate: vi.fn(async () => []),
    readFile: vi.fn(async () => null),
    searchFiles: vi.fn(async () => []),
    statFile: vi.fn(async () => null),
    ...overrides,
  };
}

describe('createRelayFileVfsProvider', () => {
  it('wires enumerate through to the reader and forwards properties', async () => {
    const input = {
      roots: ['/github/repos/AgentWorkforce/cloud/pulls/'],
      filters: { state: ['open'] },
      limit: 10,
    };
    const enumerate = vi.fn<EnumerateArgs, EnumerateReturn>(async () => [
      {
        path: '/github/repos/AgentWorkforce/cloud/pulls/1.json',
        type: 'file',
        provider: 'github',
        title: 'Open PR',
        revision: 'rev-1',
        updatedAt: '2026-04-25T12:00:00.000Z',
        size: 100,
        properties: {
          state: 'open',
          repo: 'AgentWorkforce/cloud',
        },
      },
    ]);
    const reader = createReader({ enumerate });
    const provider = createRelayFileVfsProvider(reader);

    const result = await provider.enumerate(input);

    expect(enumerate).toHaveBeenCalledWith(input);
    expect(result).toEqual([
      {
        path: '/github/repos/AgentWorkforce/cloud/pulls/1.json',
        type: 'file',
        provider: 'github',
        title: 'Open PR',
        revision: 'rev-1',
        updatedAt: '2026-04-25T12:00:00.000Z',
        size: 100,
        properties: {
          state: 'open',
          repo: 'AgentWorkforce/cloud',
        },
      },
    ]);
  });

  it('forwards properties on list entries when RelayFile tree entries include them', async () => {
    const listTree = vi.fn<ListTreeArgs, ListTreeReturn>(async () => [
      {
        path: '/github/repos/AgentWorkforce/cloud/pulls/1.json',
        type: 'file',
        provider: 'github',
        revision: 'rev-1',
        properties: {
          state: 'open',
        },
      },
    ]);
    const reader = createReader({ listTree });
    const provider = createRelayFileVfsProvider(reader);

    const result = await provider.list('/github/repos/AgentWorkforce/cloud/pulls/');

    expect(result[0]?.properties).toEqual({ state: 'open' });
  });
});
