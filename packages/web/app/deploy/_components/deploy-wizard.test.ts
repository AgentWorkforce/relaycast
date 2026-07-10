import { describe, expect, it } from "vitest";
import type { PersonaSummary } from "../_lib/types";
import {
  initialHarnessSourceForPersona,
  isDeployModelSelectionValid,
} from "./deploy-wizard";

function persona(overrides: Partial<PersonaSummary> = {}): PersonaSummary {
  return {
    id: "repo-hygiene",
    name: "Repo Hygiene",
    description: "Keep repositories tidy.",
    slug: "repo-hygiene",
    harness: "codex",
    model: "gpt-5.5",
    modelProvider: "openai",
    useSubscription: true,
    integrations: [],
    inputs: [],
    triggers: [],
    ...overrides,
  };
}

describe("deploy wizard model selection", () => {
  it("defaults OpenAI subscription personas to ChatGPT subscription", () => {
    expect(initialHarnessSourceForPersona(persona())).toBe("oauth");
  });

  it("defaults Anthropic subscription personas to the Claude setup-token source", () => {
    const anthropicPersona = persona({
      harness: "claude",
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
    });

    expect(initialHarnessSourceForPersona(anthropicPersona)).toBe("oauth");
    expect(isDeployModelSelectionValid({
      persona: anthropicPersona,
      harnessSource: "oauth",
      byokKey: "",
    })).toBe(true);
  });

  it("allows managed key as a valid OpenAI subscription persona selection", () => {
    expect(isDeployModelSelectionValid({
      persona: persona(),
      harnessSource: "managed",
      byokKey: "",
    })).toBe(true);
  });

  it("keeps non-subscription personas on plan by default", () => {
    const nonSubscriptionPersona = persona({ useSubscription: false });

    expect(initialHarnessSourceForPersona(nonSubscriptionPersona)).toBe("plan");
    expect(isDeployModelSelectionValid({
      persona: nonSubscriptionPersona,
      harnessSource: "managed",
      byokKey: "",
    })).toBe(false);
  });
});
