import type { CloudflareBindings } from '../env.js';
import { fireFleetTriggersFromChannelBroadcast } from '../fleet/triggers.js';
import { createLogger, toErrorDetails } from '../lib/logger.js';

/**
 * ChannelDO — internal-only actor for sequencing and fanout.
 *
 * Each instance maps to a single channel. It keeps a monotonic sequence
 * counter and a cached member list, and fans out events to each member's
 * AgentDO via an internal POST /deliver call.
 */
export class ChannelDO implements DurableObject {
  private state: DurableObjectState;
  private env: CloudflareBindings;
  private logger: ReturnType<typeof createLogger>;

  /** Monotonic sequence counter for message ordering within this channel. */
  private channelSeq: number | null = null;
  /** Cached set of agent IDs that belong to this channel. */
  private members: string[] | null = null;
  /** Cached set of muted agent IDs for this channel. */
  private mutedMembers: string[] | null = null;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env, { source: 'channel_do' });
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private async getChannelSeq(): Promise<number> {
    if (this.channelSeq === null) {
      this.channelSeq = (await this.state.storage.get<number>('channel_seq')) ?? 0;
    }
    return this.channelSeq;
  }

  private async incrementChannelSeq(): Promise<number> {
    const next = (await this.getChannelSeq()) + 1;
    this.channelSeq = next;
    await this.state.storage.put('channel_seq', next);
    return next;
  }

  private async getMembers(): Promise<string[]> {
    if (this.members === null) {
      this.members = (await this.state.storage.get<string[]>('members')) ?? [];
    }
    return this.members;
  }

  private async getMutedMembers(): Promise<string[]> {
    if (this.mutedMembers === null) {
      this.mutedMembers = (await this.state.storage.get<string[]>('muted_members')) ?? [];
    }
    return this.mutedMembers;
  }

  /**
   * Fan out an event payload to every member AgentDO via POST /deliver.
   *
   * Uses Promise.allSettled so one agent's failure doesn't block others.
   * Failed deliveries are logged; the event is already persisted in D1
   * and can be picked up by the agent on resync.
   */
  private async fanOut(
    workspaceId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const members = await this.getMembers();
    const mutedList = await this.getMutedMembers();
    // Short-circuit: skip mute filtering entirely when nobody is muted
    let deliverTo = members;
    if (mutedList.length > 0) {
      // Only suppress message events for muted members — system/control events
      // (channel.updated, member.joined, member.left, mute/unmute confirmations)
      // must still be delivered so agents stay in sync.
      const eventType = typeof payload.type === 'string' ? payload.type : '';
      const isMessageEvent = eventType === 'message.created' || eventType === 'message' || eventType === 'thread.reply';
      if (isMessageEvent) {
        const muted = new Set(mutedList);
        deliverTo = members.filter((id) => !muted.has(id));
      }
    }
    const promises = deliverTo.map((agentId) => {
      const id = this.env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`);
      const stub = this.env.AGENT_DO.get(id);
      return stub.fetch(new Request('http://do/deliver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, workspaceId, agentId }),
      }));
    });
    const results = await Promise.allSettled(promises);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        this.logger.error(`fanout failed for agent ${deliverTo[i]} in workspace ${workspaceId}`, {
          workspace_id: workspaceId,
          agent_id: deliverTo[i],
          ...toErrorDetails(result.reason),
        });
      } else if (!result.value.ok) {
        this.logger.error(`fanout returned ${result.value.status} for agent ${deliverTo[i]} in workspace ${workspaceId}`, {
          workspace_id: workspaceId,
          agent_id: deliverTo[i],
          status: result.value.status,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  HTTP handler                                                       */
  /* ------------------------------------------------------------------ */

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === '/broadcast') {
        return this.handleBroadcast(request);
      }

      if (request.method === 'POST' && url.pathname === '/update-members') {
        return this.handleUpdateMembers(request);
      }

      if (request.method === 'POST' && url.pathname === '/update-muted') {
        return this.handleUpdateMuted(request);
      }

      return new Response('Not Found', { status: 404 });
    } finally {
      await this.logger.flush();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  POST /broadcast                                                    */
  /* ------------------------------------------------------------------ */

  private async handleBroadcast(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      event: Record<string, unknown>;
      workspaceId: string;
      channelId?: string;
      members?: string[]; // Optional: caller can provide members for cache initialization
    };

    // If members provided and cache is empty, initialize cache
    // This handles cold-start scenarios where DO storage was cleared
    const currentMembers = await this.getMembers();
    if (body.members && body.members.length > 0 && currentMembers.length === 0) {
      this.members = body.members;
      await this.state.storage.put('members', body.members);
      this.logger.info(`Initialized members cache with ${body.members.length} members`, {
        workspace_id: body.workspaceId,
        channel_id: body.channelId ?? 'unknown',
        member_count: body.members.length,
      });
    }

    // If still no members, try loading from D1 as fallback
    if ((await this.getMembers()).length === 0 && body.channelId && body.workspaceId) {
      try {
        const members = await this.loadMembersFromDb(body.workspaceId, body.channelId);
        if (members.length > 0) {
          this.members = members;
          await this.state.storage.put('members', members);
          this.logger.info(`Loaded ${members.length} members from D1 for channel ${body.channelId}`, {
            workspace_id: body.workspaceId,
            channel_id: body.channelId,
            member_count: members.length,
          });
        }
      } catch (err) {
        this.logger.error('Failed to load members from D1', {
          workspace_id: body.workspaceId,
          channel_id: body.channelId,
          ...toErrorDetails(err),
        });
      }
    }

    // Load muted members from D1 on cold start if needed
    if ((await this.getMutedMembers()).length === 0 && body.channelId && body.workspaceId) {
      try {
        const muted = await this.loadMutedFromDb(body.channelId);
        if (muted.length > 0) {
          this.mutedMembers = muted;
          await this.state.storage.put('muted_members', muted);
        }
      } catch (err) {
        this.logger.error('Failed to load muted members from D1', {
          workspace_id: body.workspaceId,
          channel_id: body.channelId,
          ...toErrorDetails(err),
        });
      }
    }

    const seq = await this.incrementChannelSeq();
    const payload = { ...body.event, channel_seq: seq };

    await this.fanOut(body.workspaceId, payload);
    await fireFleetTriggersFromChannelBroadcast(
      this.env,
      body.workspaceId,
      body.channelId ?? String((body.event as { channel_id?: unknown } | null | undefined)?.channel_id ?? ''),
      body.event,
    ).catch((err) => {
      this.logger.error('failed to evaluate fleet triggers', {
        workspace_id: body.workspaceId,
        channel_id: body.channelId ?? 'unknown',
        ...toErrorDetails(err),
      });
    });

    return Response.json({ ok: true, channel_seq: seq });
  }

  /**
   * Load channel members from D1 as a fallback when DO cache is empty.
   */
  private async loadMembersFromDb(workspaceId: string, channelId: string): Promise<string[]> {
    const { getDb } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');

    const db = getDb(this.env.DB);
    const result = await db.all<{ agent_id: string }>(sql`
      SELECT agent_id FROM channel_members
      WHERE channel_id = ${channelId}
    `);

    return result.map((row) => row.agent_id);
  }

  /**
   * Load muted member IDs from D1 as a fallback when DO cache is empty.
   */
  private async loadMutedFromDb(channelId: string): Promise<string[]> {
    const { getDb } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');

    const db = getDb(this.env.DB);
    const result = await db.all<{ agent_id: string }>(sql`
      SELECT agent_id FROM channel_members
      WHERE channel_id = ${channelId} AND is_muted = 1
    `);

    return result.map((row) => row.agent_id);
  }

  /* ------------------------------------------------------------------ */
  /*  POST /update-members                                               */
  /* ------------------------------------------------------------------ */

  private async handleUpdateMembers(request: Request): Promise<Response> {
    const body = (await request.json()) as { members: string[] };

    this.members = body.members;
    await this.state.storage.put('members', body.members);

    return Response.json({ ok: true });
  }

  /* ------------------------------------------------------------------ */
  /*  POST /update-muted                                                 */
  /* ------------------------------------------------------------------ */

  private async handleUpdateMuted(request: Request): Promise<Response> {
    const body = (await request.json()) as { muted: string[] };

    this.mutedMembers = body.muted;
    await this.state.storage.put('muted_members', body.muted);

    return Response.json({ ok: true });
  }
}
