import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  react: vi.fn(async () => ({})),
  unreact: vi.fn(async () => undefined),
}));

vi.mock('@relaycast/sdk', () => ({
  Relay: vi.fn(() => ({
    as: vi.fn(() => ({
      react: mocks.react,
      unreact: mocks.unreact,
    })),
  })),
}));
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ apiKey: 'rk_test', agentToken: 'at_test' })),
}));

import { registerReactionCommands } from '../commands/reactions.js';

describe('reaction commands', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('react calls agent.react', async () => {
    const program = new Command().exitOverride();
    registerReactionCommands(program);
    await program.parseAsync(['react', 'msg_1', 'eyes'], { from: 'user' });
    expect(mocks.react).toHaveBeenCalledWith('msg_1', 'eyes');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('eyes'))).toBe(true);
  });

  it('unreact calls agent.unreact', async () => {
    const program = new Command().exitOverride();
    registerReactionCommands(program);
    await program.parseAsync(['unreact', 'msg_1', 'eyes'], { from: 'user' });
    expect(mocks.unreact).toHaveBeenCalledWith('msg_1', 'eyes');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Removed'))).toBe(true);
  });
});
