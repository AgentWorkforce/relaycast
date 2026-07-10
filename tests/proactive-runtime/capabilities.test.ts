import assert from "node:assert/strict";
import { test } from "node:test";

import {
  capabilityConfig,
  conversationalConfig,
  isConflictAutofixPersona,
  isConversationalPersona,
  isPullRequestReviewerPersona,
  isTeamSolvePersona,
  personaWantsPullRequestWriteback,
} from "@cloud/core/proactive-runtime/capabilities.js";

test("isPullRequestReviewerPersona supports legacy and new review aliases", () => {
  assert.equal(isPullRequestReviewerPersona({ capabilities: { pullRequest: true } }), true);
  assert.equal(isPullRequestReviewerPersona({ capabilities: { pullRequest: {} } }), true);
  assert.equal(
    isPullRequestReviewerPersona({ capabilities: { pullRequest: { enabled: false } } }),
    false,
  );
  assert.equal(isPullRequestReviewerPersona({ intent: "review" }), true);
  assert.equal(isPullRequestReviewerPersona({ capabilities: { review: true } }), true);
  assert.equal(isPullRequestReviewerPersona({ capabilities: { review: {} } }), true);
  assert.equal(
    isPullRequestReviewerPersona({ capabilities: { review: { enabled: true } } }),
    true,
  );
  assert.equal(
    isPullRequestReviewerPersona({ capabilities: { review: { enabled: false } } }),
    false,
  );
});

test("isPullRequestReviewerPersona lets explicit review opt in independently of pullRequest opt-out", () => {
  assert.equal(
    isPullRequestReviewerPersona({
      capabilities: { pullRequest: { enabled: false }, review: true },
    }),
    true,
  );
  assert.equal(
    isPullRequestReviewerPersona({
      intent: "review",
      capabilities: { pullRequest: { enabled: false } },
    }),
    false,
  );
});

test("personaWantsPullRequestWriteback remains separate from checkout and review authority", () => {
  const reviewerSpec = {
    capabilities: { pullRequest: { checkout: true, formalReview: true } },
  };
  assert.equal(isPullRequestReviewerPersona(reviewerSpec), true);
  assert.equal(personaWantsPullRequestWriteback(reviewerSpec), false);
  assert.equal(
    personaWantsPullRequestWriteback({
      capabilities: {
        pullRequest: { checkout: true, formalReview: true, writeback: true },
      },
    }),
    true,
  );
  assert.equal(personaWantsPullRequestWriteback({ intent: "review" }), true);
});

test("isPullRequestReviewerPersona is false when no review alias is present", () => {
  assert.equal(isPullRequestReviewerPersona({ capabilities: {} }), false);
  assert.equal(isPullRequestReviewerPersona(null), false);
  assert.equal(isPullRequestReviewerPersona(undefined), false);
  assert.equal(isPullRequestReviewerPersona("x"), false);
});

test("isConflictAutofixPersona supports enabled forms and explicit opt-out", () => {
  assert.equal(isConflictAutofixPersona({ capabilities: { conflictAutofix: true } }), true);
  assert.equal(isConflictAutofixPersona({ capabilities: { conflictAutofix: {} } }), true);
  assert.equal(
    isConflictAutofixPersona({ capabilities: { conflictAutofix: { enabled: true } } }),
    true,
  );
  assert.equal(
    isConflictAutofixPersona({ capabilities: { conflictAutofix: { enabled: false } } }),
    false,
  );
});

test("isConflictAutofixPersona is false without the capability alias", () => {
  assert.equal(isConflictAutofixPersona({}), false);
  assert.equal(isConflictAutofixPersona({ capabilities: {} }), false);
  assert.equal(isConflictAutofixPersona({ capabilities: { pullRequest: true } }), false);
  assert.equal(isConflictAutofixPersona(null), false);
  assert.equal(isConflictAutofixPersona(undefined), false);
  assert.equal(isConflictAutofixPersona("x"), false);
});

test("isTeamSolvePersona supports the intent alias and capability forms", () => {
  assert.equal(isTeamSolvePersona({ intent: "team-solve" }), true);
  assert.equal(isTeamSolvePersona({ capabilities: { teamSolve: true } }), true);
  assert.equal(isTeamSolvePersona({ capabilities: { teamSolve: {} } }), true);
  assert.equal(isTeamSolvePersona({ capabilities: { teamSolve: { enabled: true } } }), true);
  assert.equal(isTeamSolvePersona({ capabilities: { teamSolve: { enabled: false } } }), false);
});

test("isTeamSolvePersona is false when no teamSolve alias is present", () => {
  assert.equal(isTeamSolvePersona({}), false);
  assert.equal(isTeamSolvePersona({ capabilities: {} }), false);
  assert.equal(isTeamSolvePersona(null), false);
  assert.equal(isTeamSolvePersona(undefined), false);
  assert.equal(isTeamSolvePersona("x"), false);
});

test("isConversationalPersona supports boolean and object capability forms", () => {
  assert.equal(isConversationalPersona({ capabilities: { conversational: true } }), true);
  assert.equal(
    isConversationalPersona({
      capabilities: {
        conversational: {
          enabled: true,
          defaultResponder: true,
          channels: ["C123", "#ops"],
          identity: {
            username: "Router",
            iconUrl: "https://example.com/router.png",
          },
        },
      },
    }),
    true,
  );
});

test("isConversationalPersona respects explicit opt-out and wrapped deployment snapshots", () => {
  assert.equal(
    isConversationalPersona({ capabilities: { conversational: { enabled: false } } }),
    false,
  );
  assert.equal(
    isConversationalPersona({
      persona: {
        capabilities: {
          conversational: {
            enabled: true,
            defaultResponder: true,
          },
        },
      },
      agent: {},
    }),
    true,
  );
});

test("capabilityConfig returns safe teamSolve defaults", () => {
  assert.deepEqual(capabilityConfig({ capabilities: { teamSolve: true } }, "teamSolve"), {
    maxMembers: 4,
    tokenBudget: 400000,
    timeBudgetSeconds: 1800,
    roles: ["lead", "impl", "reviewer", "prober"],
  });
});

test("capabilityConfig reads valid teamSolve budget fields", () => {
  assert.deepEqual(
    capabilityConfig(
      {
        capabilities: {
          teamSolve: {
            enabled: true,
            maxMembers: 6,
            tokenBudget: 100000,
            timeBudgetSeconds: 900,
            roles: ["lead", "impl"],
          },
        },
      },
      "teamSolve",
    ),
    {
      maxMembers: 6,
      tokenBudget: 100000,
      timeBudgetSeconds: 900,
      roles: ["lead", "impl"],
    },
  );
});

test("capabilityConfig normalizes invalid teamSolve budget fields to safe defaults", () => {
  assert.deepEqual(
    capabilityConfig(
      {
        capabilities: {
          teamSolve: {
            enabled: true,
            maxMembers: -1,
            tokenBudget: "lots",
            timeBudgetSeconds: 0,
            roles: ["lead", "", 42],
          },
        },
      },
      "teamSolve",
    ),
    {
      maxMembers: 4,
      tokenBudget: 400000,
      timeBudgetSeconds: 1800,
      roles: ["lead"],
    },
  );
});

test("conversationalConfig normalizes defaults from a boolean capability", () => {
  assert.deepEqual(conversationalConfig({ capabilities: { conversational: true } }), {
    enabled: true,
    defaultResponder: false,
    channels: [],
  });
});

test("conversationalConfig reads object fields and identity overrides", () => {
  assert.deepEqual(
    conversationalConfig({
      capabilities: {
        conversational: {
          enabled: true,
          defaultResponder: true,
          channels: ["C123", "#triage"],
          identity: {
            username: "Ops Router",
            iconUrl: "https://example.com/ops-router.png",
          },
        },
      },
    }),
    {
      enabled: true,
      defaultResponder: true,
      channels: ["C123", "#triage"],
      identity: {
        username: "Ops Router",
        iconUrl: "https://example.com/ops-router.png",
      },
    },
  );
});

test("conversationalConfig resolves through personaCapabilities for wrapped deployment snapshots", () => {
  assert.deepEqual(
    conversationalConfig({
      persona: {
        capabilities: {
          conversational: {
            enabled: true,
            defaultResponder: true,
            channels: ["C123"],
            identity: {
              username: " Wrapped Router ",
              iconUrl: "https://example.com/wrapped-router.png",
            },
          },
        },
      },
      agent: {},
    }),
    {
      enabled: true,
      defaultResponder: true,
      channels: ["C123"],
      identity: {
        username: "Wrapped Router",
        iconUrl: "https://example.com/wrapped-router.png",
      },
    },
  );
});

test("conversationalConfig returns a disabled config when the capability is absent or opted out", () => {
  assert.deepEqual(conversationalConfig({ capabilities: {} }), {
    enabled: false,
    defaultResponder: false,
    channels: [],
  });
  assert.deepEqual(
    conversationalConfig({
      capabilities: {
        conversational: {
          enabled: false,
          defaultResponder: true,
          channels: ["C123"],
        },
      },
    }),
    {
      enabled: false,
      defaultResponder: true,
      channels: ["C123"],
    },
  );
});
