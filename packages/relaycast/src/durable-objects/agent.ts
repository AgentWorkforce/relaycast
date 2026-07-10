import type { CloudflareBindings } from '../env.js';
import { transformForClient, type WsEvent } from '../engine/wsTransform.js';
import { normalizeTelemetryOrigin, type TelemetryOrigin } from '@relaycast/types';
import { captureInternalTelemetry, workspaceDistinctId } from '../lib/telemetry.js';

/**
 * Maximum number of recent events kept in DO storage for fast resync.
 * Events beyond this window require a D1 query.
 */
const RESYNC_BUFFER_SIZE = 500;

type AgentConnectionMeta = {
  workspaceId?: string;
  agentId?: string;
  connectedAtMs?: number;
  sessionScope?: string;
  origin_client?: string;
  origin_version?: string;
  originActor?: string;
};

/**
 * AgentDO — the single client-facing WebSocket actor per agent.
 *
 * All events destined for an agent (from ChannelDO, PresenceDO, or Edge
 * Worker) flow through POST /deliver. The DO increments its own agent_seq,
 * attaches it to the payload, and broadcasts to every connected WebSocket.
 *
 * Uses the hibernation API so the DO can be evicted between messages,
 * keeping costs low for idle agents.
 *
 * Resync: Recent events are stored in DO storage keyed as `evt:{seq}`.
 * On reconnect the client sends `{ type: "resync", last_seen_seq: N }`
 * and the DO replays all buffered events with seq > N.  For gaps larger
 * than the buffer, a D1 fallback query is used.
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

  /**
   * Store an event in the ring buffer and evict old entries.
   */
  private async bufferEvent(seq: number, payload: Record<string, unknown>): Promise<void> {
    await this.state.storage.put(`evt:${seq}`, payload);

    // Evict the oldest event if we've exceeded the buffer size.
    const evictSeq = seq - RESYNC_BUFFER_SIZE;
    if (evictSeq > 0) {
      await this.state.storage.delete(`evt:${evictSeq}`);
    }
  }

  /**
   * Replay buffered events with seq > lastSeenSeq to a single WebSocket.
   */
  private async replayBufferedEvents(
    ws: WebSocket,
    lastSeenSeq: number,
  ): Promise<{ replayed: number; gapDetected: boolean }> {
    const currentSeq = await this.getAgentSeq();

    if (lastSeenSeq >= currentSeq) {
      return { replayed: 0, gapDetected: false };
    }

    // Calculate the range we can serve from the buffer.
    const oldestBuffered = Math.max(1, currentSeq - RESYNC_BUFFER_SIZE + 1);
    const gapDetected = lastSeenSeq < oldestBuffered - 1;

    const startSeq = Math.max(lastSeenSeq + 1, oldestBuffered);
    const events: Record<string, unknown>[] = [];

    // Batch-read from DO storage.
    const keys: string[] = [];
    for (let s = startSeq; s <= currentSeq; s++) {
      keys.push(`evt:${s}`);
    }

    if (keys.length > 0) {
      const entries = await this.state.storage.get<Record<string, unknown>>(keys);
      for (let s = startSeq; s <= currentSeq; s++) {
        const evt = entries.get(`evt:${s}`);
        if (evt) {
          events.push(evt);
        }
      }
    }

    // Send all buffered events to the socket.
    for (const evt of events) {
      try {
        ws.send(JSON.stringify(evt));
      } catch {
        break; // Socket closed mid-replay.
      }
    }

    return { replayed: events.length, gapDetected };
  }

  /**
   * Replay missed events from D1 for gaps larger than the DO buffer.
   * Queries messages in channels the agent belongs to, plus DMs, that were
   * created after the given timestamp.
   */
  private async replayFromDb(
    ws: WebSocket,
    agentId: string,
    workspaceId: string,
    since: string, // ISO timestamp
  ): Promise<number> {
    const { getDb } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');

    const db = getDb(this.env.DB);
    const sinceUnix = Math.floor(new Date(since).getTime() / 1000);

    const events: Array<{ ts: number; payload: Record<string, unknown> }> = [];

    const buildEvent = (
      type: string,
      data: Record<string, unknown>,
      channelId?: string,
    ): Record<string, unknown> => {
      const event: WsEvent = {
        type,
        workspace_id: workspaceId,
        channel_id: channelId,
        data,
        timestamp: new Date().toISOString(),
      };
      return transformForClient(event);
    };

    // Channel messages (including thread replies) after `since`.
    const channelRows = await db.all<Record<string, unknown>>(sql`
      SELECT m.id, m.channel_id, m.agent_id, m.body, m.thread_id,
             m.created_at, c.name AS channel_name, a.name AS agent_name
      FROM messages m
      JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.agent_id = ${agentId}
      JOIN channels c ON c.id = m.channel_id
      LEFT JOIN agents a ON a.id = m.agent_id
      WHERE m.workspace_id = ${workspaceId}
        AND m.created_at > ${sinceUnix}
      ORDER BY m.created_at ASC
      LIMIT 1000
    `);

    for (const row of channelRows) {
      const data = {
        id: row.id,
        channel_id: row.channel_id,
        channel_name: row.channel_name,
        agent_id: row.agent_id,
        from_name: row.agent_name,
        text: row.body,
        thread_id: row.thread_id,
        created_at: new Date((row.created_at as number) * 1000).toISOString(),
      } as Record<string, unknown>;

      const type = row.thread_id ? 'thread.reply' : 'message.created';
      events.push({
        ts: (row.created_at as number) * 1000,
        payload: { ...buildEvent(type, data, row.channel_id as string | undefined), replayed: true },
      });
    }

    // DM + group DM messages after `since`.
    const dmRows = await db.all<Record<string, unknown>>(sql`
      SELECT m.id, m.channel_id, m.agent_id, m.body, m.created_at,
             a.name AS agent_name, dc.id AS conversation_id, dc.dm_type
      FROM dm_conversations dc
      JOIN dm_participants dp ON dp.conversation_id = dc.id AND dp.agent_id = ${agentId} AND dp.left_at IS NULL
      JOIN messages m ON m.channel_id = dc.channel_id
      LEFT JOIN agents a ON a.id = m.agent_id
      WHERE dc.workspace_id = ${workspaceId}
        AND m.created_at > ${sinceUnix}
      ORDER BY m.created_at ASC
      LIMIT 1000
    `);

    for (const row of dmRows) {
      const type = row.dm_type === 'group' ? 'group_dm.received' : 'dm.received';
      const data = {
        id: row.id,
        conversation_id: row.conversation_id,
        agent_id: row.agent_id,
        from_agent_id: row.agent_id,
        from_name: row.agent_name,
        text: row.body,
        created_at: new Date((row.created_at as number) * 1000).toISOString(),
      } as Record<string, unknown>;
      events.push({
        ts: (row.created_at as number) * 1000,
        payload: { ...buildEvent(type, data, row.channel_id as string | undefined), replayed: true },
      });
    }

    // Reaction additions after `since`.
    const reactionRows = await db.all<Record<string, unknown>>(sql`
      SELECT r.message_id, r.emoji, r.created_at,
             a.name AS agent_name,
             m.channel_id, c.name AS channel_name, c.channel_type,
             dc.dm_type, dc.id AS conversation_id
      FROM reactions r
      JOIN messages m ON m.id = r.message_id
      JOIN channels c ON c.id = m.channel_id
      LEFT JOIN dm_conversations dc ON dc.channel_id = m.channel_id
      LEFT JOIN dm_participants dp ON dp.conversation_id = dc.id AND dp.agent_id = ${agentId} AND dp.left_at IS NULL
      LEFT JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.agent_id = ${agentId}
      LEFT JOIN agents a ON a.id = r.agent_id
      WHERE m.workspace_id = ${workspaceId}
        AND r.created_at > ${sinceUnix}
        AND (cm.agent_id IS NOT NULL OR dp.agent_id IS NOT NULL)
      ORDER BY r.created_at ASC
      LIMIT 1000
    `);

    for (const row of reactionRows) {
      const data = {
        message_id: row.message_id,
        emoji: row.emoji,
        agent_name: row.agent_name,
        channel_name: row.channel_name,
        action: 'added',
      } as Record<string, unknown>;
      events.push({
        ts: (row.created_at as number) * 1000,
        payload: { ...buildEvent('message.reacted', data, row.channel_id as string | undefined), replayed: true },
      });
    }

    // Send events in chronological order.
    events.sort((a, b) => a.ts - b.ts);
    let count = 0;
    for (const event of events) {
      try {
        ws.send(JSON.stringify(event.payload));
        count++;
      } catch {
        break;
      }
    }

    return count;
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

    if (request.method === 'POST' && url.pathname === '/force-disconnect') {
      return this.handleForceDisconnect();
    }

    return new Response('Not Found', { status: 404 });
  }

  /* ------------------------------------------------------------------ */
  /*  GET /ws — WebSocket upgrade (hibernation)                          */
  /* ------------------------------------------------------------------ */

  private handleWebSocketUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const connectionMeta: AgentConnectionMeta = {
      workspaceId: url.searchParams.get('workspace_id') ?? undefined,
      agentId: url.searchParams.get('agent_id') ?? undefined,
      connectedAtMs: Date.now(),
      sessionScope: url.searchParams.get('session_scope') ?? 'agent',
      originActor: url.searchParams.get('origin_actor') ?? 'unknown',
      ...normalizeTelemetryOrigin({
        origin_client: url.searchParams.get('origin_client') ?? undefined,
        origin_version: url.searchParams.get('origin_version') ?? undefined,
      }),
    };

    void this.state.storage.put('meta', connectionMeta);

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

    // Persist agent identity for ping/disconnect presence updates.
    // This can arrive before message traffic (e.g. presence fanout), so keep it current.
    if (event.workspaceId && event.agentId) {
      const currentMeta = (await this.state.storage.get<AgentConnectionMeta>('meta')) ?? {};
      await this.state.storage.put('meta', {
        ...currentMeta,
        workspaceId: event.workspaceId as string,
        agentId: event.agentId as string,
      } satisfies AgentConnectionMeta);
    }

    const seq = await this.incrementAgentSeq();
    const payload = { ...event, agent_seq: seq };

    // Buffer for resync and broadcast to live sockets.
    await this.bufferEvent(seq, payload);
    this.broadcastToSockets(payload);

    return Response.json({ ok: true, agent_seq: seq });
  }

  /* ------------------------------------------------------------------ */
  /*  POST /force-disconnect — close all sockets & disconnect presence   */
  /* ------------------------------------------------------------------ */

  private async handleForceDisconnect(): Promise<Response> {
    // Close all WebSockets so no further pings can trigger heartbeats.
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1000, 'force-disconnect'); } catch { /* already closed */ }
    }

    // Send the authoritative disconnect to PresenceDO. Because the DO
    // runtime serializes handlers, this runs AFTER any in-flight
    // webSocketMessage (ping heartbeat), guaranteeing the agent ends
    // up offline.
    const meta = await this.state.storage.get<AgentConnectionMeta>('meta');
    if (meta?.workspaceId && meta?.agentId) {
      const doId = this.env.PRESENCE_DO.idFromName(meta.workspaceId);
      const stub = this.env.PRESENCE_DO.get(doId);
      await stub.fetch(new Request('http://do/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: meta.agentId, workspaceId: meta.workspaceId }),
      })).catch(() => {});
    }

    return Response.json({ ok: true });
  }

  /* ------------------------------------------------------------------ */
  /*  Hibernation WebSocket handlers                                     */
  /* ------------------------------------------------------------------ */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const parsed = JSON.parse(message) as {
        type?: string;
        last_seen_seq?: number;
        since?: string;
      };

      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        // Refresh presence so the agent stays "online" in PresenceDO.
        // Await the fetch so the heartbeat completes at PresenceDO before
        // this handler returns. The DO runtime serializes message handlers
        // and webSocketClose, so awaiting here guarantees the heartbeat
        // settles before any subsequent disconnect is processed.
        const meta = await this.state.storage.get<{ workspaceId: string; agentId: string }>('meta');
        if (meta) {
          const doId = this.env.PRESENCE_DO.idFromName(meta.workspaceId);
          const stub = this.env.PRESENCE_DO.get(doId);
          await stub.fetch(new Request('http://do/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: meta.agentId, workspaceId: meta.workspaceId }),
          })).catch(() => {});
        }
        return;
      }

      if (parsed.type === 'resync' && typeof parsed.last_seen_seq === 'number') {
        const { replayed, gapDetected } = await this.replayBufferedEvents(
          ws,
          parsed.last_seen_seq,
        );

        // If there's a gap beyond the buffer, try D1 fallback.
        let pgReplayed = 0;
        if (gapDetected && parsed.since) {
          const meta = await this.state.storage.get<{ workspaceId: string; agentId: string }>('meta');
          if (meta) {
            pgReplayed = await this.replayFromDb(
              ws,
              meta.agentId,
              meta.workspaceId,
              parsed.since,
            );
          }
        }

        ws.send(JSON.stringify({
          type: 'resync_ack',
          last_seen_seq: parsed.last_seen_seq,
          current_seq: await this.getAgentSeq(),
          replayed: replayed + pgReplayed,
          gap_detected: gapDetected,
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
    // Hibernation API removes the socket from getWebSockets() automatically.
    // If no sockets remain, notify PresenceDO so the agent goes offline immediately.
    const remaining = this.state.getWebSockets();
    if (remaining.length === 0) {
      const meta = await this.state.storage.get<AgentConnectionMeta>('meta');
      if (meta) {
        const workspaceId = meta.workspaceId;
        const agentId = meta.agentId;
        if (workspaceId && agentId) {
          const doId = this.env.PRESENCE_DO.idFromName(workspaceId);
          const stub = this.env.PRESENCE_DO.get(doId);
          await stub.fetch(new Request('http://do/disconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, workspaceId }),
          })).catch(() => {});
        }

        const origin: TelemetryOrigin = normalizeTelemetryOrigin({
          origin_client: meta.origin_client,
          origin_version: meta.origin_version,
        });
        const resolvedWorkspaceId = workspaceId ?? 'unknown_workspace';
        const connectedAt = meta.connectedAtMs ?? Date.now();
        const durationMs = Math.max(Date.now() - connectedAt, 0);

        await captureInternalTelemetry(this.env, {
          event: 'relaycast_server_ws_session_ended',
          distinct_id: workspaceDistinctId(resolvedWorkspaceId),
          origin,
          properties: {
            workspace_id: resolvedWorkspaceId,
            origin_actor: meta.originActor ?? 'unknown',
            session_scope: meta.sessionScope ?? 'agent',
            duration_ms: durationMs,
            close_code: _code,
            was_clean: _wasClean,
          },
        });
      }
    }
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Same as close — hibernation handles removal.
  }
}
