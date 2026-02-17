import type { CloudflareBindings } from '../env.js';

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

  /** Monotonic sequence counter for message ordering within this channel. */
  private channelSeq: number | null = null;
  /** Cached set of agent IDs that belong to this channel. */
  private members: string[] | null = null;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
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

  /**
   * Fan out an event payload to every member AgentDO via POST /deliver.
   *
   * Uses Promise.allSettled so one agent's failure doesn't block others.
   * Failed deliveries are logged; the event is already persisted in Postgres
   * and can be picked up by the agent on resync.
   */
  private async fanOut(
    workspaceId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const members = await this.getMembers();
    const promises = members.map((agentId) => {
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
        console.error(
          `[ChannelDO] fanout failed for agent ${members[i]} in workspace ${workspaceId}:`,
          result.reason,
        );
      } else if (!result.value.ok) {
        console.error(
          `[ChannelDO] fanout returned ${result.value.status} for agent ${members[i]} in workspace ${workspaceId}`,
        );
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  HTTP handler                                                       */
  /* ------------------------------------------------------------------ */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/broadcast') {
      return this.handleBroadcast(request);
    }

    if (request.method === 'POST' && url.pathname === '/update-members') {
      return this.handleUpdateMembers(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  /* ------------------------------------------------------------------ */
  /*  POST /broadcast                                                    */
  /* ------------------------------------------------------------------ */

  private async handleBroadcast(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      event: Record<string, unknown>;
      workspaceId: string;
    };

    const seq = await this.incrementChannelSeq();
    const payload = { ...body.event, channel_seq: seq };

    await this.fanOut(body.workspaceId, payload);

    return Response.json({ ok: true, channel_seq: seq });
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
}
