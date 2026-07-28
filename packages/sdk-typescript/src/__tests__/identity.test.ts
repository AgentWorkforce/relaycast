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

describe('machine identity', () => {
  it('is reported alongside the user id, not replaced by it', () => {
    expect(
      resolveAgentRelayIdentity({
        agentRelayUserId: 'usr_abc123',
        agentRelayMachineId: 'abc123def4567890',
      }),
    ).toEqual({
      // The user is the person key; the machine stays its own dimension.
      distinctId: 'usr_abc123',
      machineId: 'abc123def4567890',
      userId: 'usr_abc123',
    });
  });

  it('falls back to the machine id as the distinct id when anonymous', () => {
    expect(resolveAgentRelayIdentity({ agentRelayMachineId: 'abc123def4567890' })).toEqual({
      distinctId: 'abc123def4567890',
      machineId: 'abc123def4567890',
    });
  });

  it('sends the machine id as its own header and query param', () => {
    const identity = resolveAgentRelayIdentity({
      agentRelayUserId: 'usr_abc123',
      agentRelayMachineId: 'abc123def4567890',
    });

    expect(agentRelayIdentityHeaders(identity)['X-Agent-Relay-Machine-Id']).toBe(
      'abc123def4567890',
    );

    const url = new URL('wss://cast.agentrelay.com/v1/ws');
    applyAgentRelayIdentityQuery(url, identity);
    expect(url.searchParams.get('agent_relay_machine_id')).toBe('abc123def4567890');
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

  it('forwards identity onto an agent socket too, not just the observer socket', async () => {
    const { RelayCast } = await import('../relay.js');

    // The agent socket fetches a direct-node token before opening.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: { token: 'nt_live_1', node_id: 'nd_1', node_name: 'sdk-direct' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const relay = new RelayCast({
      apiKey: 'rk_live_1',
      baseUrl: 'http://localhost:8080',
      agentRelayUserId: 'usr_abc123',
      agentRelayMachineId: 'abc123def4567890',
      agentRelayOrgId: 'org_xyz789',
      agentRelayOrgSlug: 'agentworkforce',
    });

    const agent = relay.as('at_live_worker');
    agent.connect();

    // Opening is async behind the token fetch; wait for the socket to appear.
    for (let i = 0; i < 50 && MockWebSocket.instances.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const agentSocket = MockWebSocket.instances.find((ws) => ws.url.includes('/v1/node/ws'));
    expect(agentSocket, 'agent node socket was never opened').toBeDefined();

    const url = new URL(agentSocket!.url);
    expect(url.searchParams.get('agent_relay_user_id')).toBe('usr_abc123');
    expect(url.searchParams.get('agent_relay_machine_id')).toBe('abc123def4567890');
    expect(url.searchParams.get('agent_relay_org_id')).toBe('org_xyz789');
    expect(url.searchParams.get('agent_relay_org_slug')).toBe('agentworkforce');
    expect(url.searchParams.get('agent_relay_distinct_id')).toBe('usr_abc123');

    agent.disconnect();
    relay.disconnect();
  });

  it('exposes one origin carrying every dimension, so new fields reach all sockets', async () => {
    const { HttpClient } = await import('../client.js');

    const client = new HttpClient({
      apiKey: 'rk_live_1',
      originActor: 'agent-relay-cli/cli',
      agentRelayUserId: 'usr_abc123',
      agentRelayMachineId: 'abc123def4567890',
      agentRelayOrgId: 'org_xyz789',
      agentRelayOrgSlug: 'agentworkforce',
    });

    // Both WebSocket clients (RelayCast's observer socket and AgentClient's
    // node socket) build their internal origin from exactly this, so a
    // dimension present here cannot be missing from one socket and not the
    // other — the drift that left agent sockets unauthenticated.
    expect(client.internalOrigin).toMatchObject({
      client: '@relaycast/sdk',
      originActor: 'agent-relay-cli/cli',
      agentRelayDistinctId: 'usr_abc123',
      agentRelayMachineId: 'abc123def4567890',
      agentRelayUserId: 'usr_abc123',
      agentRelayOrgId: 'org_xyz789',
      agentRelayOrgSlug: 'agentworkforce',
    });
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
