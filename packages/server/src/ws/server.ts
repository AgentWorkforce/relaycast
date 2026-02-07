import { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { workspaces, agents } from '../db/schema.js';

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

export function getClients(): Map<string, WsClient> {
  return clients;
}

export function getClientsByWorkspace(workspaceId: string): WsClient[] {
  return Array.from(clients.values()).filter(c => c.workspaceId === workspaceId);
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

        ws.on('pong', () => {
          client.alive = true;
        });

        ws.on('close', () => {
          clients.delete(client.id);
        });

        ws.on('error', () => {
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
