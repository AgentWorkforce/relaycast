import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  messages: vi.fn(async () => [
    { id: 'msg_1', agent_name: 'Coder', text: 'Hello' },
    { id: 'msg_2', agent_name: 'Reviewer', text: 'Hi there' },
  ]),
  thread: vi.fn(async () => ({
    parent: { id: 'msg_1', agent_name: 'Coder', text: 'Hello' },
    replies: [{ id: 'msg_2', agent_name: 'Reviewer', text: 'Reply' }],
  })),
  inbox: vi.fn(async () => ({ unread: [], mentions: [] })),
  conversations: vi.fn(async () => [{ id: 'conv_1', participants: ['Coder', 'Reviewer'], unread_count: 2 }]),
  dmMessages: vi.fn(async () => [{ id: 'dm_1', agent_name: 'Reviewer', text: 'DM content' }]),
  readers: vi.fn(async () => [{ agent_name: 'Reviewer', agent_id: 'a_1', read_at: '2025-01-01T00:00:00Z' }]),
}));

vi.mock('@relaycast/sdk', () => ({
  Relay: vi.fn(() => ({
    as: vi.fn(() => ({
      messages: mocks.messages,
      thread: mocks.thread,
      inbox: mocks.inbox,
      dms: {
        conversations: mocks.conversations,
        messages: mocks.dmMessages,
      },
      readers: mocks.readers,
    })),
  })),
}));
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ apiKey: 'rk_test', agentToken: 'at_test' })),
}));

import { registerReadCommands } from '../commands/read.js';

describe('read commands', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('messages lists channel messages', async () => {
    const program = new Command().exitOverride();
    registerReadCommands(program);
    await program.parseAsync(['messages', 'general', '--limit', '10'], { from: 'user' });
    expect(mocks.messages).toHaveBeenCalledWith('general', { limit: 10 });
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Coder'))).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Hello'))).toBe(true);
  });

  it('thread shows parent and replies', async () => {
    const program = new Command().exitOverride();
    registerReadCommands(program);
    await program.parseAsync(['thread', 'msg_1'], { from: 'user' });
    expect(mocks.thread).toHaveBeenCalledWith('msg_1');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Coder'))).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Reply'))).toBe(true);
  });

  it('inbox shows inbox data', async () => {
    const program = new Command().exitOverride();
    registerReadCommands(program);
    await program.parseAsync(['inbox'], { from: 'user' });
    expect(mocks.inbox).toHaveBeenCalled();
  });

  it('dms finds conversation and shows messages', async () => {
    const program = new Command().exitOverride();
    registerReadCommands(program);
    await program.parseAsync(['dms', 'Reviewer'], { from: 'user' });
    expect(mocks.conversations).toHaveBeenCalled();
    expect(mocks.dmMessages).toHaveBeenCalledWith('conv_1');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('DM content'))).toBe(true);
  });

  it('readers shows who read the message', async () => {
    const program = new Command().exitOverride();
    registerReadCommands(program);
    await program.parseAsync(['readers', 'msg_1'], { from: 'user' });
    expect(mocks.readers).toHaveBeenCalledWith('msg_1');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Reviewer'))).toBe(true);
  });
});
