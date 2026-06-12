import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FleetBrokerToRelaycastMessageSchema,
  FleetRelaycastToBrokerMessageSchema,
  parseFleetBrokerToRelaycastMessage,
  parseFleetRelaycastToBrokerMessage,
} from '../index.js';

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

const RELAYCAST_TO_BROKER_TYPES = new Set(['deliver', 'action.invoke', 'ping']);

const EXPECTED_FIXTURES = [
  'action.invoke.json',
  'action.result.error.json',
  'action.result.output.json',
  'agent.deregister.json',
  'agent.register.json',
  'deliver.json',
  'delivery.ack.json',
  'inventory.sync.json',
  'node.deregister.json',
  'node.heartbeat.json',
  'node.register.json',
  'ping.json',
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
    });
  }

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
  });
});
