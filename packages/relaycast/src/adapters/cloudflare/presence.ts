import type { PresenceTracker } from '@relaycast/engine/ports';
import type { CloudflareBindings } from '../../env.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** PresenceDO-backed implementation of the presence port. */
export function createCloudflarePresence(env: CloudflareBindings): PresenceTracker {
  function stub(workspaceId: string) {
    return env.PRESENCE_DO.get(env.PRESENCE_DO.idFromName(workspaceId));
  }
  return {
    async heartbeat(workspaceId, agentId, agentName) {
      await stub(workspaceId).fetch(new Request('http://do/heartbeat', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ agentId, workspaceId, agentName }),
      }));
    },
    async disconnect(workspaceId, agentId, agentName) {
      await stub(workspaceId).fetch(new Request('http://do/disconnect', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ agentId, workspaceId, agentName }),
      }));
    },
    async getOnline(workspaceId) {
      const res = await stub(workspaceId).fetch(new Request('http://do/status'));
      const body = (await res.json().catch(() => ({}))) as { agents?: string[] };
      return body.agents ?? [];
    },
  };
}
