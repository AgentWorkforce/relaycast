import { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { workspaces, agents } from '../db/schema.js';
import { handleClientMessage } from './subscriptions.js';
import { subscribeToWorkspace } from './pubsub.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface WsClient {
  id: string;
  ws: WebSocket;
  workspaceId: string;
  agentId?: string;
  subscriptions: Set<string>;
  alive: boolean;
}

const clients = new Map<string, WsClient>();

// Secondary index: workspace:channel -> Set of client IDs for O(subscribers) broadcast
const channelIndex = new Map<string, Set<string>>();
// Secondary index: workspace -> Set of client IDs for O(workspace) broadcast
const workspaceIndex = new Map<string, Set<string>>();

function channelKey(workspaceId: string, channel: string): string {
  return `${workspaceId}:${channel}`;
}

export function indexSubscribe(client: WsClient, channel: string): void {
  const key = channelKey(client.workspaceId, channel);
  let set = channelIndex.get(key);
  if (!set) {
    set = new Set();
    channelIndex.set(key, set);
  }
  set.add(client.id);
}

export function indexUnsubscribe(client: WsClient, channel: string): void {
  const key = channelKey(client.workspaceId, channel);
  const set = channelIndex.get(key);
  if (set) {
    set.delete(client.id);
    if (set.size === 0) channelIndex.delete(key);
  }
}

function indexRemoveClient(client: WsClient): void {
  // Remove from all channel indexes
  for (const ch of client.subscriptions) {
    indexUnsubscribe(client, ch);
  }
  // Remove from workspace index
  const wsSet = workspaceIndex.get(client.workspaceId);
  if (wsSet) {
    wsSet.delete(client.id);
    if (wsSet.size === 0) workspaceIndex.delete(client.workspaceId);
  }
}

function indexAddClient(client: WsClient): void {
  let wsSet = workspaceIndex.get(client.workspaceId);
  if (!wsSet) {
    wsSet = new Set();
    workspaceIndex.set(client.workspaceId, wsSet);
  }
  wsSet.add(client.id);
}

export function getClients(): Map<string, WsClient> {
  return clients;
}

export function getChannelIndex(): Map<string, Set<string>> {
  return channelIndex;
}

export function getWorkspaceIndex(): Map<string, Set<string>> {
  return workspaceIndex;
}

export function getClientsByWorkspace(workspaceId: string): WsClient[] {
  const wsSet = workspaceIndex.get(workspaceId);
  if (!wsSet) return [];
  const result: WsClient[] = [];
  for (const id of wsSet) {
    const c = clients.get(id);
    if (c) result.push(c);
  }
  return result;
}

async function authenticateToken(token: string): Promise<{ workspaceId: string; agentId?: string } | null> {
  const hash = hashToken(token);
  const db = getDb();

  if (token.startsWith('rk_live_')) {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.apiKeyHash, hash));
    if (!workspace) return null;
    return { workspaceId: workspace.id };
  } else if (token.startsWith('at_live_')) {
    const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));
    if (!agent) return null;
    return { workspaceId: agent.workspaceId, agentId: agent.id };
  }
  return null;
}

export function startWsServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (request: IncomingMessage, socket, head) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

      if (url.pathname !== '/v1/stream') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const token = url.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const auth = await authenticateToken(token);
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const client: WsClient = {
          id: crypto.randomUUID(),
          ws,
          workspaceId: auth.workspaceId,
          agentId: auth.agentId,
          subscriptions: new Set(),
          alive: true,
        };

        clients.set(client.id, client);
        indexAddClient(client);
        subscribeToWorkspace(auth.workspaceId).catch(() => {});

        ws.on('message', (raw) => {
          handleClientMessage(client, raw.toString());
        });

        ws.on('pong', () => {
          client.alive = true;
        });

        ws.on('close', () => {
          indexRemoveClient(client);
          clients.delete(client.id);
        });

        ws.on('error', () => {
          indexRemoveClient(client);
          clients.delete(client.id);
          ws.terminate();
        });

        ws.send(JSON.stringify({ type: 'connected', client_id: client.id }));
      });
    } catch {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  // Ping/pong keepalive every 30s
  const pingInterval = setInterval(() => {
    for (const [id, client] of clients) {
      if (!client.alive) {
        indexRemoveClient(client);
        client.ws.terminate();
        clients.delete(id);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, 30_000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  return wss;
}
