import { describe, it, expect, vi } from 'vitest';

vi.mock('commander', () => {
  class MockCommand {
    name() {
      return this;
    }
    description() {
      return this;
    }
    version() {
      return this;
    }
    command() {
      return this;
    }
    option() {
      return this;
    }
    action() {
      return this;
    }
    hook() {
      return this;
    }
    parse() {
      return this;
    }
    parseAsync() {
      return Promise.resolve(this);
    }
  }
  return { Command: MockCommand };
});

vi.mock('../commands/workspace.js', () => ({ registerWorkspaceCommands: () => {} }));
vi.mock('../commands/agent.js', () => ({ registerAgentCommands: () => {} }));
vi.mock('../commands/config.js', () => ({ registerConfigCommands: () => {} }));
vi.mock('../commands/channel.js', () => ({ registerChannelCommands: () => {} }));
vi.mock('../commands/messaging.js', () => ({ registerMessagingCommands: () => {} }));
vi.mock('../commands/read.js', () => ({ registerReadCommands: () => {} }));
vi.mock('../commands/search.js', () => ({ registerSearchCommands: () => {} }));
vi.mock('../commands/reactions.js', () => ({ registerReactionCommands: () => {} }));
vi.mock('../commands/files.js', () => ({ registerFileCommands: () => {} }));
vi.mock('../commands/billing.js', () => ({ registerBillingCommands: () => {} }));
vi.mock('../commands/telemetry.js', () => ({ registerTelemetryCommands: () => {} }));
vi.mock('../telemetry.js', () => ({
  createCliTelemetry: () => ({
    capture: () => {},
    captureFirstRunIfNeeded: () => {},
    flush: async () => {},
  }),
}));

describe('relaycast', () => {
  it('exports CLI_VERSION', async () => {
    // Import after mocks are set so the CLI entrypoint does not call process.exit().
    const { CLI_VERSION } = await import('../index.js');
    expect(CLI_VERSION).toBe('0.1.0');
  });
});
