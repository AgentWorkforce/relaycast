/**
 * Presence tracking port — replaces PresenceDO.
 *
 * The 60s stale-sweep that emits `agent.status.offline` is *behavior*, not interface:
 * it lives inside the adapter (Cloudflare uses DO alarms; Node uses
 * `setInterval`) and emits through the adapter's configured fanout hooks.
 */
export interface PresenceTracker {
  /** Record a heartbeat; emits `agent.status.active` if the agent was previously offline. */
  heartbeat(workspaceId: string, agentId: string, agentName?: string): Promise<void>;

  /** Mark an agent offline now; emits `agent.status.offline`. */
  disconnect(workspaceId: string, agentId: string, agentName?: string): Promise<void>;

  /** Return the agent IDs currently considered online for a workspace. */
  getOnline(workspaceId: string): Promise<string[]>;

  /**
   * Agents that called disconnect and have not heartbeated since.
   * Node-derived presence must not put these ids back online. A host that
   * omits this treats disconnect as tracker-only, which cannot override
   * node liveness.
   */
  explicitlyDisconnected?(workspaceId: string): Promise<readonly string[]>;

  /**
   * Forget an explicit disconnect so node liveness can count the agent again.
   * {@link heartbeat} does this itself. Called when a node newly routes an
   * agent that had left, which is the node-side recovery of a presence hold.
   */
  clearExplicitDisconnect?(workspaceId: string, agentId: string): Promise<void>;
}
