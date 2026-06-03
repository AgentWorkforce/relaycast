/**
 * Presence tracking port — replaces PresenceDO.
 *
 * The 60s stale-sweep that emits `agent.status.offline` is *behavior*, not interface:
 * it lives inside the adapter (Cloudflare uses DO alarms; Node uses
 * `setInterval`) and emits via {@link RealtimeBus.deliverToAgents} +
 * `publishToWorkspaceStream`. The adapter is constructed with a reference to the
 * realtime bus so the sweep can fan out.
 */
export interface PresenceTracker {
  /** Record a heartbeat; emits `agent.status.active` if the agent was previously offline. */
  heartbeat(workspaceId: string, agentId: string, agentName?: string): Promise<void>;

  /** Mark an agent offline now; emits `agent.status.offline`. */
  disconnect(workspaceId: string, agentId: string, agentName?: string): Promise<void>;

  /** Return the agent IDs currently considered online for a workspace. */
  getOnline(workspaceId: string): Promise<string[]>;
}
