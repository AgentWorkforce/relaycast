/**
 * Shared storage keys + workspace scoping for the persisted Activity feed.
 *
 * The live WebSocket feed is cached in localStorage so a refresh restores
 * recent activity. Because the key is shared across the observer origin, the
 * cache must be reset whenever the active workspace changes (e.g. logging in
 * with a different `?key=`), so one workspace's agent/channel/error summaries
 * never hydrate another workspace's dashboard.
 */
export const WS_EVENTS_STORAGE_KEY = 'relaycast-observer-ws-events';
const WS_WORKSPACE_FINGERPRINT_KEY = 'relaycast-observer-ws-workspace';

/**
 * Derive a short, non-reversible fingerprint of the workspace key (djb2). Used
 * only to detect workspace changes — never to reconstruct the key, which is why
 * the raw key is never written to localStorage.
 */
function fingerprintWorkspace(apiKey: string): string {
  let hash = 5381;
  for (let i = 0; i < apiKey.length; i += 1) {
    hash = ((hash << 5) + hash + apiKey.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Clear the persisted activity feed when the active workspace differs from the
 * one it was captured under. Safe to call on every session resolve; it only
 * touches storage when the workspace actually changes.
 */
export function resetActivityIfWorkspaceChanged(apiKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    const fingerprint = fingerprintWorkspace(apiKey);
    if (window.localStorage.getItem(WS_WORKSPACE_FINGERPRINT_KEY) !== fingerprint) {
      window.localStorage.removeItem(WS_EVENTS_STORAGE_KEY);
      window.localStorage.setItem(WS_WORKSPACE_FINGERPRINT_KEY, fingerprint);
    }
  } catch {
    // Ignore storage failures (private mode / quota).
  }
}
