import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  usage: vi.fn(async () => ({
    messages_sent: 1000,
    messages_limit: 10000,
    period: 'current',
  })),
  subscription: vi.fn(async () => ({
    plan: 'pro',
    status: 'active',
  })),
  portal: vi.fn(async () => ({
    url: 'https://billing.stripe.com/session/xxx',
  })),
}));

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(function () {
    return {
      billing: {
        usage: mocks.usage,
        subscription: mocks.subscription,
        portal: mocks.portal,
      },
    };
  }),
}));
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ apiKey: 'rk_test' })),
}));

import { registerBillingCommands } from '../commands/billing.js';

describe('billing commands', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('billing usage calls SDK', async () => {
    const program = new Command().exitOverride();
    registerBillingCommands(program);
    await program.parseAsync(['billing', 'usage'], { from: 'user' });
    expect(mocks.usage).toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('1000'))).toBe(true);
  });

  it('billing subscription calls SDK', async () => {
    const program = new Command().exitOverride();
    registerBillingCommands(program);
    await program.parseAsync(['billing', 'subscription'], { from: 'user' });
    expect(mocks.subscription).toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('pro'))).toBe(true);
  });

  it('billing portal prints URL', async () => {
    const program = new Command().exitOverride();
    registerBillingCommands(program);
    await program.parseAsync(['billing', 'portal'], { from: 'user' });
    expect(mocks.portal).toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('stripe.com'))).toBe(true);
  });
});
