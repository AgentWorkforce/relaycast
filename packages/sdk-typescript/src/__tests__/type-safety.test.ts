import { describe, expectTypeOf, it } from 'vitest';
import { AgentClient } from '../agent.js';
import type {
  CommandInvokeResult,
  DmConversation,
  MessageWithMeta,
  SearchResult,
} from '../types.js';

describe('AgentClient return types', () => {
  it('exposes strongly typed results for messaging and commands', () => {
    expectTypeOf<ReturnType<AgentClient['dm']>>()
      .toEqualTypeOf<Promise<MessageWithMeta>>();
    expectTypeOf<ReturnType<AgentClient['dms']['createGroup']>>()
      .toEqualTypeOf<Promise<DmConversation>>();
    expectTypeOf<ReturnType<AgentClient['dms']['sendMessage']>>()
      .toEqualTypeOf<Promise<MessageWithMeta>>();
    expectTypeOf<ReturnType<AgentClient['search']>>()
      .toEqualTypeOf<Promise<SearchResult[]>>();
    expectTypeOf<ReturnType<AgentClient['commands']['invoke']>>()
      .toEqualTypeOf<Promise<CommandInvokeResult>>();
  });
});
