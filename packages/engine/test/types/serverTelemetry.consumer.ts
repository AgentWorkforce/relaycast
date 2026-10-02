import type { Context } from 'hono';
import type { ServerTelemetryRequiredProperty } from '@relaycast/types';
import type { AppEnv } from '../../src/env.js';
import { emitServerEvent } from '../../src/lib/serverTelemetry.js';

// Compiled by the engine typecheck; never executed.
export function telemetryConsumer(c: Context<AppEnv>): void {
  emitServerEvent(c, 'ws_1', 'relaycast_server_workspace_created', {});
  emitServerEvent(c, 'ws_1', 'relaycast_server_route_resolved', { skill: 'coding', extra: true });
  emitServerEvent(c, 'ws_1', 'relaycast_server_message_created', {
    channel_id: 'ch_1', message_id: 'msg_1',
  }, { actor: { id: 'agent_1', name: 'alice', type: 'agent', metadata: {} } });

  // @ts-expect-error Event names must exist in the server catalog.
  emitServerEvent(c, 'ws_1', 'relaycast_server_typo', {});
  // @ts-expect-error The resolved route must include its required skill.
  emitServerEvent(c, 'ws_1', 'relaycast_server_route_resolved', {});
  // @ts-expect-error Undefined required values would be stripped by ingestion.
  emitServerEvent(c, 'ws_1', 'relaycast_server_route_resolved', { skill: undefined });
  // @ts-expect-error Required properties are specific to the selected event.
  emitServerEvent(c, 'ws_1', 'relaycast_server_message_created', { skill: 'coding' });
}

export const routeProperty: ServerTelemetryRequiredProperty<'relaycast_server_route_resolved'> = 'skill';
// @ts-expect-error Another event's required key must not widen this export.
export const invalidRouteProperty: ServerTelemetryRequiredProperty<'relaycast_server_route_resolved'> = 'message_id';
