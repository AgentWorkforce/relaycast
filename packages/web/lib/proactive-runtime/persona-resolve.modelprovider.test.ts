import { describe, expect, it } from "vitest";

import { resolvePersonaFromSources } from "./persona-resolve";

const URL =
  "https://github.com/AgentWorkforce/agents/blob/main/daytona-monitor/persona.ts";

function personaSource(fields: string): string {
  return `import { definePersona } from '@agentworkforce/persona-kit';
export default definePersona({
  id: 'test-persona',
  description: 'Test persona for modelProvider inference.',
  cloud: true,
  ${fields}
});`;
}

describe("resolvePersonaFromSources modelProvider inference", () => {
  it("maps an opencode harness with a bare (provider-less) model id to opencode", () => {
    // Regression: bare opencode model ids carry no provider prefix, so the
    // resolver used to return the model id itself as the provider, which the
    // deploy wizard's credential routes rejected with "provider is required".
    const res = resolvePersonaFromSources({
      url: URL,
      personaSource: personaSource(
        "harness: 'opencode',\n  model: 'deepseek-v4-flash-free',",
      ),
    });
    expect(res.summary.modelProvider).toBe("opencode");
  });

  it("still infers anthropic for a claude model", () => {
    const res = resolvePersonaFromSources({
      url: URL,
      personaSource: personaSource(
        "harness: 'claude',\n  model: 'claude-sonnet-4-6',",
      ),
    });
    expect(res.summary.modelProvider).toBe("anthropic");
  });

  it("still infers openai for a gpt model", () => {
    const res = resolvePersonaFromSources({
      url: URL,
      personaSource: personaSource(
        "harness: 'codex',\n  model: 'gpt-5.5',",
      ),
    });
    expect(res.summary.modelProvider).toBe("openai");
  });
});
