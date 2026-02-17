import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ name: 'code-review', topic: 'PR discussions' })),
  list: vi.fn(async () => [
    { name: 'general', topic: 'General chat' },
    { name: 'code-review', topic: null },
  ]),
  join: vi.fn(async () => undefined),
  leave: vi.fn(async () => undefined),
  setTopic: vi.fn(async () => ({ name: 'general', topic: 'New topic' })),
  archive: vi.fn(async () => undefined),
}));

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(function () {
    return {
      as: vi.fn(() => ({
        channels: {
          create: mocks.create,
          list: mocks.list,
          join: mocks.join,
          leave: mocks.leave,
          setTopic: mocks.setTopic,
          archive: mocks.archive,
        },
      })),
    };
  }),
}));
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ apiKey: 'rk_test', agentToken: 'at_test' })),
}));

import { registerChannelCommands } from '../commands/channel.js';

describe('channel commands', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('channel create calls SDK and prints result', async () => {
    const program = new Command().exitOverride();
    registerChannelCommands(program);
    await program.parseAsync(['channel', 'create', 'code-review', '--topic', 'PR discussions'], { from: 'user' });
    expect(mocks.create).toHaveBeenCalledWith({ name: 'code-review', topic: 'PR discussions' });
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('#code-review'))).toBe(true);
  });

  it('channel list prints channels', async () => {
    const program = new Command().exitOverride();
    registerChannelCommands(program);
    await program.parseAsync(['channel', 'list'], { from: 'user' });
    expect(mocks.list).toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('#general'))).toBe(true);
  });

  it('channel join calls SDK', async () => {
    const program = new Command().exitOverride();
    registerChannelCommands(program);
    await program.parseAsync(['channel', 'join', 'general'], { from: 'user' });
    expect(mocks.join).toHaveBeenCalledWith('general');
  });

  it('channel leave calls SDK', async () => {
    const program = new Command().exitOverride();
    registerChannelCommands(program);
    await program.parseAsync(['channel', 'leave', 'general'], { from: 'user' });
    expect(mocks.leave).toHaveBeenCalledWith('general');
  });

  it('channel topic calls setTopic', async () => {
    const program = new Command().exitOverride();
    registerChannelCommands(program);
    await program.parseAsync(['channel', 'topic', 'general', 'New topic'], { from: 'user' });
    expect(mocks.setTopic).toHaveBeenCalledWith('general', 'New topic');
  });

  it('channel archive calls SDK', async () => {
    const program = new Command().exitOverride();
    registerChannelCommands(program);
    await program.parseAsync(['channel', 'archive', 'old-channel'], { from: 'user' });
    expect(mocks.archive).toHaveBeenCalledWith('old-channel');
  });
});
