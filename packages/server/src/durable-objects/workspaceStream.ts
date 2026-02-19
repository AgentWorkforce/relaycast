import type { CloudflareBindings } from '../env.js';

/**
 * WorkspaceStreamDO — workspace-level websocket fanout.
 *
 * Auth is handled by the edge worker route; this DO only upgrades sockets
 * and broadcasts events pushed via POST /deliver.
 */
export class WorkspaceStreamDO implements DurableObject {
  private state: DurableObjectState;
  private _env: CloudflareBindings;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this._env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/ws') {
      return this.handleWebSocketUpgrade();
    }

    if (request.method === 'POST' && url.pathname === '/deliver') {
      return this.handleDeliver(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleDeliver(request: Request): Promise<Response> {
    const payload = await request.json();
    const data = JSON.stringify(payload);
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        // Socket may have closed between enumeration and send.
      }
    }
    return Response.json({ ok: true });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    try {
      const parsed = JSON.parse(message) as { type?: string };
      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch {
      // Ignore malformed frames.
    }
  }
}
