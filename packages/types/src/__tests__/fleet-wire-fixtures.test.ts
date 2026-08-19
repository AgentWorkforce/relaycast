import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AgentRegisterReplyDataSchema,
  FleetBrokerToRelaycastMessageSchema,
  FleetRelaycastToBrokerMessageSchema,
  parseFleetBrokerToRelaycastMessage,
  parseFleetRelaycastToBrokerMessage,
} from '../index.js';
import type { FleetActionResultMessage } from '../index.js';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/fleet-wire',
);

const BROKER_TO_RELAYCAST_TYPES = new Set([
  'node.register',
  'node.heartbeat',
  'node.deregister',
  'agent.register',
  'agent.deregister',
  'delivery.ack',
  'action.result',
  'inventory.sync',
]);

const RELAYCAST_TO_BROKER_TYPES = new Set(['deliver', 'action.invoke', 'context.update', 'ping', 'reply', 'error']);

const EXPECTED_FIXTURES = [
  'action.invoke.json',
  'action.result.error.json',
  'action.result.output.json',
  'agent.deregister.json',
  'agent.register.json',
  'context.update.json',
  'deliver.json',
  'delivery.ack.json',
  'error.json',
  'inventory.sync.json',
  'node.deregister.json',
  'node.heartbeat.json',
  'node.register.json',
  'ping.json',
  'reply.agent_register.json',
  'reply.json',
];

function readFixture(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

function expectSnakeCaseKeys(value: unknown, pathParts: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectSnakeCaseKeys(item, [...pathParts, String(index)]));
    return;
  }

  if (typeof value !== 'object' || value === null) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    expect(key, [...pathParts, key].join('.')).not.toMatch(/[A-Z]/);
    expectSnakeCaseKeys(nestedValue, [...pathParts, key]);
  }
}

describe('fleet wire fixtures', () => {
  it('keeps one plain JSON fixture per required message shape', () => {
    const fixtureFiles = fs
      .readdirSync(FIXTURE_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    expect(fixtureFiles).toEqual(EXPECTED_FIXTURES);
  });

  for (const fixtureFile of EXPECTED_FIXTURES) {
    it(`round-trips ${fixtureFile} through the fleet wire schemas`, () => {
      const fixture = readFixture(fixtureFile);

      if (
        typeof fixture !== 'object' ||
        fixture === null ||
        !('type' in fixture) ||
        typeof fixture.type !== 'string'
      ) {
        throw new Error(`${fixtureFile} must be a JSON object with a string type`);
      }

      const parse = BROKER_TO_RELAYCAST_TYPES.has(fixture.type)
        ? parseFleetBrokerToRelaycastMessage
        : parseFleetRelaycastToBrokerMessage;
      const schema = BROKER_TO_RELAYCAST_TYPES.has(fixture.type)
        ? FleetBrokerToRelaycastMessageSchema
        : FleetRelaycastToBrokerMessageSchema;

      expect(
        BROKER_TO_RELAYCAST_TYPES.has(fixture.type) || RELAYCAST_TO_BROKER_TYPES.has(fixture.type),
      ).toBe(true);

      const parsed = parse(fixture);
      const serialized = JSON.parse(JSON.stringify(parsed));

      expectSnakeCaseKeys(serialized);
      expect(serialized).toEqual(fixture);
      expect(schema.parse(serialized)).toEqual(parsed);

      if (fixtureFile === 'reply.agent_register.json') {
        expect(AgentRegisterReplyDataSchema.parse((parsed as { data: unknown }).data)).toEqual({
          agent_id: 'agt_01J7FLEET000000000000101',
          delivery_ack_seq: 42,
          token: 'at_live_0123456789abcdef01234567',
          name: 'codex-builder-1',
        });
      }
    });
  }

  it('accepts unreported heartbeat load and rejects values outside [0,1]', () => {
    const heartbeat = {
      v: 1 as const,
      type: 'node.heartbeat' as const,
      active_agents: 25,
      handlers_live: true,
    };
    expect(parseFleetBrokerToRelaycastMessage(heartbeat)).toEqual(heartbeat);
    expect(parseFleetBrokerToRelaycastMessage({ ...heartbeat, load: null })).toEqual({
      ...heartbeat,
      load: null,
    });
    expect(parseFleetBrokerToRelaycastMessage({ ...heartbeat, load: 0.25, load_reported: true })).toEqual({
      ...heartbeat,
      load: 0.25,
      load_reported: true,
    });
    expect(() => parseFleetBrokerToRelaycastMessage({ ...heartbeat, load_reported: true })).toThrow();
    expect(() => parseFleetBrokerToRelaycastMessage({ ...heartbeat, load: null, load_reported: true })).toThrow();
    expect(() => parseFleetBrokerToRelaycastMessage({ ...heartbeat, load: -0.01 })).toThrow();
    expect(() => parseFleetBrokerToRelaycastMessage({ ...heartbeat, load: 1.01 })).toThrow();
  });

  it('accepts action.result error variants as the same message type', () => {
    expect(
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'action.result',
        invocation_id: 'inv_spawn_codex_001',
        error: 'handler_unavailable',
      }),
    ).toEqual({
      v: 1,
      type: 'action.result',
      invocation_id: 'inv_spawn_codex_001',
      error: 'handler_unavailable',
    });
  });

  it('accepts agent-scoped context updates for node fanout events', () => {
    expect(
      parseFleetRelaycastToBrokerMessage({
        v: 1,
        type: 'context.update',
        topic: 'agent',
        event: 'delivery.failed',
        channel_id: null,
        agent_ids: ['agt_sender'],
        data: {
          delivery_id: null,
          message_id: 'msg_1',
          reason: 'depth_cap',
          retryable: false,
        },
      }),
    ).toEqual({
      v: 1,
      type: 'context.update',
      topic: 'agent',
      event: 'delivery.failed',
      channel_id: null,
      agent_ids: ['agt_sender'],
      data: {
        delivery_id: null,
        message_id: 'msg_1',
        reason: 'depth_cap',
        retryable: false,
      },
    });
  });

  it('models action.result as a type-level XOR', () => {
    expectTypeOf<{
      v: 1;
      type: 'action.result';
      invocation_id: string;
      output: null;
    }>().toMatchTypeOf<FleetActionResultMessage>();

    expectTypeOf<{
      v: 1;
      type: 'action.result';
      invocation_id: string;
      error: string;
    }>().toMatchTypeOf<FleetActionResultMessage>();

    expectTypeOf<{
      v: 1;
      type: 'action.result';
      invocation_id: string;
      output: null;
      error: string;
    }>().not.toMatchTypeOf<FleetActionResultMessage>();
  });

  it('rejects action.result messages without exactly one result field', () => {
    expect(() =>
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'action.result',
        invocation_id: 'inv_spawn_codex_001',
      }),
    ).toThrow();

    expect(() =>
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'action.result',
        invocation_id: 'inv_spawn_codex_001',
        output: null,
        error: 'handler_unavailable',
      }),
    ).toThrow();

    expect(() =>
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'action.result',
        invocation_id: 'inv_spawn_codex_001',
        output: undefined,
      }),
    ).toThrow();

    expect(() =>
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'action.result',
        invocation_id: 'inv_spawn_codex_001',
        error: undefined,
      }),
    ).toThrow();

    expect(() =>
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'action.result',
        invocation_id: 'inv_spawn_codex_001',
        output: null,
        error: undefined,
      }),
    ).toThrow();

    expect(() =>
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'action.result',
        invocation_id: 'inv_spawn_codex_001',
        error: 'handler_unavailable',
        output: undefined,
      }),
    ).toThrow();
  });

  it('accepts node.register without a resume cursor or request id', () => {
    expect(
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'node.register',
        name: 'builder-1',
        node_id: 'node_01J7FLEET000000000000001',
        capabilities: [
          {
            name: 'spawn:codex',
            kind: 'spawn',
            metadata: { agent: 'codex', priority: 1 },
          },
        ],
        max_agents: 8,
        tags: ['darwin'],
        version: 'relay-broker/0.7.0',
      }),
    ).toEqual({
      v: 1,
      type: 'node.register',
      name: 'builder-1',
      node_id: 'node_01J7FLEET000000000000001',
      capabilities: [
        {
          name: 'spawn:codex',
          kind: 'spawn',
          metadata: { agent: 'codex', priority: 1 },
        },
      ],
      max_agents: 8,
      tags: ['darwin'],
      version: 'relay-broker/0.7.0',
    });
  });

  it('accepts placement-safe repo_keys and repo tags on node.register', () => {
    expect(
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'node.register',
        name: 'builder-repos',
        node_id: 'node_repos',
        capabilities: [],
        max_agents: 4,
        tags: ['darwin', 'repo:relay', 'repo:AgentWorkforce/relaycast'],
        repo_keys: ['AgentWorkforce/relay', 'acme/.github'],
        version: 'relay-broker/0.7.0',
      }),
    ).toMatchObject({
      tags: ['darwin', 'repo:relay', 'repo:AgentWorkforce/relaycast'],
      repo_keys: ['AgentWorkforce/relay', 'acme/.github'],
    });
  });

  it.each([
    { repo_keys: [''] },
    { repo_keys: ['relaycast'] },
    { repo_keys: ['/Users/alice/relaycast'] },
    { repo_keys: ['C:/work/relaycast'] },
    { repo_keys: ['C:\\work\\relaycast'] },
    { repo_keys: ['\\\\server\\share'] },
    { repo_keys: ['AgentWorkforce\\relaycast'] },
    { repo_keys: ['AgentWorkforce:relaycast'] },
    { repo_keys: ['Agent Workforce/relaycast'] },
    { repo_keys: ['AgentWorkforce/relay cast'] },
    { repo_keys: ['./relaycast'] },
    { repo_keys: ['../relaycast'] },
    { repo_keys: ['AgentWorkforce/.'] },
    { repo_keys: ['AgentWorkforce/..'] },
    { repo_keys: ['AgentWorkforce//relaycast'] },
    { repo_keys: ['AgentWorkforce/relaycast/packages/engine'] },
    { repo_keys: ['https://github.com/AgentWorkforce/relaycast'] },
    { tags: ['repo:'] },
    { tags: ['repo:/srv/relaycast'] },
    { tags: ['repo:C:/work/relaycast'] },
    { tags: ['repo:C:\\work\\relaycast'] },
    { tags: ['repo:\\\\server\\share'] },
    { tags: ['repo:AgentWorkforce\\relaycast'] },
    { tags: ['repo:AgentWorkforce:relaycast'] },
    { tags: ['repo:Agent Workforce/relaycast'] },
    { tags: ['repo:.'] },
    { tags: ['repo:..'] },
    { tags: ['repo:../relaycast'] },
    { tags: ['repo:AgentWorkforce/relaycast/packages/engine'] },
  ])('rejects path-shaped repository advertisements on node.register: %j', (unsafe) => {
    expect(() =>
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        type: 'node.register',
        name: 'builder-unsafe-repos',
        node_id: 'node_unsafe_repos',
        capabilities: [],
        max_agents: 4,
        tags: ['darwin'],
        version: 'relay-broker/0.7.0',
        ...unsafe,
      }),
    ).toThrow();
  });

  it('accepts broker requests with request ids', () => {
    expect(
      parseFleetBrokerToRelaycastMessage({
        v: 1,
        id: 'req_agent_register_001',
        type: 'agent.register',
        name: 'codex-builder-1',
      }),
    ).toEqual({
      v: 1,
      id: 'req_agent_register_001',
      type: 'agent.register',
      name: 'codex-builder-1',
    });
  });

  it('keeps legacy agent.register reply data valid without a cursor', () => {
    expect(AgentRegisterReplyDataSchema.parse({
      agent_id: 'agt_legacy',
      token: 'at_live_legacy',
      name: 'legacy-worker',
    })).toEqual({
      agent_id: 'agt_legacy',
      token: 'at_live_legacy',
      name: 'legacy-worker',
    });
  });
});
