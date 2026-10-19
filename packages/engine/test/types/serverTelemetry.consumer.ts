import type { Context } from 'hono';
import type { EngineObservationFacts } from '../../src/ports/telemetry.js';
import type { AppEnv } from '../../src/env.js';
import { emitServerEvent } from '../../src/lib/serverTelemetry.js';

// Compiled by the engine typecheck; never executed.
export function telemetryConsumer(c: Context<AppEnv>): void {
  emitServerEvent(c, 'ws_1', 'workspace.created', {});
  emitServerEvent(c, 'ws_1', 'route.resolved', { skill: 'coding', extra: true });
  emitServerEvent(c, 'ws_1', 'message.created', {
    channel_id: 'ch_1', message_id: 'msg_1',
  }, { actor: { id: 'agent_1', name: 'alice', type: 'agent' } });

  emitServerEvent(c, 'ws_1', 'workspace.key.rotated', { grace_seconds: 60 });
  // @ts-expect-error Rotation observations require the committed grace period.
  emitServerEvent(c, 'ws_1', 'workspace.key.rotated', {});
  // @ts-expect-error Event names must exist in the server catalog.
  emitServerEvent(c, 'ws_1', 'relaycast_server_typo', {});
  // @ts-expect-error The resolved route must include its required skill.
  emitServerEvent(c, 'ws_1', 'route.resolved', {});
  // @ts-expect-error Undefined required values would be stripped by ingestion.
  emitServerEvent(c, 'ws_1', 'route.resolved', { skill: undefined });
  // @ts-expect-error Required properties are specific to the selected event.
  emitServerEvent(c, 'ws_1', 'message.created', { skill: 'coding' });
}

export const routeProperty: keyof Pick<EngineObservationFacts<'route.resolved'>, 'skill'> = 'skill';
// @ts-expect-error Another event's required key must not widen this export.
export const invalidRouteProperty: keyof Pick<EngineObservationFacts<'route.resolved'>, 'skill'> = 'message_id';

// A single normal event is assignable to the exported discriminated union.
export const messageObservation: import('../../src/ports/telemetry.js').EngineObservation = {
  kind: 'message.created', workspaceId: 'ws_1', occurredAt: '2026-10-19T00:00:00.000Z',
  origin: { actor: 'unknown', client: 'unknown', version: 'unknown' },
  facts: { channel_id: 'ch_1', message_id: 'msg_1' },
};
