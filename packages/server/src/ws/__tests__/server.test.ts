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

import { startWsServer, getClients, getClientsByWorkspace } from '../server.js';
import { getDb } from '../../db/index.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const wsApiKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
const wsApiKeyHash = hashToken(wsApiKey);
const wsAgentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
const wsAgentTokenHash = hashToken(wsAgentToken);

const fakeWorkspace = { id: 'ws_test123', name: 'Test', apiKeyHash: wsApiKeyHash };
const fakeAgent = { id: 'agent_test123', workspaceId: 'ws_test123', tokenHash: wsAgentTokenHash };

function setupDbMock() {
  const mockSelect = vi.fn().mockReturnThis();
  const mockFrom = vi.fn().mockReturnThis();
  const mockWhere = vi.fn().mockImplementation((condition: unknown) => {
    // Default: return workspace for rk_live_ tokens, agent for at_live_ tokens
    return Promise.resolve([fakeWorkspace]);
  });

  (getDb as ReturnType<typeof vi.fn>).mockReturnValue({
    select: mockSelect,
    from: mockFrom,
    where: mockWhere,
  });

  // Chain: db.select().from(table).where(condition) -> Promise<result[]>
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });

  return { mockSelect, mockFrom, mockWhere };
}

describe('WebSocket Server', () => {
  let httpServer: HttpServer;
  let port: number;

  beforeEach(async () => {
    getClients().clear();
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

  it('connects with valid workspace key token', async () => {
    const { mockWhere } = setupDbMock();
    mockWhere.mockResolvedValue([fakeWorkspace]);

    const ws = new WebSocket(`ws://localhost:${port}/v1/stream?token=${wsApiKey}`);
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()));
      ws.on('error', reject);
    });

    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('connected');
    expect(parsed.client_id).toBeDefined();
    expect(getClients().size).toBe(1);

    ws.close();
  });

  it('connects with valid agent token', async () => {
    const { mockWhere } = setupDbMock();
    // First call returns empty (not a workspace key), then on retry it finds the agent
    let callCount = 0;
    mockWhere.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]);
      return Promise.resolve([fakeAgent]);
    });

    // Actually for agent tokens, token.startsWith('at_live_') path is taken directly
    // So we need just one call returning the agent
    mockWhere.mockResolvedValue([fakeAgent]);

    const ws = new WebSocket(`ws://localhost:${port}/v1/stream?token=${wsAgentToken}`);
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()));
      ws.on('error', reject);
    });

    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('connected');
    expect(getClients().size).toBe(1);

    const client = Array.from(getClients().values())[0];
    expect(client.agentId).toBe('agent_test123');

    ws.close();
  });

  it('rejects connection with invalid token', async () => {
    const { mockWhere } = setupDbMock();
    mockWhere.mockResolvedValue([]);

    const ws = new WebSocket(`ws://localhost:${port}/v1/stream?token=rk_live_invalid`);

    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
    });

    expect(getClients().size).toBe(0);
  });

  it('rejects connection without token', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/v1/stream`);

    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
    });

    expect(getClients().size).toBe(0);
  });

  it('rejects connection on wrong path', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/v1/wrong?token=${wsApiKey}`);

    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
    });

    expect(getClients().size).toBe(0);
  });

  it('cleans up on disconnect', async () => {
    const { mockWhere } = setupDbMock();
    mockWhere.mockResolvedValue([fakeWorkspace]);

    const ws = new WebSocket(`ws://localhost:${port}/v1/stream?token=${wsApiKey}`);
    await new Promise<string>((resolve) => {
      ws.on('message', (data) => resolve(data.toString()));
    });

    expect(getClients().size).toBe(1);

    ws.close();
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));

    // Allow time for cleanup
    await new Promise((r) => setTimeout(r, 50));
    expect(getClients().size).toBe(0);
  });

  it('getClientsByWorkspace filters correctly', async () => {
    const { mockWhere } = setupDbMock();
    mockWhere.mockResolvedValue([fakeWorkspace]);

    const ws = new WebSocket(`ws://localhost:${port}/v1/stream?token=${wsApiKey}`);
    await new Promise<string>((resolve) => {
      ws.on('message', (data) => resolve(data.toString()));
    });

    const wsClients = getClientsByWorkspace('ws_test123');
    expect(wsClients.length).toBe(1);

    const noClients = getClientsByWorkspace('ws_other');
    expect(noClients.length).toBe(0);

    ws.close();
  });
});
