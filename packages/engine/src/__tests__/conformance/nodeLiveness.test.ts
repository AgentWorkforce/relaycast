import { describe, expect, it } from 'vitest';
import { isProviderLive } from '../../engine/nodeProvider.js';
import { isNodeLive, NODE_LIVENESS_TTL_MS } from '../../engine/placement.js';

const NOW = 1_700_000_000_000;

describe('node heartbeat freshness', () => {
  it('accepts a recent server timestamp and rejects stale or future timestamps', () => {
    expect(isNodeLive({ status: 'online', lastHeartbeatAt: new Date(NOW - 1_000) }, NOW)).toBe(true);
    expect(isNodeLive({ status: 'online', lastHeartbeatAt: new Date(NOW - NODE_LIVENESS_TTL_MS - 1) }, NOW)).toBe(false);
    expect(isNodeLive({ status: 'online', lastHeartbeatAt: new Date(NOW + 1) }, NOW)).toBe(false);
  });

  it('applies the same explicit negative-age guard to provider freshness', () => {
    const provider = { status: 'online', handlersLive: true, lastHeartbeatAt: new Date(NOW + 1) };
    expect(isProviderLive(provider, NOW)).toBe(false);
    expect(isProviderLive({ ...provider, lastHeartbeatAt: new Date(NOW) }, NOW)).toBe(true);
  });
});
