import type { CloudflareBindings } from '../env.js';
import { normalizeTelemetryOrigin } from '@relaycast/types';
import { captureInternalTelemetry, workspaceDistinctId } from '../lib/telemetry.js';

type WorkspaceConnectionMeta = {
  workspaceId?: string;
  connectedAtMs?: number;
  sessionScope?: string;
  origin_client?: string;
  origin_version?: string;
  originActor?: string;
};

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
      return this.handleWebSocketUpgrade(request);
    }

    if (request.method === 'POST' && url.pathname === '/deliver') {
      return this.handleDeliver(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const meta: WorkspaceConnectionMeta = {
      workspaceId: url.searchParams.get('workspace_id') ?? undefined,
      connectedAtMs: Date.now(),
      sessionScope: url.searchParams.get('session_scope') ?? 'workspace',
      originActor: url.searchParams.get('origin_actor') ?? 'unknown',
      ...normalizeTelemetryOrigin({
        origin_client: url.searchParams.get('origin_client') ?? undefined,
        origin_version: url.searchParams.get('origin_version') ?? undefined,
      }),
    };
    void this.state.storage.put('meta', meta);

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

  async webSocketClose(
    _ws: WebSocket,
    code: number,
    _reason: string,
    wasClean: boolean,
  ): Promise<void> {
    const remaining = this.state.getWebSockets();
    if (remaining.length > 0) return;

    const meta = await this.state.storage.get<WorkspaceConnectionMeta>('meta');
    const workspaceId = meta?.workspaceId ?? 'unknown_workspace';
    const connectedAt = meta?.connectedAtMs ?? Date.now();
    const durationMs = Math.max(Date.now() - connectedAt, 0);

    await captureInternalTelemetry(this._env, {
      event: 'relaycast_server_ws_session_ended',
      distinct_id: workspaceDistinctId(workspaceId),
      origin: normalizeTelemetryOrigin({
        origin_client: meta?.origin_client,
        origin_version: meta?.origin_version,
      }),
      properties: {
        workspace_id: workspaceId,
        origin_actor: meta?.originActor ?? 'unknown',
        session_scope: meta?.sessionScope ?? 'workspace',
        duration_ms: durationMs,
        close_code: code,
        was_clean: wasClean,
      },
    });
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Same as close — hibernation handles removal.
  }
}
