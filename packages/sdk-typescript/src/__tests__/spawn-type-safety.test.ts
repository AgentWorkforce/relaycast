import { describe, expectTypeOf, it } from 'vitest';
import type { RelayCast, SpawnAgentRequest } from '../index.js';

describe('spawn CLI types', () => {
  it('preserves the supported CLI union through the public SDK', () => {
    type SupportedCli = 'claude' | 'codex' | 'gemini' | 'aider' | 'goose' | 'opencode' | 'grok' | 'muse' | 'devin';
    expectTypeOf<SpawnAgentRequest['cli']>().toEqualTypeOf<SupportedCli>();
    expectTypeOf<Parameters<RelayCast['agents']['spawn']>[0]['cli']>().toEqualTypeOf<SupportedCli>();
  });
});
