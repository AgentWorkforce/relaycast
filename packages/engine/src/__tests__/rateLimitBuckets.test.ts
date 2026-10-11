import { describe, expect, it } from 'vitest';
import { ROUTE_MULTIPLIERS, getRouteKey } from '../middleware/rateLimit.js';

/**
 * The bucket key, not the multiplier, is what separates one route's allowance
 * from another's: `${workspace.id}:${routeKey ?? 'global'}:${window}`. A route
 * with no key shares the `global` bucket with every message and DM the
 * workspace sends, which is why control-plane reads need keys of their own.
 */
describe('rate limit route buckets', () => {
  it('gives the identity resolve its own bucket', () => {
    // arelay.to's registry calls this to learn which workspace a delivery
    // credential belongs to. Starved here, registration cannot complete.
    expect(getRouteKey('GET', '/v1/agent')).toBe('GET:/agent');
  });

  it('collapses a single-agent lookup to one key, not one per agent name', () => {
    // Cloud looks up the answer address it reserved. Keying per name would give
    // every name a full allowance and the limit would mean nothing.
    expect(getRouteKey('GET', '/v1/agents/arelay-answerer')).toBe('GET:/agents/*');
    expect(getRouteKey('GET', '/v1/agents/some-other-agent')).toBe('GET:/agents/*');
    // Review caught this: agent names are arbitrary strings, registration
    // rejects only the reserved release marker, and encodeURIComponent leaves
    // a period alone. A character whitelist left these in `global` -- starved
    // by the very traffic the bucket exists to separate them from.
    // Review caught these too: `messages`, `reactions` and `replies` are valid
    // agent names, and the unanchored rewrites claimed them first.
    for (const name of ['messages', 'reactions', 'replies']) {
      expect(getRouteKey('GET', `/v1/agents/${name}`)).toBe('GET:/agents/*');
    }
    for (const name of ['build.bot', 'team.alpha.bot', 'agent%20one', 'ops@site', 'a+b', 'ünïcode']) {
      expect(getRouteKey('GET', `/v1/agents/${name}`)).toBe('GET:/agents/*');
    }
  });

  it('keeps presence on its own tighter multiplier', () => {
    // The regression this guards: `presence` is a distinct route, and a naive
    // /agents/<name> collapse would silently widen it from 0.3 to 1.0.
    expect(getRouteKey('GET', '/v1/agents/presence')).toBe('GET:/agents/presence');
    expect(ROUTE_MULTIPLIERS['GET:/agents/presence']).toBe(0.3);
    expect(ROUTE_MULTIPLIERS['GET:/agents/presence'])
      .toBeLessThan(ROUTE_MULTIPLIERS['GET:/agents/*']!);
  });

  it('leaves the roster and the write routes where they were', () => {
    // The roster is the data-plane traffic this protects the identity reads
    // FROM, and rateLimitContract's regression fixture saturates `global` with
    // it. Keying it would change what that test exhausts.
    expect(getRouteKey('GET', '/v1/agents')).toBeNull();
    // Unchanged: these have no GET key and must keep falling to `global`.
    expect(getRouteKey('POST', '/v1/agents/retention')).toBeNull();
    expect(getRouteKey('POST', '/v1/agents/some-agent/recover')).toBeNull();
    expect(getRouteKey('POST', '/v1/agents/some-agent/takeover')).toBeNull();
  });

  it('does not disturb the existing data-plane keys', () => {
    expect(getRouteKey('POST', '/v1/dm')).toBe('POST:/dm');
    expect(getRouteKey('POST', '/v1/dm/group')).toBe('POST:/dm/group');
    expect(getRouteKey('GET', '/v1/channels/abc/messages')).toBe('GET:/channels/*/messages');
    expect(getRouteKey('POST', '/v1/channels/abc/messages')).toBe('POST:/channels/*/messages');
    expect(getRouteKey('POST', '/v1/messages/abc/reactions')).toBe('POST:/messages/*/reactions');
    expect(getRouteKey('GET', '/v1/workspace')).toBe('GET:/workspace');
  });

  it('still returns null for anything unmapped', () => {
    expect(getRouteKey('GET', '/v1/channels')).toBeNull();
    expect(getRouteKey('DELETE', '/v1/agents/some-agent')).toBeNull();
  });
});
