import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env.js';
import type { TelemetryEvent } from '../../ports/telemetry.js';
import {
  emitServerEvent,
  type ServerEventAttribution,
  type TelemetryActor,
} from '../serverTelemetry.js';

const WORKSPACE_ID = 'ws_1';

type Agent = NonNullable<AppEnv['Variables']['agent']>;
type Workspace = AppEnv['Variables']['workspace'];

function agentRow(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent_1',
    workspaceId: WORKSPACE_ID,
    name: 'alice',
    type: 'agent',
    metadata: {},
    ...overrides,
  } as Agent;
}

function workspaceRow(metadata: Record<string, unknown> = {}): Workspace {
  return { id: WORKSPACE_ID, name: 'ws', metadata } as Workspace;
}

interface EmitOptions {
  agent?: Agent;
  workspace?: Workspace;
  event?: `relaycast_server_${string}`;
  headers?: Record<string, string>;
  attribution?: ServerEventAttribution;
}

async function emit(options: EmitOptions = {}): Promise<TelemetryEvent> {
  const captured: TelemetryEvent[] = [];
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set('engine', {
      telemetry: {
        capture: (event: TelemetryEvent) => captured.push(event),
        captureException: () => {},
      },
    } as unknown as AppEnv['Variables']['engine']);
    c.set('workspace', options.workspace ?? workspaceRow());
    c.set('agent', options.agent);
    await next();
  });
  app.post('/emit', (c) => {
    emitServerEvent(
      c,
      WORKSPACE_ID,
      options.event ?? 'relaycast_server_message_created',
      { channel_id: 'ch_1', message_id: '1' },
      options.attribution,
    );
    return c.body(null, 204);
  });

  await app.request('/emit', { method: 'POST', headers: options.headers });
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe('emitServerEvent attribution', () => {
  it('attributes a human sender to their cloud user', async () => {
    const event = await emit({
      agent: agentRow({ type: 'human', name: 'will', metadata: { cloud_user_id: 'user_will' } }),
    });

    expect(event.distinctId).toBe('user_will');
    expect(event.processPersonProfile).toBeUndefined();
    expect(event.properties).toMatchObject({
      sender_type: 'human',
      agent_id: 'agent_1',
      agent_name: 'will',
    });
    expect(event.properties).not.toHaveProperty('agent_owner_user_id');
    expect(event.setOnce).toEqual({ first_human_message_at: expect.any(String) });
  });

  it('attributes an owned agent to its owner', async () => {
    const event = await emit({
      agent: agentRow({ metadata: { cloud_user_id: 'user_owner' } }),
    });

    expect(event.distinctId).toBe('user_owner');
    expect(event.properties).toMatchObject({
      sender_type: 'agent',
      agent_id: 'agent_1',
      agent_name: 'alice',
      agent_owner_user_id: 'user_owner',
    });
    expect(event.setOnce).toEqual({ first_agent_message_at: expect.any(String) });
  });

  it('prefers the acting agent owner over the client distinct id', async () => {
    const event = await emit({
      agent: agentRow({ metadata: { cloud_user_id: 'user_owner' } }),
      headers: { 'X-Agent-Relay-Distinct-Id': 'anon_cli' },
    });

    expect(event.distinctId).toBe('user_owner');
    expect(event.properties.client_distinct_id).toBe('anon_cli');
  });

  it('falls back to the client distinct id for an unowned agent', async () => {
    const event = await emit({
      agent: agentRow(),
      headers: { 'X-Agent-Relay-Distinct-Id': 'anon_cli' },
    });

    expect(event.distinctId).toBe('anon_cli');
    expect(event.processPersonProfile).toBeUndefined();
    expect(event.properties.sender_type).toBe('agent');
    expect(event.properties).not.toHaveProperty('agent_owner_user_id');
    expect(event.setOnce).toBeUndefined();
  });

  it('falls back to the workspace with no person profile when nothing identifies a person', async () => {
    const event = await emit({ agent: agentRow() });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.processPersonProfile).toBe(false);
    expect(event.setOnce).toBeUndefined();
  });

  it('reports a system actor as system without stamping a first agent message', async () => {
    const event = await emit({
      agent: agentRow({ type: 'system', metadata: { cloud_user_id: 'user_owner' } }),
    });

    expect(event.distinctId).toBe('user_owner');
    expect(event.properties).toMatchObject({
      sender_type: 'system',
      agent_owner_user_id: 'user_owner',
    });
    expect(event.setOnce).toBeUndefined();
  });

  it('omits sender fields when no agent acts', async () => {
    const event = await emit();

    expect(event.properties).not.toHaveProperty('sender_type');
    expect(event.properties).not.toHaveProperty('agent_id');
  });

  it('adds organization and workspace groups from workspace metadata', async () => {
    const event = await emit({
      workspace: workspaceRow({ cloud_org_id: 'org_1', cloud_workspace_id: 'cws_1' }),
    });

    expect(event.groups).toEqual({ organization: 'org_1', workspace: 'cws_1' });
  });

  it('leaves groups off when workspace metadata has no cloud ids', async () => {
    const event = await emit({ workspace: workspaceRow({ other: 'x' }) });

    expect(event.groups).toBeUndefined();
  });

  it('ignores context rows that belong to another workspace', async () => {
    const event = await emit({
      agent: agentRow({ workspaceId: 'ws_other', metadata: { cloud_user_id: 'user_x' } }),
      workspace: { id: 'ws_other', name: 'other', metadata: { cloud_org_id: 'org_x' } } as Workspace,
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.groups).toBeUndefined();
    expect(event.properties).not.toHaveProperty('sender_type');
  });

  it('uses an explicit actor over the token holder', async () => {
    const actor: TelemetryActor = {
      id: 'agent_from',
      name: 'from-agent',
      type: 'human',
      metadata: { cloud_user_id: 'user_from' },
    };
    const event = await emit({ attribution: { actor } });

    expect(event.distinctId).toBe('user_from');
    expect(event.properties).toMatchObject({ agent_id: 'agent_from', sender_type: 'human' });
  });

  it('stamps first-send properties only on send events', async () => {
    const event = await emit({
      event: 'relaycast_server_channel_joined',
      agent: agentRow({ type: 'human', metadata: { cloud_user_id: 'user_will' } }),
    });

    expect(event.distinctId).toBe('user_will');
    expect(event.setOnce).toBeUndefined();
  });
});
