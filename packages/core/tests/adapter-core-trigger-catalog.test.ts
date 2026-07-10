import assert from "node:assert/strict";
import { test } from "node:test";

import { KNOWN_TRIGGER_CATALOG } from "@relayfile/adapter-core";

test("adapter-core GitHub trigger catalog includes persona deploy triggers", () => {
  const githubTriggers = KNOWN_TRIGGER_CATALOG.github;
  assert.ok(Array.isArray(githubTriggers), "KNOWN_TRIGGER_CATALOG.github should be an array");

  for (const trigger of [
    "check_run.completed",
    "pull_request.synchronize",
    "pull_request_review.submitted",
  ]) {
    assert.ok(
      githubTriggers.includes(trigger),
      `Expected GitHub trigger catalog to include "${trigger}"`,
    );
  }
});
