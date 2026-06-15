import { describe, expectTypeOf, it } from 'vitest';
import type * as Raw from '@relaycast/types';
import { AgentClient } from '../agent.js';
import { RelayCast } from '../relay.js';
import type {
  ActionInvocation,
  CompleteInvocationRequest,
  InvokeActionResult,
  DirectoryAgent,
  DirectorySearchResult,
  DmConversation,
  JsonValue,
  MessageWithMeta,
  NodeCapability,
  NodeRosterEntry,
  RouteResult,
  RoutingConfig,
  SearchResult,
} from '../types.js';

describe('AgentClient return types', () => {
  it('exposes strongly typed results for messaging and actions', () => {
    expectTypeOf<ReturnType<AgentClient['dm']>>()
      .toEqualTypeOf<Promise<MessageWithMeta>>();
    expectTypeOf<ReturnType<AgentClient['dms']['createGroup']>>()
      .toEqualTypeOf<Promise<DmConversation>>();
    expectTypeOf<ReturnType<AgentClient['dms']['sendMessage']>>()
      .toEqualTypeOf<Promise<MessageWithMeta>>();
    expectTypeOf<ReturnType<AgentClient['search']>>()
      .toEqualTypeOf<Promise<SearchResult[]>>();
    expectTypeOf<ReturnType<AgentClient['actions']['invoke']>>()
      .toEqualTypeOf<Promise<InvokeActionResult>>();
  });

  it('exposes strongly typed results for directory and routing methods', () => {
    expectTypeOf<ReturnType<RelayCast['route']>>()
      .toEqualTypeOf<Promise<RouteResult>>();
    expectTypeOf<ReturnType<RelayCast['searchDirectory']>>()
      .toEqualTypeOf<Promise<DirectorySearchResult[]>>();
    expectTypeOf<ReturnType<RelayCast['publishToDirectory']>>()
      .toEqualTypeOf<Promise<DirectoryAgent>>();
    expectTypeOf<ReturnType<RelayCast['importSkills']>>()
      .toEqualTypeOf<Promise<DirectoryAgent | null>>();
    expectTypeOf<ReturnType<RelayCast['getRoutingConfig']>>()
      .toEqualTypeOf<Promise<RoutingConfig>>();
    expectTypeOf<ReturnType<RelayCast['updateRoutingConfig']>>()
      .toEqualTypeOf<Promise<RoutingConfig>>();
  });

  it('keeps fleet node + action types aligned with the runtime wire contract', () => {
    // Node roster capabilities are structured objects, not capability-name strings.
    expectTypeOf<NodeRosterEntry['capabilities']>().toEqualTypeOf<NodeCapability[]>();
    expectTypeOf<NodeCapability>().toEqualTypeOf<Raw.FleetCapability>();
    expectTypeOf<NodeCapability['name']>().toEqualTypeOf<string>();
    // A bare capability-name string must NOT satisfy the capability object shape.
    expectTypeOf<string>().not.toMatchTypeOf<NodeCapability>();

    // Action invocation output is any JSON value (scalars / arrays / null legal),
    // mirroring the runtime FleetWireJsonValue rather than being object-only.
    expectTypeOf<JsonValue>().toEqualTypeOf<Raw.FleetWireJsonValue>();
    expectTypeOf<ActionInvocation['output']>().toEqualTypeOf<JsonValue>();
    expectTypeOf<CompleteInvocationRequest['output']>().toEqualTypeOf<JsonValue | undefined>();
    expectTypeOf<number>().toMatchTypeOf<JsonValue>();
    expectTypeOf<string>().toMatchTypeOf<JsonValue>();
    expectTypeOf<null>().toMatchTypeOf<JsonValue>();
    expectTypeOf<JsonValue[]>().toMatchTypeOf<JsonValue>();
  });
});
