import type { PresenceTracker } from '../../ports/presence.js';
import type { RealtimeBus, EngineEvent } from '../../ports/realtime.js';
import type { EngineDb } from '../../ports/database.js';
import { appendWorkspaceEvent } from '../../engine/workspaceEvents.js';

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
  /** Optional hook for adapter-specific scoped presence side effects. */
  onPresenceEvent?: (workspaceId: string, event: EngineEvent) => Promise<void> | void;
  /**
   * When set, presence broadcasts are appended to the durable workspace event
   * log (and the published frame carries the assigned `seq`) so observers can
   * backfill `agent.status.*` transitions after a reconnect.
   */
  db?: EngineDb;
}

/**
 * Single-process presence tracker replacing PresenceDO. Heartbeats are kept in
 * a per-workspace map; a `setInterval` sweep (mirroring the DO alarm) marks
 * agents offline after the TTL and publishes `agent.status.offline` to observers
 * and the scoped presence hook. Emits `agent.status.active` on the offline→online
 * transition.
 */
export class InProcessPresence implements PresenceTracker {
  private readonly workspaces = new Map<string, Map<string, PresenceEntry>>();
  private readonly ttlMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly bus: RealtimeBus, private readonly options: InProcessPresenceOptions = {}) {
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
    type: 'agent.status.active' | 'agent.status.offline',
    agentId: string,
    name: string,
  ): EngineEvent {
    return {
      type,
      agent: { name },
      agent_name: name,
      status: type === 'agent.status.active' ? 'active' : 'offline',
      subject_agent_id: agentId,
      timestamp: new Date().toISOString(),
    };
  }

  private async broadcast(workspaceId: string, event: EngineEvent): Promise<void> {
    // Presence frames go through the durable log when a db is wired so
    // observers can backfill status transitions; append is best-effort and a
    // failure publishes the unstamped frame.
    let published: EngineEvent = event;
    if (this.options.db && typeof event.type === 'string') {
      const seq = await appendWorkspaceEvent(this.options.db, workspaceId, {
        type: event.type,
        payload: event as Record<string, unknown>,
      });
      if (seq != null) published = { ...event, seq };
    }
    await Promise.allSettled([
      this.bus.publishToWorkspaceStream({ workspaceId, event: published }),
      this.options.onPresenceEvent?.(workspaceId, event),
    ]);
  }

  async heartbeat(workspaceId: string, agentId: string, agentName?: string): Promise<void> {
    const map = this.ws(workspaceId);
    const prev = map.get(agentId);
    const wasOffline = !prev || Date.now() - prev.ts >= this.ttlMs;
    const name = agentName?.trim() || prev?.name || agentId;
    map.set(agentId, { ts: Date.now(), name });

    if (wasOffline) {
      const event = this.buildEvent('agent.status.active', agentId, name);
      await this.broadcast(workspaceId, event);
    }
  }

  async disconnect(workspaceId: string, agentId: string, agentName?: string): Promise<void> {
    const map = this.ws(workspaceId);
    const prev = map.get(agentId);
    if (!prev) return;
    const name = agentName?.trim() || prev.name || agentId;
    map.delete(agentId);
    const event = this.buildEvent('agent.status.offline', agentId, name);
    await this.broadcast(workspaceId, event);
  }

  async getOnline(workspaceId: string): Promise<string[]> {
    return this.onlineIds(workspaceId);
  }

  /** Sweep stale agents across all workspaces, emitting `agent.status.offline`. */
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
      for (const s of stale) {
        await this.broadcast(workspaceId, this.buildEvent('agent.status.offline', s.id, s.name));
      }
      // Reclaim the workspace entry once it has no tracked agents, so the map
      // doesn't grow unbounded with workspace churn.
      if (map.size === 0) this.workspaces.delete(workspaceId);
    }
  }
}
