import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Relay } from '../communicate/relay.js';
import { RelayError } from '../errors.js';
import { RelaycastSetup } from '../setup.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static server: MockRelaycastServer | null = null;

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    MockWebSocket.server?.detachSocket(this);
    this.onclose?.();
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    MockWebSocket.server?.attachSocket(this);
  }

  deliver(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

async function waitForSockets(count: number): Promise<MockWebSocket[]> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
    if (MockWebSocket.instances.length >= count) {
      return MockWebSocket.instances.slice(0, count);
    }
  }
  throw new Error(`Expected ${count} mock sockets, got ${MockWebSocket.instances.length}`);
}

interface InviteLike {
  workspaceId: string;
  relaycastApiKey: string;
  relaycastBaseUrl?: string;
  agentName: string;
}

interface AgentState {
  id: string;
  name: string;
  token: string;
  type: 'agent' | 'human' | 'system';
  status: 'online';
  createdAt: string;
  lastSeen: string;
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as Response);
}

function okResponse(data: unknown, status = 200): Promise<Response> {
  return jsonResponse({ ok: true, data }, status);
}

function errorResponse(status: number, code: string, message: string): Promise<Response> {
  return jsonResponse({
    ok: false,
    error: { code, message },
  }, status);
}

class MockRelaycastServer {
  readonly baseUrl = 'http://mock.relaycast.test';
  readonly workspaceId = 'ws_invite_room';
  readonly workspaceApiKey = 'rk_live_invite_room';
  readonly workspaceName = 'Invite Room';

  private nextAgentId = 1;
  private nextMessageId = 1;
  private readonly agentsByName = new Map<string, AgentState>();
  private readonly agentsByToken = new Map<string, AgentState>();
  private readonly nodeTokensByAgentId = new Map<string, string>();
  private readonly socketsByToken = new Map<string, Set<MockWebSocket>>();

  createInvite(agentName = 'review-agent'): InviteLike {
    return {
      workspaceId: this.workspaceId,
      relaycastApiKey: this.workspaceApiKey,
      relaycastBaseUrl: this.baseUrl,
      agentName,
    };
  }

  attachSocket(socket: MockWebSocket): void {
    const token = new URL(socket.url).searchParams.get('token');
    if (!token) {
      return;
    }

    const sockets = this.socketsByToken.get(token) ?? new Set<MockWebSocket>();
    sockets.add(socket);
    this.socketsByToken.set(token, sockets);
  }

  detachSocket(socket: MockWebSocket): void {
    const token = new URL(socket.url).searchParams.get('token');
    if (!token) {
      return;
    }

    const sockets = this.socketsByToken.get(token);
    if (!sockets) {
      return;
    }
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.socketsByToken.delete(token);
    }
  }

  handleFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(String(input)) : new URL(input.url);
    const authHeader = this.readAuthHeader(init);
    const path = url.pathname;

    if (path === '/v1/agents' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      return this.handleRegisterAgent(authHeader, init);
    }

    if (path === '/v1/agent/node-token' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      return this.handleDirectNodeToken(authHeader);
    }

    if (path.startsWith('/v1/agents/') && path.endsWith('/rotate-token')) {
      return this.handleRotateToken(authHeader, path);
    }

    if (path.startsWith('/v1/agents/') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      return this.handleGetAgent(authHeader, path);
    }

    if (path === '/v1/workspace' && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      return this.handleWorkspaceInfo(authHeader);
    }

    if (path === '/v1/dm' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      return this.handleDm(authHeader, init);
    }

    return errorResponse(404, 'not_found', `Unhandled mock route: ${path}`);
  };

  private readAuthHeader(init?: RequestInit): string | null {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return headers.Authorization ?? headers.authorization ?? null;
  }

  private requireWorkspaceKey(authHeader: string | null): Promise<Response> | null {
    if (authHeader === `Bearer ${this.workspaceApiKey}`) {
      return null;
    }
    return errorResponse(401, 'unauthorized', 'Invalid Relaycast API key');
  }

  private requireAgent(authHeader: string | null): AgentState | Promise<Response> {
    if (!authHeader?.startsWith('Bearer ')) {
      return errorResponse(401, 'unauthorized', 'Missing agent token');
    }

    const token = authHeader.slice('Bearer '.length);
    const agent = this.agentsByToken.get(token);
    if (!agent) {
      return errorResponse(401, 'unauthorized', 'Invalid agent token');
    }
    return agent;
  }

  private handleRegisterAgent(authHeader: string | null, init?: RequestInit): Promise<Response> {
    const authError = this.requireWorkspaceKey(authHeader);
    if (authError) {
      return authError;
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string; type?: AgentState['type'] };
    const name = body.name?.trim();
    if (!name) {
      return errorResponse(400, 'invalid_request', 'Agent name is required');
    }

    if (this.agentsByName.has(name)) {
      return errorResponse(409, 'agent_already_exists', 'Agent already exists');
    }

    const createdAt = this.timestamp(this.nextAgentId);
    const agent: AgentState = {
      id: `ag_${this.nextAgentId++}`,
      name,
      token: this.nextAgentToken(name, 1),
      type: body.type ?? 'agent',
      status: 'online',
      createdAt,
      lastSeen: createdAt,
    };

    this.agentsByName.set(agent.name, agent);
    this.agentsByToken.set(agent.token, agent);

    return okResponse({
      id: agent.id,
      name: agent.name,
      token: agent.token,
      status: agent.status,
      created_at: agent.createdAt,
    }, 201);
  }

  private handleGetAgent(authHeader: string | null, path: string): Promise<Response> {
    const authError = this.requireWorkspaceKey(authHeader);
    if (authError) {
      return authError;
    }

    const name = decodeURIComponent(path.slice('/v1/agents/'.length));
    const agent = this.agentsByName.get(name);
    if (!agent) {
      return errorResponse(404, 'agent_not_found', `Agent "${name}" not found`);
    }

    return okResponse({
      id: agent.id,
      name: agent.name,
      type: agent.type,
      token_hash: `hash_${agent.id}`,
      status: agent.status,
      persona: null,
      metadata: {},
      created_at: agent.createdAt,
      last_seen: agent.lastSeen,
    });
  }

  private handleRotateToken(authHeader: string | null, path: string): Promise<Response> {
    const authError = this.requireWorkspaceKey(authHeader);
    if (authError) {
      return authError;
    }

    const prefix = '/v1/agents/';
    const suffix = '/rotate-token';
    const name = decodeURIComponent(path.slice(prefix.length, -suffix.length));
    const agent = this.agentsByName.get(name);
    if (!agent) {
      return errorResponse(404, 'agent_not_found', `Agent "${name}" not found`);
    }

    this.agentsByToken.delete(agent.token);
    agent.token = this.nextAgentToken(agent.name, this.nextMessageId + 1);
    this.agentsByToken.set(agent.token, agent);

    return okResponse({ token: agent.token });
  }

  private handleWorkspaceInfo(authHeader: string | null): Promise<Response> {
    const authError = this.requireWorkspaceKey(authHeader);
    if (authError) {
      return authError;
    }

    return okResponse({
      id: this.workspaceId,
      name: this.workspaceName,
    });
  }

  private handleDirectNodeToken(authHeader: string | null): Promise<Response> {
    const agent = this.requireAgent(authHeader);
    if (agent instanceof Promise) {
      return agent;
    }

    const token = `nt_live_${agent.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
    this.nodeTokensByAgentId.set(agent.id, token);
    return okResponse({
      node_id: `node_direct_${agent.id}`,
      node_name: `direct-${agent.id}`,
      token,
    });
  }

  private handleDm(authHeader: string | null, init?: RequestInit): Promise<Response> {
    const sender = this.requireAgent(authHeader);
    if (sender instanceof Promise) {
      return sender;
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as { to?: string; text?: string };
    const recipientName = body.to?.trim();
    if (!recipientName) {
      return errorResponse(400, 'invalid_request', 'DM recipient is required');
    }
    const recipient = this.agentsByName.get(recipientName);
    if (!recipient) {
      return errorResponse(404, 'agent_not_found', `Agent "${recipientName}" not found`);
    }

    const messageId = `dm_${this.nextMessageId++}`;
    this.deliverToAgent(recipient, {
      type: 'dm.received',
      conversation_id: `conv_${sender.id}_${recipient.id}`,
      message: {
        id: messageId,
        agent_name: sender.name,
        text: body.text ?? '',
      },
    });

    return okResponse({
      id: messageId,
      conversation_id: `conv_${sender.id}_${recipient.id}`,
      from: sender.name,
      to: recipient.name,
      text: body.text ?? '',
      created_at: this.timestamp(this.nextMessageId),
    }, 201);
  }

  private deliverToAgent(agent: AgentState, event: { type: string; [key: string]: unknown }): void {
    const token = this.nodeTokensByAgentId.get(agent.id) ?? agent.token;
    this.deliver(token, {
      v: 1,
      type: 'deliver',
      delivery_id: `del_${this.nextMessageId}_${agent.id}`,
      agent_id: agent.id,
      agent: agent.name,
      msg_id: typeof event.message === 'object' && event.message !== null
        ? String((event.message as { id?: unknown }).id ?? '')
        : `msg_${this.nextMessageId}`,
      seq: this.nextMessageId,
      mode: 'wait',
      payload: {
        type: event.type,
        data: Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'type')),
      },
    });
  }

  private deliver(token: string, event: unknown): void {
    const sockets = this.socketsByToken.get(token);
    if (!sockets) {
      return;
    }
    for (const socket of sockets) {
      socket.deliver(event);
    }
  }

  private nextAgentToken(name: string, version: number): string {
    return `at_live_${name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_${version}`;
  }

  private timestamp(offset: number): string {
    return new Date(Date.UTC(2026, 4, 1, 12, 0, offset)).toISOString();
  }
}

describe('relayfile invite consumption', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    MockWebSocket.instances = [];
    MockWebSocket.server = null;
  });

  afterEach(() => {
    MockWebSocket.server = null;
  });

  it('joins from invite fields and lets lead/review agents exchange ready messages with relayfile paths', async () => {
    const server = new MockRelaycastServer();
    MockWebSocket.server = server;
    mockFetch.mockImplementation(server.handleFetch);

    const invite = server.createInvite('review-agent');
    const leadWorkspace = await new RelaycastSetup({
      baseUrl: invite.relaycastBaseUrl,
    }).joinWorkspace(invite.workspaceId, invite.relaycastApiKey);
    const reviewWorkspace = await new RelaycastSetup({
      baseUrl: invite.relaycastBaseUrl,
    }).joinWorkspace(invite.workspaceId, invite.relaycastApiKey);

    const leadAgent = await leadWorkspace.registerAgent({
      name: 'lead-agent',
      type: 'agent',
    });
    const reviewIdentity = await reviewWorkspace.relayCast().agents.registerOrRotate({
      name: invite.agentName,
      type: 'agent',
    });

    expect(leadWorkspace.workspaceId).toBe(invite.workspaceId);
    expect(reviewWorkspace.info.baseUrl).toBe(invite.relaycastBaseUrl);
    expect(reviewIdentity.name).toBe(invite.agentName);

    const leadRelay = leadWorkspace.relay('lead-agent');
    const reviewRelay = new Relay(reviewWorkspace.as(reviewIdentity.token));
    const leadMessages: Array<{ sender: string; text: string }> = [];
    const reviewMessages: Array<{ sender: string; text: string }> = [];

    const stopLead = leadRelay.onMessage((message) => {
      leadMessages.push({ sender: message.sender, text: message.text });
    });
    const stopReview = reviewRelay.onMessage((message) => {
      reviewMessages.push({ sender: message.sender, text: message.text });
    });
    const sockets = await waitForSockets(2);
    for (const socket of sockets) {
      socket.onopen?.();
    }
    await Promise.resolve();

    const readyPath = '/workspace/notion/review/ready.md';
    const ackPath = '/workspace/notion/review/lead-feedback.md';

    await reviewRelay.send('lead-agent', `ready ${readyPath}`);
    await leadRelay.send(invite.agentName, `ack ${ackPath}`);

    expect(leadMessages).toEqual([
      { sender: invite.agentName, text: `ready ${readyPath}` },
    ]);
    expect(reviewMessages).toEqual([
      { sender: 'lead-agent', text: `ack ${ackPath}` },
    ]);

    const dmCalls = mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/dm'));
    expect(dmCalls).toHaveLength(2);
    expect((dmCalls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${reviewIdentity.token}`,
    });
    expect((dmCalls[1]![1] as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${leadAgent.token}`,
    });

    stopLead();
    stopReview();
  });

  it('can assume an existing invite identity via registerOrRotate without a name collision leak', async () => {
    const server = new MockRelaycastServer();
    mockFetch.mockImplementation(server.handleFetch);

    const invite = server.createInvite('review-agent');
    const firstJoin = await new RelaycastSetup({
      baseUrl: invite.relaycastBaseUrl,
    }).joinWorkspace(invite.workspaceId, invite.relaycastApiKey);
    const firstIdentity = await firstJoin.relayCast().agents.registerOrRotate({
      name: invite.agentName,
      type: 'agent',
    });

    const secondJoin = await new RelaycastSetup({
      baseUrl: invite.relaycastBaseUrl,
    }).joinWorkspace(invite.workspaceId, invite.relaycastApiKey);
    const secondIdentity = await secondJoin.relayCast().agents.registerOrRotate({
      name: invite.agentName,
      type: 'agent',
    });

    expect(secondIdentity.name).toBe(invite.agentName);
    expect(secondIdentity.id).toBe(firstIdentity.id);
    expect(secondIdentity.token).not.toBe(firstIdentity.token);
  });

  it('falls back to the default Relaycast base URL when an invite omits relaycastBaseUrl', async () => {
    const workspace = await new RelaycastSetup().joinWorkspace(
      'ws_from_invite',
      'rk_live_from_invite',
    );

    expect(workspace.info.baseUrl).toBe('https://cast.agentrelay.com');
  });

  it('surfaces invalid invite credentials as unauthorized without retrying', async () => {
    const server = new MockRelaycastServer();
    mockFetch.mockImplementation(server.handleFetch);

    const workspace = await new RelaycastSetup({
      baseUrl: server.baseUrl,
    }).joinWorkspace(server.workspaceId, 'rk_live_invalid');

    await expect(workspace.relayCast().workspace.info()).rejects.toMatchObject({
      constructor: RelayError,
      code: 'unauthorized',
      statusCode: 401,
      retryable: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
