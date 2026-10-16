import { Hono } from 'hono';
import { sanitizeTelemetryProperties } from '@relaycast/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env.js';
import type { TelemetryEvent } from '../../ports/telemetry.js';
import type { EngineDb } from '../../ports/index.js';
import {
  emitServerEvent,
  loadTelemetryWorkspace,
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
    tokenHash: 'a'.repeat(64),
    ...overrides,
  } as Agent;
}

function workspaceRow(metadata: Record<string, unknown> = {}): Workspace {
  return { id: WORKSPACE_ID, name: 'ws', metadata } as Workspace;
}

interface EmitOptions {
  agent?: Agent;
  workspace?: Workspace;
  event?: 'relaycast_server_message_created' | 'relaycast_server_channel_joined';
  properties?: Record<string, unknown>;
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
    c.set('agentCredentialHash', options.agent ? 'a'.repeat(64) : undefined);
    await next();
  });
  app.post('/emit', (c) => {
    if (options.event === 'relaycast_server_channel_joined') {
      emitServerEvent(c, WORKSPACE_ID, options.event, {
        channel_name: 'general', agent_id: 'agent_1', ...options.properties,
      }, options.attribution);
    } else {
      emitServerEvent(c, WORKSPACE_ID, 'relaycast_server_message_created', {
        channel_id: 'ch_1', message_id: '1', ...options.properties,
      }, options.attribution);
    }
    return c.body(null, 204);
  });

  await app.request('/emit', { method: 'POST', headers: options.headers });
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe('emitServerEvent attribution', () => {
  it.each([undefined, 'ws_other'])('keeps the authoritative workspace id over caller value %s', async (workspaceId) => {
    const properties = { workspace_id: workspaceId };
    const event = await emit({ properties });

    expect(event.properties.workspace_id).toBe(WORKSPACE_ID);
    expect(sanitizeTelemetryProperties(event.properties).workspace_id).toBe(WORKSPACE_ID);
    expect(properties.workspace_id).toBe(workspaceId);
  });

  it('retains the workspace id when the sink truncates extra properties', async () => {
    const properties = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`extra_${i}`, i]));
    const event = await emit({ properties });
    const sanitized = sanitizeTelemetryProperties(event.properties);

    expect(Object.keys(sanitized)).toHaveLength(64);
    expect(sanitized.workspace_id).toBe(WORKSPACE_ID);
  });

  it('keeps a human personless until the host verifies ownership', async () => {
    const event = await emit({
      agent: agentRow({ type: 'human', name: 'will', metadata: { cloud_user_id: 'user_will' } }),
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.processPersonProfile).toBe(false);
    expect(event.properties).toMatchObject({
      sender_type: 'human',
      agent_id: 'agent_1',
      agent_name: 'will',
    });
    expect(event.properties).not.toHaveProperty('agent_owner_user_id');
    expect(event.setOnce).toEqual({ first_human_message_at: expect.any(String) });
  });

  it('does not trust public owner metadata', async () => {
    const event = await emit({
      agent: agentRow({ metadata: { cloud_user_id: 'user_owner' } }),
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.properties).toMatchObject({
      sender_type: 'agent',
      agent_id: 'agent_1',
      agent_name: 'alice',
    });
    expect(event.setOnce).toEqual({ first_agent_message_at: expect.any(String) });
  });

  it('keeps client IDs as hints without selecting a person', async () => {
    const event = await emit({
      agent: agentRow({ metadata: { cloud_user_id: 'user_owner' } }),
      headers: { 'X-Agent-Relay-Distinct-Id': 'anon_cli' },
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.properties.client_distinct_id).toBe('anon_cli');
  });

  it('never treats declared user headers as authenticated', async () => {
    const event = await emit({
      agent: agentRow({ metadata: { cloud_user_id: 'user_owner' } }),
      headers: { 'X-Agent-Relay-User-Id': 'user_header' },
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.properties).toMatchObject({ actor_user_id: 'user_header', is_authenticated: false });
  });

  it('keeps unowned agents personless despite user and client claims', async () => {
    const event = await emit({
      agent: agentRow(),
      headers: { 'X-Agent-Relay-User-Id': 'user_header', 'X-Agent-Relay-Distinct-Id': 'anon_cli' },
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.processPersonProfile).toBe(false);
  });

  it('keeps unowned agents personless despite client claims', async () => {
    const event = await emit({
      agent: agentRow(),
      headers: { 'X-Agent-Relay-Distinct-Id': 'anon_cli' },
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.processPersonProfile).toBe(false);
    expect(event.properties.sender_type).toBe('agent');
    expect(event.properties).not.toHaveProperty('agent_owner_user_id');
    expect(event.setOnce).toEqual({ first_agent_message_at: expect.any(String) });
  });

  it('falls back to the workspace with no person profile when nothing identifies a person', async () => {
    const event = await emit({ agent: agentRow() });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.processPersonProfile).toBe(false);
    expect(event.setOnce).toEqual({ first_agent_message_at: expect.any(String) });
  });

  it('reports a system actor as system without stamping a first agent message', async () => {
    const event = await emit({
      agent: agentRow({ type: 'system', metadata: { cloud_user_id: 'user_owner' } }),
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.properties).toMatchObject({
      sender_type: 'system',
    });
    expect(event.setOnce).toBeUndefined();
  });

  it('omits sender fields when no agent acts', async () => {
    const event = await emit();

    expect(event.properties).not.toHaveProperty('sender_type');
    expect(event.properties).not.toHaveProperty('agent_id');
  });

  it('does not create trusted groups from editable workspace metadata', async () => {
    const event = await emit({
      workspace: workspaceRow({ cloud_org_id: 'org_1', cloud_workspace_id: 'cws_1' }),
    });

    expect(event.groups).toBeUndefined();
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

  it('keeps an explicit sender separate from the authenticated token holder', async () => {
    const actor: TelemetryActor = {
      id: 'agent_from',
      name: 'from-agent',
      type: 'human',
      metadata: { cloud_user_id: 'user_from' },
    };
    const event = await emit({
      agent: agentRow({ metadata: { cloud_user_id: 'user_token_holder' } }),
      attribution: { actor },
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.properties).toMatchObject({ agent_id: 'agent_from', sender_type: 'human', actor_kind: 'agent' });
    expect(event.actor?.agentId).toBe('agent_1');
  });

  it('preserves the authenticated actor independently from a route target and forged properties', async () => {
    const event = await emit({ agent: agentRow(), properties: {
      agent_id: 'different-target', is_authenticated: true, actor_kind: 'human', credentialHash: 'forged',
    }});
    expect(event.actor).toEqual({ workspaceId: WORKSPACE_ID, agentId: 'agent_1',
      credentialHash: 'a'.repeat(64), senderType: 'agent' });
    expect(event.properties.agent_id).toBe('different-target');
    expect(event.properties.is_authenticated).toBe(false);
    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
  });

  it('stamps first-send properties only on send events', async () => {
    const event = await emit({
      event: 'relaycast_server_channel_joined',
      agent: agentRow({ type: 'human', metadata: { cloud_user_id: 'user_will' } }),
    });

    expect(event.distinctId).toBe(`relaycast-ws:${WORKSPACE_ID}`);
    expect(event.setOnce).toBeUndefined();
  });
});

describe('loadTelemetryWorkspace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a failed lookup and yields no workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.reject(new Error('db down')) }) }),
    } as unknown as EngineDb;

    await expect(loadTelemetryWorkspace(db, WORKSPACE_ID)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[telemetry] workspace lookup failed; event sent without groups',
      { workspace_id: WORKSPACE_ID, error: 'db down' },
    );
  });
});
