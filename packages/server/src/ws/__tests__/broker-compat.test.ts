/**
 * Integration tests that verify the WebSocket protocol contract between
 * the relaycast server and relay-broker (Rust WS client).
 *
 * These tests simulate relay-broker's exact WS behavior:
 * - Connects to /v1/stream?token=...
 * - Sends {"type":"subscribe","channels":["general"]} messages
 * - Expects events in the typed ServerEvent shape from @relaycast/types
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, Server as HttpServer } from 'node:http';
import WebSocket from 'ws';
import crypto from 'node:crypto';

// Mock db
vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../db/schema.js', () => ({
  workspaces: { apiKeyHash: 'apiKeyHash' },
  agents: { tokenHash: 'tokenHash' },
}));

// Mock Redis pubsub (subscribeToWorkspace is called on connection)
vi.mock('../pubsub.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pubsub.js')>();
  return {
    ...actual,
    subscribeToWorkspace: vi.fn().mockResolvedValue(undefined),
  };
});

import { startWsServer, getClients } from '../server.js';
import { broadcastToChannel, broadcastToWorkspace } from '../subscriptions.js';
import { getDb } from '../../db/index.js';
import type { WsEvent } from '../pubsub.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
const agentTokenHash = hashToken(agentToken);
const fakeAgent = { id: 'agent_broker', workspaceId: 'ws_broker', tokenHash: agentTokenHash, name: 'TestBroker' };

function setupDbMock() {
  const mockSelect = vi.fn().mockReturnThis();
  const mockFrom = vi.fn().mockReturnThis();
  const mockWhere = vi.fn().mockResolvedValue([fakeAgent]);
  (getDb as ReturnType<typeof vi.fn>).mockReturnValue({
    select: mockSelect,
    from: mockFrom,
    where: mockWhere,
  });
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  return { mockWhere };
}

/** Connect a WS client and wait for the `connected` handshake message. */
async function connectClient(port: number): Promise<{ ws: WebSocket; clientId: string }> {
  const ws = new WebSocket(`ws://localhost:${port}/v1/stream?token=${agentToken}`);
  const raw = await new Promise<string>((resolve, reject) => {
    ws.on('message', (data) => resolve(data.toString()));
    ws.on('error', reject);
  });
  const parsed = JSON.parse(raw);
  return { ws, clientId: parsed.client_id };
}

/** Send a JSON message and wait for the response. */
function sendAndReceive(ws: WebSocket, msg: object): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.send(JSON.stringify(msg));
  });
}

/** Wait for the next WS message (broadcast event). */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe('Broker Compatibility', () => {
  let httpServer: HttpServer;
  let port: number;

  beforeEach(async () => {
    getClients().clear();
    setupDbMock();
    httpServer = createServer();
    startWsServer(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const client of getClients().values()) {
      client.ws.terminate();
    }
    getClients().clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('connects and receives connected message', async () => {
    const { ws, clientId } = await connectClient(port);
    expect(clientId).toBeDefined();
    expect(getClients().size).toBe(1);
    ws.close();
  });

  it('subscribes with channels array', async () => {
    const { ws } = await connectClient(port);

    const response = await sendAndReceive(ws, { type: 'subscribe', channels: ['general', 'dev'] });
    expect(response.type).toBe('subscribed');
    expect(response.channels).toContain('general');
    expect(response.channels).toContain('dev');

    ws.close();
  });

  it('receives channel event in ServerEvent format (message.created)', async () => {
    const { ws } = await connectClient(port);

    // Subscribe to channel
    await sendAndReceive(ws, { type: 'subscribe', channels: ['general'] });

    const client = Array.from(getClients().values())[0];
    expect(client.subscriptions.has('general')).toBe(true);

    const eventPromise = nextMessage(ws);

    // Simulate a WsEvent as the server would publish it via Redis
    // Note: channel_id is a DB snowflake ID, NOT the channel name.
    // Clients subscribe by name, so broadcastToChannel must route by name.
    const wsEvent: WsEvent = {
      type: 'message.created',
      workspace_id: 'ws_broker',
      channel_id: '144115188075855872',
      data: {
        id: 'msg_123',
        channel_name: 'general',
        from_name: 'alice',
        text: 'hello from test',
        attachments: [],
      },
      timestamp: new Date().toISOString(),
    };
    // Route by channel name (from event.data.channel_name), not channel_id
    broadcastToChannel('ws_broker', 'general', wsEvent);

    const received = await eventPromise;

    // Should be in ServerEvent shape, NOT raw WsEvent
    expect(received.type).toBe('message.created');
    expect(received.channel).toBe('general');
    expect(received.message).toEqual({
      id: 'msg_123',
      agent_name: 'alice',
      text: 'hello from test',
      attachments: [],
    });
    // Internal fields should be stripped
    expect(received).not.toHaveProperty('workspace_id');
    expect(received).not.toHaveProperty('channel_id');
    expect(received).not.toHaveProperty('data');
    expect(received).not.toHaveProperty('timestamp');

    ws.close();
  });

  it('receives workspace event in ServerEvent format (dm.received)', async () => {
    const { ws } = await connectClient(port);

    const eventPromise = nextMessage(ws);

    const wsEvent: WsEvent = {
      type: 'dm.received',
      workspace_id: 'ws_broker',
      data: {
        id: 'dm_1',
        conversation_id: 'conv_1',
        from_name: 'bob',
        text: 'private message',
      },
      timestamp: new Date().toISOString(),
    };
    broadcastToWorkspace('ws_broker', wsEvent);

    const received = await eventPromise;
    expect(received.type).toBe('dm.received');
    expect(received.conversation_id).toBe('conv_1');
    expect(received.message).toEqual({
      id: 'dm_1',
      agent_name: 'bob',
      text: 'private message',
    });
    expect(received).not.toHaveProperty('workspace_id');
    expect(received).not.toHaveProperty('data');

    ws.close();
  });

  it('receives agent.online in correct shape', async () => {
    const { ws } = await connectClient(port);

    const eventPromise = nextMessage(ws);

    const wsEvent: WsEvent = {
      type: 'agent.online',
      workspace_id: 'ws_broker',
      data: { agent_id: 'agent_1', agent_name: 'alice' },
      timestamp: new Date().toISOString(),
    };
    broadcastToWorkspace('ws_broker', wsEvent);

    const received = await eventPromise;
    expect(received).toEqual({
      type: 'agent.online',
      agent: { name: 'alice' },
    });

    ws.close();
  });

  it('unsubscribe stops channel events', async () => {
    const { ws } = await connectClient(port);

    // Subscribe
    await sendAndReceive(ws, { type: 'subscribe', channels: ['general'] });

    // Unsubscribe
    const unsub = await sendAndReceive(ws, { type: 'unsubscribe', channels: ['general'] });
    expect(unsub.type).toBe('unsubscribed');
    expect(unsub.channels).not.toContain('general');

    // Broadcast — should NOT be received
    let unexpectedMessage = false;
    ws.once('message', () => { unexpectedMessage = true; });

    const wsEvent: WsEvent = {
      type: 'message.created',
      workspace_id: 'ws_broker',
      channel_id: 'general',
      data: { id: 'msg_2', channel_name: 'general', from_name: 'alice', text: 'should not see this' },
      timestamp: new Date().toISOString(),
    };
    broadcastToChannel('ws_broker', 'general', wsEvent);

    await new Promise((r) => setTimeout(r, 200));
    expect(unexpectedMessage).toBe(false);

    ws.close();
  });

  it('multiple channel subscriptions route correctly', async () => {
    const { ws } = await connectClient(port);

    // Subscribe to two channels
    await sendAndReceive(ws, { type: 'subscribe', channels: ['general', 'dev'] });

    // Broadcast to 'general'
    const eventPromise1 = nextMessage(ws);
    broadcastToChannel('ws_broker', 'general', {
      type: 'message.created',
      workspace_id: 'ws_broker',
      channel_id: 'general',
      data: { id: 'msg_g', channel_name: 'general', from_name: 'alice', text: 'in general' },
      timestamp: new Date().toISOString(),
    } as WsEvent);
    const msg1 = await eventPromise1;
    expect(msg1.type).toBe('message.created');
    expect(msg1.channel).toBe('general');

    // Broadcast to 'dev'
    const eventPromise2 = nextMessage(ws);
    broadcastToChannel('ws_broker', 'dev', {
      type: 'message.created',
      workspace_id: 'ws_broker',
      channel_id: 'dev',
      data: { id: 'msg_d', channel_name: 'dev', from_name: 'bob', text: 'in dev' },
      timestamp: new Date().toISOString(),
    } as WsEvent);
    const msg2 = await eventPromise2;
    expect(msg2.type).toBe('message.created');
    expect(msg2.channel).toBe('dev');

    // Broadcast to 'ops' (not subscribed) — should not receive
    let unexpectedMessage = false;
    ws.once('message', () => { unexpectedMessage = true; });

    broadcastToChannel('ws_broker', 'ops', {
      type: 'message.created',
      workspace_id: 'ws_broker',
      channel_id: 'ops',
      data: { id: 'msg_o', channel_name: 'ops', from_name: 'carol', text: 'in ops' },
      timestamp: new Date().toISOString(),
    } as WsEvent);

    await new Promise((r) => setTimeout(r, 200));
    expect(unexpectedMessage).toBe(false);

    ws.close();
  });
});
