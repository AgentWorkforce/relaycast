import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GITHUB_EVENTS } from "@relayfile/adapter-github";
import { EVENT_MAP as GITLAB_EVENT_MAP } from "@relayfile/adapter-gitlab";
import { SlackAdapter } from "@relayfile/adapter-slack";

import {
  agentMatchesEvent,
  deriveIntegrationWatchDeliveryId,
  parseWatchRules,
  pathCouldIntersect,
  watchRuleMatchMatches,
  watchRulesMatchEvent,
} from "../src/proactive-runtime/match.js";
import { relayfilePathsForIntegrations } from "../src/relayfile/path-scopes.js";
import {
  SLACK_SUPPORTED_EVENTS,
  relayfilePathsForProviderTrigger,
  resolveRelayfileProviderContract,
} from "../src/relayfile/provider-contracts.js";

test("agentMatchesEvent requires both watch glob and provider trigger match", () => {
  assert.equal(
    agentMatchesEvent({
      row: {
        id: "agent-1",
        watch_globs: ["/github/repos/**/**/issues/**"],
        spec: {
          integrations: {
            github: { triggers: [{ on: "issues.opened" }] },
          },
        },
      },
      provider: "github",
      eventType: "issues.opened",
      eventPaths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
    }),
    true,
  );

  assert.equal(
    agentMatchesEvent({
      row: {
        id: "agent-1",
        watch_globs: ["/github/repos/**/**/issues/**"],
        spec: {
          integrations: {
            github: { triggers: [{ on: "issues.closed" }] },
          },
        },
      },
      provider: "github",
      eventType: "issues.opened",
      eventPaths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
    }),
    false,
  );
});

test("agentMatchesEvent reads top-level agent triggers from deployment snapshots", () => {
  assert.equal(
    agentMatchesEvent({
      row: {
        id: "agent-1",
        watch_globs: ["/github/repos/**/**/pulls/**"],
        spec: {
          persona: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
          agent: {
            triggers: {
              github: [{ on: "pull_request.opened" }],
            },
          },
        },
      },
      provider: "github",
      eventType: "pull_request.opened",
      eventPaths: ["/github/repos/acme/cloud/pulls/42__feature/meta.json"],
    }),
    true,
  );

  assert.equal(
    agentMatchesEvent({
      row: {
        id: "agent-1",
        watch_globs: ["/github/repos/**/**/issues/**"],
        spec: {
          persona: {
            integrations: {
              github: { triggers: [{ on: "issues.opened" }] },
            },
          },
          agent: {
            triggers: {
              github: [{ on: "pull_request.opened" }],
            },
          },
        },
      },
      provider: "github",
      eventType: "issues.opened",
      eventPaths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
    }),
    false,
  );
});

test("agentMatchesEvent can be used by gateway watch registrations without persona specs", () => {
  assert.equal(
    agentMatchesEvent(
      {
        row: {
          id: "agent-1",
          watch_globs: ["/**/issues/opened/**"],
          spec: null,
        },
        provider: "github",
        eventType: "issues.opened",
        eventPaths: ["/github/issues/opened/42.json"],
      },
      { requireTriggerSpec: false },
    ),
    true,
  );
});

test("agentMatchesEvent prefers watch rules when present", () => {
  assert.equal(
    agentMatchesEvent({
      row: {
        id: "agent-1",
        watch_globs: ["/github/issues/closed/**"],
        watch_rules: [
          { paths: ["/github/issues/opened/**"], events: ["issues.opened"] },
        ],
        spec: null,
      },
      provider: "github",
      eventType: "issues.opened",
      eventPaths: ["/github/issues/opened/42.json"],
    }),
    true,
  );

  assert.equal(
    agentMatchesEvent({
      row: {
        id: "agent-1",
        watch_globs: ["/github/issues/opened/**"],
        watch_rules: [
          { paths: ["/github/issues/opened/**"], events: ["issues.closed"] },
        ],
        spec: null,
      },
      provider: "github",
      eventType: "issues.opened",
      eventPaths: ["/github/issues/opened/42.json"],
    }),
    false,
  );
});

test("watch-rule conditions filter a check_run by conclusion", () => {
  const row = {
    id: "ci-fix",
    watch_globs: [],
    watch_rules: [
      {
        paths: ["/github/repos/AgentWorkforce/cloud/checks/**"],
        events: ["check_run.completed"],
        conditions: [
          { field: "conclusion", in: ["failure", "timed_out", "action_required"] },
        ],
      },
    ],
    spec: null,
  };
  const eventPaths = ["/github/repos/AgentWorkforce/cloud/checks/991.json"];

  // A failing check wakes the persona.
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "check_run.completed",
      eventPaths,
      payload: { conclusion: "failure", pull_requests: [{ number: 7 }] },
    }),
    true,
  );

  // A passing check is filtered out — this is what breaks the fix→re-run loop.
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "check_run.completed",
      eventPaths,
      payload: { conclusion: "success", pull_requests: [{ number: 7 }] },
    }),
    false,
  );

  // Conditions present but no payload threaded ⇒ cannot satisfy ⇒ no match
  // (a missing field resolves to "" which is not in the failure set).
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "check_run.completed",
      eventPaths,
    }),
    false,
  );
});

test("watch-rule conditions support nested dot-path fields and equals", () => {
  const row = {
    id: "ci-fix",
    watch_globs: [],
    watch_rules: [
      {
        paths: ["/github/repos/AgentWorkforce/cloud/checks/**"],
        events: ["check_run.completed"],
        conditions: [{ field: "check_run.conclusion", equals: "failure" }],
      },
    ],
    spec: null,
  };
  const eventPaths = ["/github/repos/AgentWorkforce/cloud/checks/12.json"];

  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "check_run.completed",
      eventPaths,
      payload: { check_run: { conclusion: "failure" } },
    }),
    true,
  );
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "check_run.completed",
      eventPaths,
      payload: { check_run: { conclusion: "neutral" } },
    }),
    false,
  );
});

test("watch-rule conditions match values inside arrays without changing scalar behavior", () => {
  const row = {
    id: "team-issue",
    watch_globs: [],
    watch_rules: [
      {
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.opened"],
        conditions: [
          { field: "issue.state", equals: "open" },
          { field: "issue.labels.name", equals: "team" },
        ],
      },
    ],
    spec: null,
  };
  const eventPaths = ["/github/repos/AgentWorkforce/cloud/issues/2048.json"];

  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "issues.opened",
      eventPaths,
      payload: {
        issue: {
          state: "open",
          labels: [{ name: "bug" }, { name: "team" }],
        },
      },
    }),
    true,
  );
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "issues.opened",
      eventPaths,
      payload: {
        issue: {
          state: "open",
          labels: [{ name: "bug" }, { name: "small" }],
        },
      },
    }),
    false,
  );
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "issues.opened",
      eventPaths,
      payload: {
        issue: {
          state: "closed",
          labels: [{ name: "team" }],
        },
      },
    }),
    false,
  );
});

test("watch-rule conditions match scalar arrays at the resolved field", () => {
  const row = {
    id: "tagged-issue",
    watch_globs: [],
    watch_rules: [
      {
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        events: ["issues.opened"],
        conditions: [{ field: "issue.tags", equals: "team" }],
      },
    ],
    spec: null,
  };
  const eventPaths = ["/github/repos/AgentWorkforce/cloud/issues/2048.json"];

  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "issues.opened",
      eventPaths,
      payload: { issue: { tags: ["bug", "team"] } },
    }),
    true,
  );
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "issues.opened",
      eventPaths,
      payload: { issue: { tags: ["bug", "small"] } },
    }),
    false,
  );
});

test("Slack message trigger matching still follows provider trigger paths", () => {
  assert.deepEqual(
    relayfilePathsForProviderTrigger("slack", "message.created"),
    ["/slack/channels/**/messages/**", "/slack/users/**/messages/**"],
  );

  assert.equal(
    agentMatchesEvent({
      row: {
        id: "slack-agent",
        watch_globs: ["/slack/channels/proj-cloud/messages/**"],
        spec: {
          integrations: {
            slack: { triggers: [{ on: "message.created" }] },
          },
        },
      },
      provider: "slack",
      eventType: "message.created",
      eventPaths: ["/slack/channels/proj-cloud/messages/1700000000.000000.json"],
    }),
    true,
  );
});

test("GitHub issue resolver trigger matching stays scoped to issue events and repo", () => {
  const row = {
    id: "issue-resolver",
    watch_globs: ["/github/repos/AgentWorkforce/cloud/issues/**"],
    spec: {
      persona: {},
      agent: {
        triggers: {
          github: [
            {
              on: "issues.opened",
              paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
            },
            {
              on: "issues.labeled",
              paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
            },
          ],
        },
      },
    },
  };

  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "issues.opened",
      eventPaths: ["/github/repos/AgentWorkforce/cloud/issues/2048.json"],
    }),
    true,
  );
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "issues.labeled",
      eventPaths: ["/github/repos/AgentWorkforce/cloud/issues/2048.json"],
    }),
    true,
  );
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "issues.closed",
      eventPaths: ["/github/repos/AgentWorkforce/cloud/issues/2048.json"],
    }),
    false,
  );
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "github",
      eventType: "issues.opened",
      eventPaths: ["/github/repos/OtherOrg/cloud/issues/2048.json"],
    }),
    false,
  );
});

test("Linear agent webhook triggers derive paths and match proactive events", () => {
  assert.deepEqual(
    relayfilePathsForProviderTrigger("linear", "AgentSessionEvent.created"),
    ["/linear/agent-sessions/**"],
  );
  assert.deepEqual(
    relayfilePathsForIntegrations({
      linear: { triggers: [{ on: "AppUserNotification.issueAssignedToYou" }] },
    }),
    ["/linear/app-user-notifications/**"],
  );

  assert.equal(
    agentMatchesEvent({
      row: {
        id: "agent-1",
        watch_globs: ["/linear/agent-sessions/**"],
        spec: {
          integrations: {
            linear: { triggers: [{ on: "AgentSessionEvent.created" }] },
          },
        },
      },
      provider: "linear",
      eventType: "AgentSessionEvent.created",
      eventPaths: ["/linear/agent-sessions/session_linear_123.json"],
    }),
    true,
  );
});

test("GitHub pull request review triggers derive review paths", () => {
  for (const trigger of [
    "pull_request_review.submitted",
    "pull_request_review.dismissed",
    "pull_request_review.edited",
  ]) {
    assert.deepEqual(
      relayfilePathsForProviderTrigger("github", trigger),
      ["/github/repos/**/**/pulls/**/reviews/**"],
    );
  }

  assert.deepEqual(
    relayfilePathsForIntegrations({
      github: {
        triggers: [
          { on: "pull_request_review.submitted" },
          { on: "pull_request_review.dismissed" },
          { on: "pull_request_review.edited" },
        ],
      },
    }),
    ["/github/repos/**/**/pulls/**/reviews/**"],
  );
});

test("adapter catalog events derive Relayfile paths without local resource aliases", () => {
  for (const trigger of DEFAULT_GITHUB_EVENTS) {
    assert.ok(
      relayfilePathsForProviderTrigger("github", trigger).length > 0,
      `GitHub trigger ${trigger} should derive at least one Relayfile path`,
    );
  }

  for (const trigger of Object.keys(GITLAB_EVENT_MAP)) {
    assert.ok(
      relayfilePathsForProviderTrigger("gitlab", trigger).length > 0,
      `GitLab trigger ${trigger} should derive at least one Relayfile path`,
    );
  }

  const slackSupportedEvents = new SlackAdapter(
    { writeFile: async () => ({}) },
    {} as never,
    {} as never,
  ).supportedEvents();
  assert.deepEqual(
    resolveRelayfileProviderContract("slack")?.triggerEvents,
    slackSupportedEvents,
  );
  for (const trigger of slackSupportedEvents) {
    assert.ok(
      relayfilePathsForProviderTrigger("slack", trigger).length > 0,
      `Slack trigger ${trigger} should derive at least one Relayfile path`,
    );
  }
});

test("Cloud consumes Slack message.created from the adapter trigger catalog", () => {
  assert.ok(SLACK_SUPPORTED_EVENTS.includes("message.created"));
});

test("Slack message.created triggers use the canonical dotted event name", () => {
  assert.ok(
    relayfilePathsForProviderTrigger("slack", "message.created").length > 0,
  );

  const row = {
    id: "agent-1",
    watch_globs: ["/slack/channels/**/messages/**"],
    spec: {
      integrations: {
        slack: { triggers: [{ on: "message.created" }] },
      },
    },
  };

  assert.equal(
    agentMatchesEvent({
      row,
      provider: "slack",
      eventType: "message.created",
      eventPaths: ["/slack/channels/C123/messages/1711111000_000100/meta.json"],
    }),
    true,
  );
});

test("Slack app_mention triggers derive channel paths and match live mention events", () => {
  assert.deepEqual(
    relayfilePathsForIntegrations({
      slack: { triggers: [{ on: "app_mention" }] },
    }),
    ["/slack/channels/**", "/slack/users/**/messages/**"],
  );

  const row = {
    id: "agent-1",
    watch_globs: ["/slack/channels/**"],
    spec: {
      integrations: {
        slack: { triggers: [{ on: "app_mention" }] },
      },
    },
  };

  assert.equal(
    agentMatchesEvent({
      row,
      provider: "slack",
      eventType: "app_mention",
      eventPaths: ["/slack/channels/C123/messages/1711111000_000100/meta.json"],
    }),
    true,
  );

  assert.equal(
    agentMatchesEvent({
      row,
      provider: "slack",
      eventType: "message.created",
      eventPaths: ["/slack/channels/C123/messages/1711111000_000100/meta.json"],
    }),
    false,
  );
});

test("Linear AgentSessionEvent triggers match transition and adapter materialization paths", () => {
  const chatLead = {
    id: "linear-chat-lead",
    watch_globs: ["/linear/agent-sessions/**", "/linear/comments/**"],
    spec: {
      agent: {
        triggers: {
          linear: [
            {
              on: "AgentSessionEvent.created",
              paths: ["/linear/agent-sessions/**", "/linear/comments/**"],
            },
            {
              on: "AgentSessionEvent.prompted",
              paths: ["/linear/agent-sessions/**", "/linear/comments/**"],
            },
          ],
        },
      },
      persona: {
        integrations: {
          linear: {},
        },
      },
    },
  };

  assert.equal(
    agentMatchesEvent({
      row: chatLead,
      provider: "linear",
      eventType: "AgentSessionEvent.prompted",
      eventPaths: ["/linear/comments/12e0c1d1.json"],
      payload: {
        type: "AgentSessionEvent",
        action: "prompted",
        agentSession: { id: "session-1" },
        agentActivity: { id: "activity-1", body: "Please implement this." },
      },
    }),
    true,
  );

  assert.equal(
    agentMatchesEvent({
      row: chatLead,
      provider: "linear",
      eventType: "AgentSessionEvent.prompted",
      eventPaths: ["/linear/agent-sessions/session-1.json"],
      payload: {
        type: "AgentSessionEvent",
        action: "prompted",
        agentSession: { id: "session-1" },
      },
    }),
    true,
  );

  assert.equal(
    agentMatchesEvent({
      row: {
        ...chatLead,
        watch_globs: ["/linear/comments/**"],
        spec: {
          agent: {
            triggers: {
              linear: [
                { on: "AgentSessionEvent.prompted", paths: ["/linear/comments/**"] },
              ],
            },
          },
        },
      },
      provider: "linear",
      eventType: "AgentSessionEvent.prompted",
      eventPaths: ["/linear/agent-sessions/session-1.json"],
    }),
    false,
  );
});

test("deriveIntegrationWatchDeliveryId versions pull request deliveries by head and base sha", () => {
  const baseInput = {
    workspaceId: "ws_123",
    provider: "github",
    eventType: "pull_request.synchronize",
    connectionId: "conn_123",
    paths: ["/github/repos/acme/cloud/pulls/60__fix/meta.json"],
  };

  const firstPush = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      pull_request: {
        head: { sha: "d09b80c" },
        base: { sha: "base123" },
      },
    },
  });
  const secondPush = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      pull_request: {
        head: { sha: "7a4cc44" },
        base: { sha: "base123" },
      },
    },
  });

  assert.notEqual(
    firstPush,
    secondPush,
    "distinct pull_request.synchronize head SHAs must not collapse to one dedupe key",
  );
  assert.equal(firstPush.endsWith(":d09b80c:base123"), true);
  assert.equal(secondPush.endsWith(":7a4cc44:base123"), true);
});

test("deriveIntegrationWatchDeliveryId preserves pull request retry coalescing for the same head sha", () => {
  const firstDelivery = deriveIntegrationWatchDeliveryId({
    workspaceId: "ws_123",
    provider: "github",
    eventType: "pull_request.synchronize",
    connectionId: "conn_123",
    paths: ["/github/repos/acme/cloud/pulls/60__fix/meta.json"],
    payload: {
      pull_request: {
        head: { sha: "d09b80c" },
        base: { sha: "base123" },
      },
    },
  });
  const retryDelivery = deriveIntegrationWatchDeliveryId({
    workspaceId: "ws_123",
    provider: "github",
    eventType: "pull_request.synchronize",
    connectionId: "conn_123",
    paths: ["/github/repos/acme/cloud/pulls/60__fix/meta.json"],
    payload: {
      pull_request: {
        head: { sha: "d09b80c" },
        base: { sha: "base123" },
      },
    },
  });

  assert.equal(firstDelivery, retryDelivery);
});

test("deriveIntegrationWatchDeliveryId versions pull request review comments by comment id", () => {
  const baseInput = {
    workspaceId: "ws_123",
    provider: "github",
    eventType: "pull_request_review_comment.created",
    connectionId: "conn_123",
    paths: ["/github/repos/acme/cloud/pulls/60__fix/meta.json"],
  };
  const firstComment = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      comment: { id: 111 },
      pull_request: {
        head: { sha: "d09b80c" },
        base: { sha: "base123" },
      },
    },
  });
  const secondComment = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      comment: { id: 222 },
      pull_request: {
        head: { sha: "d09b80c" },
        base: { sha: "base123" },
      },
    },
  });
  const retryComment = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      comment: { id: 111 },
      pull_request: {
        head: { sha: "d09b80c" },
        base: { sha: "base123" },
      },
    },
  });

  assert.notEqual(firstComment, secondComment);
  assert.equal(firstComment, retryComment);
  assert.equal(firstComment.endsWith(":comment:111"), true);
  assert.equal(secondComment.endsWith(":comment:222"), true);
});

test("deriveIntegrationWatchDeliveryId versions pull request reviews by review id", () => {
  const baseInput = {
    workspaceId: "ws_123",
    provider: "github",
    eventType: "pull_request_review.submitted",
    connectionId: "conn_123",
    paths: ["/github/repos/acme/cloud/pulls/60__fix/meta.json"],
  };
  const firstReview = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      review: { id: 333 },
      pull_request: {
        head: { sha: "d09b80c" },
        base: { sha: "base123" },
      },
    },
  });
  const secondReview = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      review: { id: 444 },
      pull_request: {
        head: { sha: "d09b80c" },
        base: { sha: "base123" },
      },
    },
  });

  assert.notEqual(firstReview, secondReview);
  assert.equal(firstReview.endsWith(":review:333"), true);
  assert.equal(secondReview.endsWith(":review:444"), true);
});

test("deriveIntegrationWatchDeliveryId versions issue comments on pull requests by comment id", () => {
  const baseInput = {
    workspaceId: "ws_123",
    provider: "github",
    eventType: "issue_comment.created",
    connectionId: "conn_123",
    paths: ["/github/repos/acme/cloud/issues/60__fix/meta.json"],
  };
  const firstComment = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      comment: { id: "ic_111" },
      issue: { pull_request: { url: "https://api.github.com/repos/acme/cloud/pulls/60" } },
    },
  });
  const secondComment = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      comment: { id: "ic_222" },
      issue: { pull_request: { url: "https://api.github.com/repos/acme/cloud/pulls/60" } },
    },
  });
  const retryComment = deriveIntegrationWatchDeliveryId({
    ...baseInput,
    payload: {
      comment: { id: "ic_111" },
      issue: { pull_request: { url: "https://api.github.com/repos/acme/cloud/pulls/60" } },
    },
  });

  assert.notEqual(firstComment, secondComment);
  assert.equal(firstComment, retryComment);
  assert.equal(firstComment.endsWith(":comment:ic_111"), true);
  assert.equal(secondComment.endsWith(":comment:ic_222"), true);
});

test("deriveIntegrationWatchDeliveryId keeps non-pull-request event keys byte-identical", () => {
  assert.equal(
    deriveIntegrationWatchDeliveryId({
      workspaceId: "ws_123",
      provider: "github",
      eventType: "issue_comment.created",
      connectionId: "  conn_123  ",
      paths: ["/github/repos/acme/cloud/issues/42__bug/comments/1.json"],
      payload: {
        z: 1,
        a: "ignored when paths are present",
      },
    }),
    "integration-watch:ws_123:github:issue_comment.created:conn_123:" +
      "/github/repos/acme/cloud/issues/42__bug/comments/1.json",
  );

  assert.equal(
    deriveIntegrationWatchDeliveryId({
      workspaceId: "ws_123",
      provider: "github",
      eventType: "check_run.completed",
      connectionId: null,
      payload: {
        z: 1,
        a: "stable",
      },
    }),
    'integration-watch:ws_123:github:check_run.completed:no-connection:{"a":"stable","z":1}',
  );
});

test("pathCouldIntersect handles cross-provider issue globs", () => {
  assert.equal(pathCouldIntersect("/**/issues/opened/**", "/github/issues/opened/42.json"), true);
  assert.equal(pathCouldIntersect("/github/pulls/**", "/linear/issues/42.json"), false);
});

// --- trigger `match` / `where` enforcement (gates sandbox provisioning) ------
//
// Root cause this exercises: a Slack chat agent declares
//   triggers: { slack: [{ on: "message.created", paths: [...], match: "@mention" }] }
// but `match` was validated then dropped — the matcher never referenced it, so
// EVERY channel message woke the agent and provisioned a Daytona box. These
// tests pin that absent-match is byte-unchanged and present-match actually gates.

const SLACK_MESSAGE_PATH = "/slack/channels/C123/messages/1700000000.json";
const SLACK_WATCH_PATH = "/slack/channels/C123/messages/**";

test("watchRuleMatchMatches: absent match never gates", () => {
  assert.equal(watchRuleMatchMatches(undefined, { text: "anything" }), true);
  assert.equal(watchRuleMatchMatches(undefined, {}), true);
  assert.equal(watchRuleMatchMatches(undefined, null), true);
});

test("watchRuleMatchMatches: @mention fires only when text has a mention token", () => {
  assert.equal(watchRuleMatchMatches("@mention", { text: "hey <@U999> ping" }), true);
  assert.equal(watchRuleMatchMatches("@mention", { text: "subteam <!subteam^S1|@team>" }), true);
  assert.equal(watchRuleMatchMatches("@mention", { text: "just a plain message" }), false);
  assert.equal(watchRuleMatchMatches("@mention", { text: "email me@example.com" }), false);
  assert.equal(watchRuleMatchMatches("@mention", { text: "" }), false);
});

test("watchRuleMatchMatches: plain string is a case-insensitive substring test", () => {
  assert.equal(watchRuleMatchMatches("Deploy", { text: "please DEPLOY now" }), true);
  assert.equal(watchRuleMatchMatches("deploy", { text: "DEPLOY" }), true);
  assert.equal(watchRuleMatchMatches("deploy", { text: "nothing relevant" }), false);
});

test("watchRuleMatchMatches: reads nested message.text / record.text", () => {
  assert.equal(watchRuleMatchMatches("@mention", { message: { text: "<@U1> hi" } }), true);
  assert.equal(watchRuleMatchMatches("@mention", { record: { text: "<@U1> hi" } }), true);
});

test("parseWatchRules carries match through (was dropped before)", () => {
  const rules = parseWatchRules([
    { paths: [SLACK_WATCH_PATH], events: ["message.created"], match: "@mention" },
    { paths: [SLACK_WATCH_PATH], events: ["message.created"], match: "  " },
  ]);
  assert.equal(rules.length, 2);
  assert.equal(rules[0]?.match, "@mention");
  // blank/whitespace match is treated as unset (no gate)
  assert.equal(rules[1]?.match, undefined);
});

test("watchRulesMatchEvent: @mention rule fires on mention, not on plain message", () => {
  const rules = parseWatchRules([
    { paths: [SLACK_WATCH_PATH], events: ["message.created"], match: "@mention" },
  ]);
  assert.equal(
    watchRulesMatchEvent(rules, "message.created", [SLACK_MESSAGE_PATH], { text: "<@U1> hello" }),
    true,
  );
  assert.equal(
    watchRulesMatchEvent(rules, "message.created", [SLACK_MESSAGE_PATH], { text: "hello" }),
    false,
  );
});

test("watchRulesMatchEvent: absent match preserves today's behavior exactly", () => {
  const rules = parseWatchRules([
    { paths: [SLACK_WATCH_PATH], events: ["message.created"] },
  ]);
  // No match ⇒ fires regardless of content, same as before this change.
  assert.equal(
    watchRulesMatchEvent(rules, "message.created", [SLACK_MESSAGE_PATH], { text: "plain" }),
    true,
  );
  assert.equal(
    watchRulesMatchEvent(rules, "message.created", [SLACK_MESSAGE_PATH], undefined),
    true,
  );
});

test("watchRulesMatchEvent: substring match is case-insensitive contains", () => {
  const rules = parseWatchRules([
    { paths: [SLACK_WATCH_PATH], events: ["message.created"], match: "urgent" },
  ]);
  assert.equal(
    watchRulesMatchEvent(rules, "message.created", [SLACK_MESSAGE_PATH], { text: "This is URGENT" }),
    true,
  );
  assert.equal(
    watchRulesMatchEvent(rules, "message.created", [SLACK_MESSAGE_PATH], { text: "all good" }),
    false,
  );
});

test("agentMatchesEvent: watch_rules match gates the wake (provisioning gate)", () => {
  const row = {
    id: "slack-chat-agent",
    watch_globs: [SLACK_WATCH_PATH],
    watch_rules: [
      { paths: [SLACK_WATCH_PATH], events: ["message.created"], match: "@mention" },
    ],
    spec: { integrations: { slack: { triggers: [{ on: "message.created" }] } } },
  };
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "slack",
      eventType: "message.created",
      eventPaths: [SLACK_MESSAGE_PATH],
      payload: { text: "<@UBOT> can you help" },
    }),
    true,
  );
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "slack",
      eventType: "message.created",
      eventPaths: [SLACK_MESSAGE_PATH],
      payload: { text: "just chatting in the channel" },
    }),
    false,
  );
});

test("agentMatchesEvent: trigger-spec fallback enforces match and where", () => {
  // No watch_rules ⇒ falls back to watch_globs + provider trigger spec. The
  // raw trigger's match/where must still gate.
  const row = {
    id: "slack-chat-agent-fallback",
    watch_globs: [SLACK_WATCH_PATH],
    watch_rules: null,
    spec: {
      integrations: {
        slack: { triggers: [{ on: "message.created", match: "@mention" }] },
      },
    },
  };
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "slack",
      eventType: "message.created",
      eventPaths: [SLACK_MESSAGE_PATH],
      payload: { text: "<@UBOT> hi" },
    }),
    true,
  );
  assert.equal(
    agentMatchesEvent({
      row,
      provider: "slack",
      eventType: "message.created",
      eventPaths: [SLACK_MESSAGE_PATH],
      payload: { text: "no mention here" },
    }),
    false,
  );

  const whereRow = {
    id: "where-fallback",
    watch_globs: ["/github/repos/acme/cloud/issues/**"],
    watch_rules: null,
    spec: {
      integrations: {
        github: { triggers: [{ on: "issues.labeled", where: "label.name=small" }] },
      },
    },
  };
  assert.equal(
    agentMatchesEvent({
      row: whereRow,
      provider: "github",
      eventType: "issues.labeled",
      eventPaths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { label: { name: "small" } },
    }),
    true,
  );
  assert.equal(
    agentMatchesEvent({
      row: whereRow,
      provider: "github",
      eventType: "issues.labeled",
      eventPaths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      payload: { label: { name: "large" } },
    }),
    false,
  );
});
