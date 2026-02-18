import type { CloudflareBindings } from '../env.js';

/** Agents not seen within this window (ms) are considered offline. */
const PRESENCE_TTL_MS = 60_000;
/** How often the alarm fires to sweep stale agents (ms). */
const ALARM_INTERVAL_MS = 60_000;

/**
 * PresenceDO — per-workspace presence tracking backed by DO Alarms.
 *
 * Each heartbeat stores a timestamp keyed by `agent:{agentId}`. A recurring
 * alarm sweeps for stale entries and publishes `agent.offline` events to
 * affected AgentDOs. When an agent heartbeats for the first time (or after
 * going offline) an `agent.online` event is published.
 */
export class PresenceDO implements DurableObject {
  private state: DurableObjectState;
  private env: CloudflareBindings;

  /** Workspace this DO belongs to — resolved on first heartbeat. */
  private workspaceId: string | null = null;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private async getWorkspaceId(): Promise<string | null> {
    if (this.workspaceId === null) {
      this.workspaceId =
        (await this.state.storage.get<string>('workspaceId')) ?? null;
    }
    return this.workspaceId;
  }

  /**
   * Return all `agent:*` entries from storage as a map of agentId → timestamp.
   */
  private async getAgentTimestamps(): Promise<Map<string, number>> {
    const entries = await this.state.storage.list<number>({ prefix: 'agent:' });
    const result = new Map<string, number>();
    for (const [key, ts] of entries) {
      result.set(key.slice('agent:'.length), ts);
    }
    return result;
  }

  /**
   * Return the set of agent IDs that are currently online.
   */
  private async getOnlineAgentIds(): Promise<string[]> {
    const now = Date.now();
    const agents = await this.getAgentTimestamps();
    const online: string[] = [];
    for (const [agentId, ts] of agents) {
      if (now - ts < PRESENCE_TTL_MS) {
        online.push(agentId);
      }
    }
    return online;
  }

  /**
   * Deliver an event to a specific AgentDO.
   */
  private async deliverToAgent(
    workspaceId: string,
    agentId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const id = this.env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`);
    const stub = this.env.AGENT_DO.get(id);
    await stub.fetch(new Request('http://do/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }));
  }

  /**
   * Broadcast a presence event to all currently-online agents.
   */
  private async broadcastPresenceEvent(
    workspaceId: string,
    onlineAgentIds: string[],
    event: Record<string, unknown>,
  ): Promise<void> {
    const promises = onlineAgentIds.map((agentId) =>
      this.deliverToAgent(workspaceId, agentId, event),
    );
    await Promise.allSettled(promises);
  }

  /**
   * Ensure the alarm is set so we keep sweeping.
   */
  private async ensureAlarm(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  HTTP handler                                                       */
  /* ------------------------------------------------------------------ */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/heartbeat') {
      return this.handleHeartbeat(request);
    }

    if (request.method === 'POST' && url.pathname === '/disconnect') {
      return this.handleDisconnect(request);
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      return this.handleStatus();
    }

    return new Response('Not Found', { status: 404 });
  }

  /* ------------------------------------------------------------------ */
  /*  POST /heartbeat                                                    */
  /* ------------------------------------------------------------------ */

  private async handleHeartbeat(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      agentId: string;
      workspaceId: string;
    };

    const { agentId, workspaceId } = body;

    // Persist workspace ID on first call.
    if ((await this.getWorkspaceId()) === null) {
      this.workspaceId = workspaceId;
      await this.state.storage.put('workspaceId', workspaceId);
    }

    // Check whether this agent was previously offline (no key or stale).
    const previousTs = await this.state.storage.get<number>(`agent:${agentId}`);
    const wasOffline =
      previousTs === undefined || Date.now() - previousTs >= PRESENCE_TTL_MS;

    // Store the new heartbeat timestamp.
    await this.state.storage.put(`agent:${agentId}`, Date.now());

    // Make sure the sweep alarm is running.
    await this.ensureAlarm();

    // If newly online, broadcast an agent.online event.
    if (wasOffline) {
      const onlineAgents = await this.getOnlineAgentIds();
      await this.broadcastPresenceEvent(workspaceId, onlineAgents, {
        type: 'agent.online',
        agentId,
        workspaceId,
        timestamp: new Date().toISOString(),
      });
    }

    return Response.json({ ok: true });
  }

  /* ------------------------------------------------------------------ */
  /*  POST /disconnect — immediately mark agent offline                  */
  /* ------------------------------------------------------------------ */

  private async handleDisconnect(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      agentId: string;
      workspaceId: string;
    };

    const { agentId, workspaceId } = body;

    // Only remove if the agent actually has a presence entry.
    const existing = await this.state.storage.get<number>(`agent:${agentId}`);
    if (existing === undefined) {
      return Response.json({ ok: true });
    }

    await this.state.storage.delete(`agent:${agentId}`);

    // Broadcast agent.offline to remaining online agents.
    const onlineAgents = await this.getOnlineAgentIds();
    await this.broadcastPresenceEvent(workspaceId, onlineAgents, {
      type: 'agent.offline',
      agentId,
      workspaceId,
      timestamp: new Date().toISOString(),
    });

    return Response.json({ ok: true });
  }

  /* ------------------------------------------------------------------ */
  /*  GET /status                                                        */
  /* ------------------------------------------------------------------ */

  private async handleStatus(): Promise<Response> {
    const onlineAgents = await this.getOnlineAgentIds();
    return Response.json({ ok: true, agents: onlineAgents });
  }

  /* ------------------------------------------------------------------ */
  /*  Alarm — sweep stale agents                                         */
  /* ------------------------------------------------------------------ */

  async alarm(): Promise<void> {
    const workspaceId = await this.getWorkspaceId();
    if (!workspaceId) return;

    const now = Date.now();
    const agents = await this.getAgentTimestamps();
    const stale: string[] = [];
    const stillOnline: string[] = [];

    for (const [agentId, ts] of agents) {
      if (now - ts >= PRESENCE_TTL_MS) {
        stale.push(agentId);
      } else {
        stillOnline.push(agentId);
      }
    }

    // Remove stale entries and broadcast offline events.
    if (stale.length > 0) {
      await this.state.storage.delete(stale.map((id) => `agent:${id}`));

      for (const agentId of stale) {
        await this.broadcastPresenceEvent(workspaceId, stillOnline, {
          type: 'agent.offline',
          agentId,
          workspaceId,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Re-arm the alarm only if there are still online agents to watch.
    if (stillOnline.length > 0) {
      await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
    }
  }
}
