import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPABILITY_ALIASES,
  capabilityConfig,
  hasPersonaCapability,
  isConflictAutofixPersona,
  isConflictResolvePersona,
  isPullRequestReviewerPersona,
  isTeamSolvePersona,
  personaWantsPullRequestWriteback,
} from "../src/proactive-runtime/capabilities.js";

test("capability aliases preserve review and conflict-autofix helper behavior", () => {
  assert.deepEqual(Object.keys(CAPABILITY_ALIASES).sort(), [
    "conflictAutofix",
    "conflictResolve",
    "conversational",
    "review",
    "teamSolve",
  ]);

  const reviewCases: Array<[unknown, boolean]> = [
    [{ capabilities: { pullRequest: true } }, true],
    [{ capabilities: { pullRequest: { enabled: true } } }, true],
    [{ capabilities: { pullRequest: {} } }, true],
    [{ capabilities: { pullRequest: { checkout: true } } }, true],
    [{ capabilities: { pullRequest: { formalReview: true } } }, true],
    [{ capabilities: { review: true } }, true],
    [{ capabilities: { review: { enabled: true } } }, true],
    [{ capabilities: { review: {} } }, true],
    [{ capabilities: { review: { enabled: false } } }, false],
    [{ capabilities: { pullRequest: { enabled: false } } }, false],
    [{ capabilities: { pullRequest: { enabled: false }, review: true } }, true],
    [{ intent: "review", capabilities: { pullRequest: { enabled: false } } }, false],
    [{ intent: "triage" }, false],
    [null, false],
  ];

  for (const [spec, expected] of reviewCases) {
    assert.equal(hasPersonaCapability(spec, "review"), expected);
    assert.equal(isPullRequestReviewerPersona(spec), expected);
  }

  const conflictAutofixCases: Array<[unknown, boolean]> = [
    [{ capabilities: { conflictAutofix: true } }, true],
    [{ capabilities: { conflictAutofix: { enabled: true } } }, true],
    [{ capabilities: { conflictAutofix: {} } }, true],
    [{ capabilities: { conflictAutofix: { enabled: false } } }, false],
    [{ capabilities: { pullRequest: true } }, false],
    [null, false],
  ];

  for (const [spec, expected] of conflictAutofixCases) {
    assert.equal(hasPersonaCapability(spec, "conflictAutofix"), expected);
    assert.equal(isConflictAutofixPersona(spec), expected);
  }

  const conflictResolveCases: Array<[unknown, boolean]> = [
    [{ capabilities: { conflictResolve: true } }, true],
    [{ capabilities: { conflictResolve: { enabled: true } } }, true],
    [{ capabilities: { conflictResolve: {} } }, true],
    [{ capabilities: { conflictResolve: { enabled: false } } }, false],
    [{ capabilities: { conflictAutofix: true } }, false],
    [null, false],
  ];

  for (const [spec, expected] of conflictResolveCases) {
    assert.equal(hasPersonaCapability(spec, "conflictResolve"), expected);
    assert.equal(isConflictResolvePersona(spec), expected);
  }

  const wrappedConflictAutofix = {
    persona: { capabilities: { conflictAutofix: true } },
    agent: {},
  };
  assert.equal(hasPersonaCapability(wrappedConflictAutofix, "conflictAutofix"), true);
  assert.equal(isConflictAutofixPersona(wrappedConflictAutofix), true);
});

test("pull request reviewer capability is explicit and intent fallback warns once", () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const intentOnly = { intent: "review" };
    assert.equal(isPullRequestReviewerPersona(intentOnly), true);
    assert.equal(isPullRequestReviewerPersona(intentOnly), true);
    assert.equal(personaWantsPullRequestWriteback(intentOnly), true);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0] ?? ""), /intent.*review.*back-compat/i);
    assert.deepEqual(warnings[0]?.[1], {
      diag: "persona-intent-review-capability-shim",
      capability: "pullRequest",
      intent: "review",
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(isPullRequestReviewerPersona({
    capabilities: {
      pullRequest: {
        checkout: true,
        writeback: true,
        formalReview: true,
        botIdentity: "agent-relay-bot[bot]",
      },
    },
  }), true);
  assert.equal(personaWantsPullRequestWriteback({
    capabilities: {
      pullRequest: {
        checkout: true,
        writeback: true,
        formalReview: true,
        botIdentity: "agent-relay-bot[bot]",
      },
    },
  }), true);

  const watchOnly = {
    capabilities: {
      pullRequest: {
        checkout: true,
        formalReview: true,
        botIdentity: "watch-only-reviewer[bot]",
      },
    },
  };
  assert.equal(isPullRequestReviewerPersona(watchOnly), true);
  assert.equal(personaWantsPullRequestWriteback(watchOnly), false);

  const wrappedWritebackReviewer = {
    persona: {
      capabilities: {
        pullRequest: {
          checkout: true,
          writeback: true,
          formalReview: true,
          botIdentity: "wrapped-reviewer[bot]",
        },
      },
    },
    agent: {},
  };
  assert.equal(isPullRequestReviewerPersona(wrappedWritebackReviewer), true);
  assert.equal(personaWantsPullRequestWriteback(wrappedWritebackReviewer), true);

  const disabledExplicitCapability = {
    intent: "review",
    capabilities: { pullRequest: { enabled: false } },
  };
  assert.equal(isPullRequestReviewerPersona(disabledExplicitCapability), false);
  assert.equal(personaWantsPullRequestWriteback(disabledExplicitCapability), false);
});

test("teamSolve aliases are declaration-gated and expose safe default config", () => {
  const intentSpec = { intent: "team-solve" };
  const enabledSpec = { capabilities: { teamSolve: { enabled: true } } };
  const disabledSpec = { capabilities: { teamSolve: { enabled: false } } };
  const wrappedEnabledSpec = {
    persona: { capabilities: { teamSolve: { enabled: true, maxMembers: 1 } } },
    agent: {},
  };

  assert.equal(hasPersonaCapability(intentSpec, "teamSolve"), true);
  assert.equal(isTeamSolvePersona(intentSpec), true);
  assert.equal(hasPersonaCapability(enabledSpec, "teamSolve"), true);
  assert.equal(isTeamSolvePersona(enabledSpec), true);
  assert.equal(hasPersonaCapability(wrappedEnabledSpec, "teamSolve"), true);
  assert.equal(isTeamSolvePersona(wrappedEnabledSpec), true);
  assert.equal(hasPersonaCapability(disabledSpec, "teamSolve"), false);
  assert.equal(isTeamSolvePersona(disabledSpec), false);
  assert.equal(isTeamSolvePersona({}), false);
  assert.equal(isTeamSolvePersona(null), false);

  assert.deepEqual(capabilityConfig(enabledSpec, "teamSolve"), {
    maxMembers: 4,
    tokenBudget: 400000,
    timeBudgetSeconds: 1800,
    roles: ["lead", "impl", "reviewer", "prober"],
  });

  assert.deepEqual(capabilityConfig(wrappedEnabledSpec, "teamSolve"), {
    maxMembers: 1,
    tokenBudget: 400000,
    timeBudgetSeconds: 1800,
    roles: ["lead", "impl", "reviewer", "prober"],
  });

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
