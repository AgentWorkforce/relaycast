import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before importing bridge
const mockRegister = vi.fn();
const mockJoin = vi.fn();
const mockCreate = vi.fn();
const mockSend = vi.fn();
const mockDm = vi.fn();
const mockInbox = vi.fn();
const mockSearch = vi.fn();
const mockReply = vi.fn();
const mockReact = vi.fn();

const mockAgentClient = {
  channels: { join: mockJoin, create: mockCreate },
  send: mockSend,
  dm: mockDm,
  inbox: mockInbox,
  search: mockSearch,
  reply: mockReply,
  react: mockReact,
};

vi.mock('@relaycast/sdk', () => ({
  Relay: vi.fn().mockImplementation(() => ({
    agents: { register: mockRegister },
    as: vi.fn().mockReturnValue(mockAgentClient),
  })),
  WsClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
  })),
}));

import { OpenClawBridge } from '../bridge.js';

describe('OpenClawBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegister.mockResolvedValue({
      id: '1',
      name: 'test-claw',
      token: 'at_live_test',
      status: 'online',
      created_at: new Date().toISOString(),
    });
    mockJoin.mockResolvedValue(undefined);
  });

  it('connects and registers as agent', async () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw', persona: 'Test bot' },
    });

    const agent = await bridge.connect();

    expect(mockRegister).toHaveBeenCalledWith({
      name: 'test-claw',
      type: 'agent',
      persona: 'Test bot',
    });
    expect(agent.name).toBe('test-claw');
    expect(bridge.getToken()).toBe('at_live_test');
  });

  it('joins specified channels on connect', async () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
      channels: ['general', '#alerts'],
    });

    await bridge.connect();

    expect(mockJoin).toHaveBeenCalledWith('general');
    expect(mockJoin).toHaveBeenCalledWith('alerts');
  });

  it('creates channel when join fails', async () => {
    mockJoin.mockRejectedValueOnce(new Error('not found'));
    mockCreate.mockResolvedValue({ name: 'new-channel' });

    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
      channels: ['new-channel'],
    });

    await bridge.connect();

    expect(mockJoin).toHaveBeenCalledWith('new-channel');
    expect(mockCreate).toHaveBeenCalledWith({ name: 'new-channel' });
  });

  it('proxies send() to agent client', async () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
    });

    await bridge.connect();
    await bridge.send('#general', 'hello');

    expect(mockSend).toHaveBeenCalledWith('#general', 'hello');
  });

  it('proxies dm() to agent client', async () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
    });

    await bridge.connect();
    await bridge.dm('other-claw', 'hey');

    expect(mockDm).toHaveBeenCalledWith('other-claw', 'hey');
  });

  it('proxies reply() to agent client', async () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
    });

    await bridge.connect();
    await bridge.reply('msg123', 'replying');

    expect(mockReply).toHaveBeenCalledWith('msg123', 'replying');
  });

  it('proxies react() to agent client', async () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
    });

    await bridge.connect();
    await bridge.react('msg123', 'thumbsup');

    expect(mockReact).toHaveBeenCalledWith('msg123', 'thumbsup');
  });

  it('proxies search() to agent client', async () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
    });

    await bridge.connect();
    await bridge.search('deploy', { channel: 'ops' });

    expect(mockSearch).toHaveBeenCalledWith('deploy', { channel: 'ops' });
  });

  it('proxies inbox() to agent client', async () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
    });

    await bridge.connect();
    await bridge.inbox();

    expect(mockInbox).toHaveBeenCalled();
  });

  it('throws when using methods before connect()', () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
    });

    expect(() => bridge.getAgent()).toThrow('Bridge not connected');
  });

  it('cleans up on disconnect()', async () => {
    const bridge = new OpenClawBridge({
      apiKey: 'rk_test_key',
      claw: { name: 'test-claw' },
    });

    await bridge.connect();
    expect(bridge.getToken()).toBe('at_live_test');

    bridge.disconnect();
    expect(bridge.getToken()).toBeNull();
    expect(() => bridge.getAgent()).toThrow('Bridge not connected');
  });
});
