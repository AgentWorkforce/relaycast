import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agentRelayIdentityHeaders,
  applyAgentRelayIdentityQuery,
  resolveAgentRelayIdentity,
  sanitizeAgentRelayOrgSlug,
} from '../origin.js';
import { HttpClient } from '../client.js';

describe('resolveAgentRelayIdentity', () => {
  it('takes the first source that sets a field', () => {
    expect(
      resolveAgentRelayIdentity(
        { agentRelayUserId: 'usr_internal' },
        { agentRelayUserId: 'usr_public', agentRelayOrgId: 'org_public' },
      ),
    ).toEqual({
      distinctId: 'usr_internal',
      userId: 'usr_internal',
      orgId: 'org_public',
    });
  });

  it('uses the user id as the distinct id when none is given', () => {
    expect(resolveAgentRelayIdentity({ agentRelayUserId: 'usr_abc123' })).toEqual({
      distinctId: 'usr_abc123',
      userId: 'usr_abc123',
    });
  });

  it('keeps an explicit distinct id distinct from the user id', () => {
    expect(
      resolveAgentRelayIdentity({
        agentRelayDistinctId: 'abc123def4567890',
        agentRelayUserId: 'usr_abc123',
      }),
    ).toMatchObject({ distinctId: 'abc123def4567890', userId: 'usr_abc123' });
  });

  it('drops malformed values instead of forwarding them', () => {
    expect(
      resolveAgentRelayIdentity({
        agentRelayUserId: 'usr\r\nX-Inject: bad',
        agentRelayOrgId: 'org/slash',
        agentRelayOrgSlug: 'fine-slug',
      }),
    ).toEqual({ orgSlug: 'fine-slug' });
  });

  it('is empty for an anonymous caller', () => {
    expect(resolveAgentRelayIdentity({}, undefined)).toEqual({});
  });

  it('caps the org slug at 120 characters', () => {
    expect(sanitizeAgentRelayOrgSlug('s'.repeat(200))).toHaveLength(120);
  });
});

describe('agentRelayIdentityHeaders', () => {
  it('emits only the fields that are set', () => {
    expect(agentRelayIdentityHeaders({ userId: 'usr_1' })).toEqual({
      'X-Agent-Relay-User-Id': 'usr_1',
    });
    expect(agentRelayIdentityHeaders({})).toEqual({});
  });
});

describe('applyAgentRelayIdentityQuery', () => {
  it('mirrors identity onto the WS query string', () => {
    const url = new URL('wss://cast.agentrelay.com/v1/ws');
    applyAgentRelayIdentityQuery(url, {
      distinctId: 'usr_abc123',
      userId: 'usr_abc123',
      orgId: 'org_xyz789',
      orgSlug: 'agentworkforce',
    });

    expect(url.searchParams.get('agent_relay_distinct_id')).toBe('usr_abc123');
    expect(url.searchParams.get('agent_relay_user_id')).toBe('usr_abc123');
    expect(url.searchParams.get('agent_relay_org_id')).toBe('org_xyz789');
    expect(url.searchParams.get('agent_relay_org_slug')).toBe('agentworkforce');
  });

  it('adds nothing for an anonymous caller', () => {
    const url = new URL('wss://cast.agentrelay.com/v1/ws');
    applyAgentRelayIdentityQuery(url, {});
    expect(url.search).toBe('');
  });
});

describe('HttpClient identity', () => {
  it('exposes the resolved identity and preserves it across key rotation', () => {
    const client = new HttpClient({
      apiKey: 'rk_live_1',
      agentRelayUserId: 'usr_abc123',
      agentRelayOrgId: 'org_xyz789',
      agentRelayOrgSlug: 'agentworkforce',
    });

    expect(client.agentRelayUserId).toBe('usr_abc123');
    expect(client.agentRelayOrgId).toBe('org_xyz789');
    expect(client.agentRelayOrgSlug).toBe('agentworkforce');
    expect(client.agentRelayDistinctId).toBe('usr_abc123');

    const rotated = client.withApiKey('rk_live_2');
    expect(rotated.agentRelayUserId).toBe('usr_abc123');
    expect(rotated.agentRelayOrgId).toBe('org_xyz789');
    expect(rotated.agentRelayOrgSlug).toBe('agentworkforce');
  });
});

describe('RelayCast WebSocket identity', () => {
  class MockWebSocket {
    static readonly OPEN = 1;
    static instances: MockWebSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = MockWebSocket.OPEN;
    send = vi.fn();
    close = vi.fn();

    constructor(readonly url: string) {
      MockWebSocket.instances.push(this);
    }
  }

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards identity onto the socket, not just HTTP requests', async () => {
    const { RelayCast } = await import('../relay.js');

    const relay = new RelayCast({
      apiKey: 'rk_live_1',
      baseUrl: 'http://localhost:8080',
      agentRelayUserId: 'usr_abc123',
      agentRelayOrgId: 'org_xyz789',
      agentRelayOrgSlug: 'agentworkforce',
    });
    relay.connect();

    const url = new URL(MockWebSocket.instances[0]!.url);
    expect(url.searchParams.get('agent_relay_user_id')).toBe('usr_abc123');
    expect(url.searchParams.get('agent_relay_org_id')).toBe('org_xyz789');
    expect(url.searchParams.get('agent_relay_org_slug')).toBe('agentworkforce');
    expect(url.searchParams.get('agent_relay_distinct_id')).toBe('usr_abc123');

    relay.disconnect();
  });
});
