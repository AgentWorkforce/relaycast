import type { PresenceTracker } from '../../ports/presence.js';
import type { RealtimeBus, EngineEvent } from '../../ports/realtime.js';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_SWEEP_MS = 60_000;

interface PresenceEntry {
  ts: number;
  name?: string;
}

export interface InProcessPresenceOptions {
  /** Agents not seen within this window are considered offline. */
  ttlMs?: number;
  /** How often the stale-sweep runs. Set 0 to disable the timer (tests call sweep() directly). */
  sweepIntervalMs?: number;
}

/**
 * Single-process presence tracker replacing PresenceDO. Heartbeats are kept in
 * a per-workspace map; a `setInterval` sweep (mirroring the DO alarm) marks
 * agents offline after the TTL and fans out `agent.offline` events through the
 * realtime bus. Emits `agent.online` on the offline→online transition.
 */
export class InProcessPresence implements PresenceTracker {
  private readonly workspaces = new Map<string, Map<string, PresenceEntry>>();
  private readonly ttlMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly bus: RealtimeBus, options: InProcessPresenceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const sweepMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    if (sweepMs > 0) {
      this.timer = setInterval(() => {
        void this.sweep();
      }, sweepMs);
      // Don't keep the Node process alive solely for the presence sweep.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Stop the sweep timer (server shutdown / test teardown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private ws(workspaceId: string): Map<string, PresenceEntry> {
    let m = this.workspaces.get(workspaceId);
    if (!m) {
      m = new Map();
      this.workspaces.set(workspaceId, m);
    }
    return m;
  }

  private onlineIds(workspaceId: string): string[] {
    const now = Date.now();
    const out: string[] = [];
    for (const [agentId, entry] of this.ws(workspaceId)) {
      if (now - entry.ts < this.ttlMs) out.push(agentId);
    }
    return out;
  }

  private buildEvent(
    type: 'agent.online' | 'agent.offline',
    agentId: string,
    name: string,
  ): EngineEvent {
    return {
      type,
      agent: { name },
      agent_name: name,
      subject_agent_id: agentId,
      timestamp: new Date().toISOString(),
    };
  }

  private async broadcast(workspaceId: string, onlineAgentIds: string[], event: EngineEvent): Promise<void> {
    await Promise.allSettled([
      this.bus.deliverToAgents({ workspaceId, agentIds: onlineAgentIds, event }),
      this.bus.publishToWorkspaceStream({ workspaceId, event }),
    ]);
  }

  async heartbeat(workspaceId: string, agentId: string, agentName?: string): Promise<void> {
    const map = this.ws(workspaceId);
    const prev = map.get(agentId);
    const wasOffline = !prev || Date.now() - prev.ts >= this.ttlMs;
    const name = agentName?.trim() || prev?.name || agentId;
    map.set(agentId, { ts: Date.now(), name });

    if (wasOffline) {
      const event = this.buildEvent('agent.online', agentId, name);
      await this.broadcast(workspaceId, this.onlineIds(workspaceId), event);
    }
  }

  async disconnect(workspaceId: string, agentId: string, agentName?: string): Promise<void> {
    const map = this.ws(workspaceId);
    const prev = map.get(agentId);
    if (!prev) return;
    const name = agentName?.trim() || prev.name || agentId;
    map.delete(agentId);
    const event = this.buildEvent('agent.offline', agentId, name);
    await this.broadcast(workspaceId, this.onlineIds(workspaceId), event);
  }

  async getOnline(workspaceId: string): Promise<string[]> {
    return this.onlineIds(workspaceId);
  }

  /** Sweep stale agents across all workspaces, emitting `agent.offline`. */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [workspaceId, map] of this.workspaces) {
      const stale: Array<{ id: string; name: string }> = [];
      for (const [agentId, entry] of map) {
        if (now - entry.ts >= this.ttlMs) {
          stale.push({ id: agentId, name: entry.name ?? agentId });
        }
      }
      if (stale.length === 0) continue;
      for (const s of stale) map.delete(s.id);
      const stillOnline = this.onlineIds(workspaceId);
      for (const s of stale) {
        await this.broadcast(workspaceId, stillOnline, this.buildEvent('agent.offline', s.id, s.name));
      }
      // Reclaim the workspace entry once it has no tracked agents, so the map
      // doesn't grow unbounded with workspace churn.
      if (map.size === 0) this.workspaces.delete(workspaceId);
    }
  }
}
