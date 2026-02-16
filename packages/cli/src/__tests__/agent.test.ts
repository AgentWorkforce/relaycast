import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mockLoadConfig = vi.fn(() => ({ apiKey: 'rk_test', endpoint: 'https://example.test' }));
vi.mock('../config.js', () => ({
  loadConfig: mockLoadConfig,
}));

const RelayMock = vi.fn();
vi.mock('@relaycast/sdk', () => ({
  RelayCast: RelayMock,
}));

describe('agent commands', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    RelayMock.mockReset();
    consoleLogSpy.mockClear();
    mockLoadConfig.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('relay agent register <name> calls agents.register and prints token', async () => {
    const relayInstance = {
      agents: {
        register: vi.fn(async () => ({
          id: 'ag_1',
          name: 'bob',
          token: 'at_test_123',
          status: 'online',
          created_at: '2020-01-01T00:00:00Z',
        })),
      },
    };
    RelayMock.mockImplementation(() => relayInstance);

    const { registerAgentCommands } = await import('../commands/agent.js');
    const program = new Command().exitOverride();
    registerAgentCommands(program);

    await program.parseAsync(
      ['agent', 'register', 'bob', '--persona', 'helpful assistant'],
      { from: 'user' },
    );

    expect(relayInstance.agents.register).toHaveBeenCalledWith({
      name: 'bob',
      persona: 'helpful assistant',
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('at_test_123');
  });

  it('relay agent list prints agents table', async () => {
    const relayInstance = {
      agents: {
        list: vi.fn(async () => [
          {
            id: 'ag_1',
            workspace_id: 'ws_1',
            name: 'bob',
            type: 'agent',
            token_hash: 'hash',
            status: 'online',
            persona: null,
            metadata: {},
            created_at: '2020-01-01T00:00:00Z',
            last_seen: '2020-01-01T00:00:00Z',
          },
          {
            id: 'ag_2',
            workspace_id: 'ws_1',
            name: 'alice',
            type: 'human',
            token_hash: 'hash',
            status: 'away',
            persona: 'ops',
            metadata: {},
            created_at: '2020-01-01T00:00:00Z',
            last_seen: '2020-01-01T00:00:00Z',
          },
        ]),
      },
    };
    RelayMock.mockImplementation(() => relayInstance);

    const { registerAgentCommands } = await import('../commands/agent.js');
    const program = new Command().exitOverride();
    registerAgentCommands(program);

    await program.parseAsync(['agent', 'list'], { from: 'user' });

    expect(relayInstance.agents.list).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const output = String(consoleLogSpy.mock.calls[0]?.[0] ?? '');
    expect(output).toContain('bob');
    expect(output).toContain('alice');
  });

  it('relay agent rotate-token <name> calls agents.rotateToken and prints token', async () => {
    const relayInstance = {
      agents: {
        rotateToken: vi.fn(async () => ({
          token: 'at_live_rotated_456',
        })),
      },
    };
    RelayMock.mockImplementation(() => relayInstance);

    const { registerAgentCommands } = await import('../commands/agent.js');
    const program = new Command().exitOverride();
    registerAgentCommands(program);

    await program.parseAsync(['agent', 'rotate-token', 'bob'], { from: 'user' });

    expect(relayInstance.agents.rotateToken).toHaveBeenCalledWith('bob');
    expect(consoleLogSpy).toHaveBeenCalledWith('at_live_rotated_456');
  });

  it('relay agent status <name> <status> shows current status', async () => {
    const relayInstance = {
      agents: {
        get: vi.fn(async () => ({
          id: 'ag_1',
          workspace_id: 'ws_1',
          name: 'bob',
          type: 'agent',
          token_hash: 'hash',
          status: 'offline',
          persona: null,
          metadata: {},
          created_at: '2020-01-01T00:00:00Z',
          last_seen: '2020-01-01T00:00:00Z',
        })),
      },
    };
    RelayMock.mockImplementation(() => relayInstance);

    const { registerAgentCommands } = await import('../commands/agent.js');
    const program = new Command().exitOverride();
    registerAgentCommands(program);

    await program.parseAsync(['agent', 'status', 'bob', 'online'], { from: 'user' });

    expect(relayInstance.agents.get).toHaveBeenCalledWith('bob');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleLogSpy.mock.calls[0]?.[0] ?? '')).toContain('offline');
  });
});
