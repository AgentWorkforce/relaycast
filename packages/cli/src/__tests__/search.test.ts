import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  search: vi.fn(async () => [{ id: 'msg_1', text: 'deployment error found' }]),
}));

vi.mock('@agent-relay/sdk', () => ({
  Relay: vi.fn(() => ({
    as: vi.fn(() => ({
      search: mocks.search,
    })),
  })),
}));
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ apiKey: 'rk_test', agentToken: 'at_test' })),
}));

import { registerSearchCommands } from '../commands/search.js';

describe('search commands', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('search calls SDK with query', async () => {
    const program = new Command().exitOverride();
    registerSearchCommands(program);
    await program.parseAsync(['search', 'deployment error'], { from: 'user' });
    expect(mocks.search).toHaveBeenCalledWith('deployment error', { channel: undefined });
  });

  it('search with --channel passes filter', async () => {
    const program = new Command().exitOverride();
    registerSearchCommands(program);
    await program.parseAsync(['search', 'error', '--channel', 'general'], { from: 'user' });
    expect(mocks.search).toHaveBeenCalledWith('error', { channel: 'general' });
  });

  it('search with no results prints message', async () => {
    mocks.search.mockResolvedValueOnce([]);
    const program = new Command().exitOverride();
    registerSearchCommands(program);
    await program.parseAsync(['search', 'nothing'], { from: 'user' });
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('No results'))).toBe(true);
  });
});
