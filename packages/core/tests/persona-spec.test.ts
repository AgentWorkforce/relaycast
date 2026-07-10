import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HARNESS_VALUES,
  isPersonaIntent,
  parseAgentSpec,
  parsePersonaSpec,
} from "../src/proactive-runtime/persona-spec.js";

function validPersona(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p",
    intent: "documentation",
    tags: ["documentation"],
    description: "d",
    harness: "claude",
    model: "anthropic/claude-3-5-sonnet",
    systemPrompt: "be helpful",
    harnessSettings: { reasoning: "medium", timeoutSeconds: 300 },
    ...over,
  };
}

test("isPersonaIntent narrows known intents and rejects junk", () => {
  assert.equal(isPersonaIntent("documentation"), true);
  assert.equal(isPersonaIntent("not-a-real-intent"), false);
  assert.equal(isPersonaIntent(42), false);
  assert.equal(isPersonaIntent(undefined), false);
});

test("parsePersonaSpec accepts a minimal valid spec for the expected intent", () => {
  const spec = parsePersonaSpec(validPersona(), "documentation") as Record<string, unknown>;
  assert.equal(spec.id, "p");
  assert.equal(spec.intent, "documentation");
  assert.equal(spec.harness, "claude");
});

test("parsePersonaSpec accepts the grok harness (cloud#2191 drift regression)", () => {
  const spec = parsePersonaSpec(
    validPersona({ harness: "grok" }),
    "documentation",
  ) as Record<string, unknown>;
  assert.equal(spec.harness, "grok");
});

test("parsePersonaSpec throws on a malformed spec", () => {
  assert.throws(() => parsePersonaSpec({ id: "p" }, "documentation"));
});

test("parseAgentSpec validates a deployment agent spec", () => {
  const agent = parseAgentSpec({}, "agent");
  assert.equal(typeof agent, "object");
});

test("HARNESS_VALUES is sourced from the single pinned persona-kit and includes grok", () => {
  assert.ok(HARNESS_VALUES.includes("grok"));
  assert.ok(HARNESS_VALUES.includes("claude"));
});
