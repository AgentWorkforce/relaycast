import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mockLoadConfig = vi.fn(() => ({ apiKey: 'rk_test', endpoint: 'https://example.test' }));
vi.mock('../config.js', () => ({
  loadConfig: mockLoadConfig,
}));

const RelayMock = vi.fn();
vi.mock('@agent-relay/sdk', () => ({
  Relay: RelayMock,
}));

describe('workspace commands', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    RelayMock.mockReset();
    consoleLogSpy.mockClear();
    mockLoadConfig.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('relay workspace create <name> calls workspace.update({ name }) and prints workspace', async () => {
    const relayInstance = {
      workspace: {
        update: vi.fn(async () => ({
          id: 'ws_1',
          name: 'Acme',
          api_key_hash: 'hash',
          system_prompt: null,
          plan: 'free',
          stripe_customer_id: null,
          stripe_subscription_id: null,
          created_at: '2020-01-01T00:00:00Z',
          metadata: {},
        })),
      },
    };
    RelayMock.mockImplementation(() => relayInstance);

    const { registerWorkspaceCommands } = await import('../commands/workspace.js');
    const program = new Command().exitOverride();
    registerWorkspaceCommands(program);

    await program.parseAsync(['workspace', 'create', 'Acme'], { from: 'user' });

    expect(RelayMock).toHaveBeenCalledWith({ apiKey: 'rk_test', baseUrl: 'https://example.test' });
    expect(relayInstance.workspace.update).toHaveBeenCalledWith({ name: 'Acme' });
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleLogSpy.mock.calls[0]?.[0] ?? '')).toContain('"name": "Acme"');
  });

  it('relay workspace info calls workspace.info() and prints workspace', async () => {
    const relayInstance = {
      workspace: {
        info: vi.fn(async () => ({
          id: 'ws_1',
          name: 'Acme',
          api_key_hash: 'hash',
          system_prompt: null,
          plan: 'free',
          stripe_customer_id: null,
          stripe_subscription_id: null,
          created_at: '2020-01-01T00:00:00Z',
          metadata: {},
        })),
      },
    };
    RelayMock.mockImplementation(() => relayInstance);

    const { registerWorkspaceCommands } = await import('../commands/workspace.js');
    const program = new Command().exitOverride();
    registerWorkspaceCommands(program);

    await program.parseAsync(['workspace', 'info'], { from: 'user' });

    expect(relayInstance.workspace.info).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleLogSpy.mock.calls[0]?.[0] ?? '')).toContain('"id": "ws_1"');
  });

  it('relay workspace delete prints message', async () => {
    const { registerWorkspaceCommands } = await import('../commands/workspace.js');
    const program = new Command().exitOverride();
    registerWorkspaceCommands(program);

    await program.parseAsync(['workspace', 'delete'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleLogSpy.mock.calls[0]?.[0] ?? '')).toContain('dashboard');
  });
});
