import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ id: 'msg_1' })),
  dm: vi.fn(async () => ({})),
  reply: vi.fn(async () => ({ id: 'msg_2' })),
  createGroup: vi.fn(async () => ({})),
}));

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(function () {
    return {
      as: vi.fn(() => ({
        send: mocks.send,
        dm: mocks.dm,
        reply: mocks.reply,
        dms: { createGroup: mocks.createGroup },
      })),
    };
  }),
}));
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ apiKey: 'rk_test', agentToken: 'at_test' })),
}));

import { registerMessagingCommands } from '../commands/messaging.js';

describe('messaging commands', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('send to channel calls agent.send', async () => {
    const program = new Command().exitOverride();
    registerMessagingCommands(program);
    await program.parseAsync(['send', '#general', 'Hello team'], { from: 'user' });
    expect(mocks.send).toHaveBeenCalledWith('#general', 'Hello team');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('msg_1'))).toBe(true);
  });

  it('send to @agent calls agent.dm', async () => {
    const program = new Command().exitOverride();
    registerMessagingCommands(program);
    await program.parseAsync(['send', '@CodeReviewer', 'Check PR #42'], { from: 'user' });
    expect(mocks.dm).toHaveBeenCalledWith('CodeReviewer', 'Check PR #42');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('DM sent'))).toBe(true);
  });

  it('reply calls agent.reply', async () => {
    const program = new Command().exitOverride();
    registerMessagingCommands(program);
    await program.parseAsync(['reply', 'msg_123', 'Good point'], { from: 'user' });
    expect(mocks.reply).toHaveBeenCalledWith('msg_123', 'Good point');
  });

  it('group-dm calls dms.createGroup', async () => {
    const program = new Command().exitOverride();
    registerMessagingCommands(program);
    await program.parseAsync([
      'group-dm', 'Alice', 'Bob', 'Carol',
      '--name', 'PR review', '--text', 'Lets discuss',
    ], { from: 'user' });
    expect(mocks.createGroup).toHaveBeenCalledWith({
      participants: ['Alice', 'Bob', 'Carol'],
      name: 'PR review',
      text: 'Lets discuss',
    });
  });
});
