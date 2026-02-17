import type { CloudflareBindings } from '../env.js';

/**
 * AgentDO — the single client-facing WebSocket actor per agent.
 *
 * All events destined for an agent (from ChannelDO, PresenceDO, or Edge
 * Worker) flow through POST /deliver. The DO increments its own agent_seq,
 * attaches it to the payload, and broadcasts to every connected WebSocket.
 *
 * Uses the hibernation API so the DO can be evicted between messages,
 * keeping costs low for idle agents.
 */
export class AgentDO implements DurableObject {
  private state: DurableObjectState;
  private env: CloudflareBindings;

  /** Monotonic sequence counter scoped to this agent. */
  private agentSeq: number | null = null;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private async getAgentSeq(): Promise<number> {
    if (this.agentSeq === null) {
      this.agentSeq = (await this.state.storage.get<number>('agent_seq')) ?? 0;
    }
    return this.agentSeq;
  }

  private async incrementAgentSeq(): Promise<number> {
    const next = (await this.getAgentSeq()) + 1;
    this.agentSeq = next;
    await this.state.storage.put('agent_seq', next);
    return next;
  }

  /**
   * Send a JSON payload to every connected WebSocket.
   */
  private broadcastToSockets(payload: Record<string, unknown>): void {
    const sockets = this.state.getWebSockets();
    const data = JSON.stringify(payload);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        // Socket may have closed between getWebSockets() and send().
        // Hibernation API will fire webSocketClose for cleanup.
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  HTTP handler                                                       */
  /* ------------------------------------------------------------------ */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/ws') {
      return this.handleWebSocketUpgrade(request);
    }

    if (request.method === 'POST' && url.pathname === '/deliver') {
      return this.handleDeliver(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  /* ------------------------------------------------------------------ */
  /*  GET /ws — WebSocket upgrade (hibernation)                          */
  /* ------------------------------------------------------------------ */

  private handleWebSocketUpgrade(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept using the hibernation API so the DO can be evicted between
    // messages and only wake on incoming frames.
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ------------------------------------------------------------------ */
  /*  POST /deliver — receive event, stamp with agent_seq, broadcast     */
  /* ------------------------------------------------------------------ */

  private async handleDeliver(request: Request): Promise<Response> {
    const event = (await request.json()) as Record<string, unknown>;

    const seq = await this.incrementAgentSeq();
    const payload = { ...event, agent_seq: seq };

    this.broadcastToSockets(payload);

    return Response.json({ ok: true, agent_seq: seq });
  }

  /* ------------------------------------------------------------------ */
  /*  Hibernation WebSocket handlers                                     */
  /* ------------------------------------------------------------------ */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const parsed = JSON.parse(message) as { type?: string; last_seen_seq?: number };

      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (parsed.type === 'resync' && typeof parsed.last_seen_seq === 'number') {
        // TODO: Query Postgres for missed events since last_seen_seq and
        // replay them to this socket. For now, acknowledge the request.
        ws.send(JSON.stringify({
          type: 'resync_ack',
          last_seen_seq: parsed.last_seen_seq,
          events: [],
        }));
        return;
      }
    } catch {
      // Malformed JSON — ignore.
    }
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // No explicit cleanup needed — the hibernation API removes the socket
    // from getWebSockets() automatically.
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Same as close — hibernation handles removal.
  }
}
