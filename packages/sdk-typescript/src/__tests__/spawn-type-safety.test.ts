import { describe, expectTypeOf, it } from 'vitest';
import type { RelayCast, SpawnAgentRequest } from '../index.js';

describe('spawn CLI types', () => {
  it('accepts named harnesses and any other harness id', () => {
    type NamedCli = 'claude' | 'codex' | 'gemini' | 'aider' | 'goose' | 'opencode' | 'grok' | 'muse' | 'devin';
    expectTypeOf<NamedCli>().toMatchTypeOf<SpawnAgentRequest['cli']>();
    expectTypeOf<'cursor'>().toMatchTypeOf<SpawnAgentRequest['cli']>();
    expectTypeOf<Parameters<RelayCast['agents']['spawn']>[0]['cli']>().toEqualTypeOf<SpawnAgentRequest['cli']>();
  });
});
