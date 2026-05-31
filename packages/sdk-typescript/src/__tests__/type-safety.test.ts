import { describe, expectTypeOf, it } from 'vitest';
import { AgentClient } from '../agent.js';
import { RelayCast } from '../relay.js';
import type {
  InvokeActionResult,
  DirectoryAgent,
  DirectorySearchResult,
  DmConversation,
  MessageWithMeta,
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
});
