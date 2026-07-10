import { describe, expect, it } from "vitest";

import { agentMatchesEvent } from "@cloud/core/proactive-runtime/match.js";
import {
  copyTriggerMaxConcurrencyFromRawAgent,
  deriveDeliveryMaxConcurrency,
  deriveDeliveryMaxConcurrencyByTrigger,
  integrationTriggerKey,
  readDeploymentWatchRules,
  translatePersonaTriggersToWatchRules,
} from "./persona-deploy";

/**
 * Dispatch-level trigger `where` → WatchRuleCondition translation.
 *
 * Why server-side: persona-kit's parseIntegrationTrigger preserves ONLY
 * {on, match, where} (a `conditions` key on a trigger is stripped
 * client-side), and parseWatch strips `conditions` from watch rules — so
 * `where` strings are the one persona-kit-safe channel, and until this
 * translation existed nothing evaluated them. The load-bearing invariant:
 * when ANY trigger carries `where`, the derived rule set must be COMPLETE
 * (cover every trigger) because agentMatchesEvent prefers watch_rules over
 * watch_globs exclusively — a partial set silently kills the persona's
 * other wakeups.
 */

const PERSONA = {
  integrations: { github: {}, slack: {} },
} as never;

const AGENT_WITH_WHERE = {
  triggers: {
    github: [
      { on: "issues.opened", paths: ["/github/repos/AgentWorkforce/cloud/issues/**"] },
      {
        on: "issues.labeled",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        where: "label.name=small",
      },
    ],
    slack: [
      { on: "message", paths: ["/slack/channels/proj-cloud/messages/**"] },
    ],
  },
} as never;

const AGENT_WITHOUT_WHERE = {
  triggers: {
    github: [
      { on: "issues.opened", paths: ["/github/repos/AgentWorkforce/cloud/issues/**"] },
      { on: "issues.labeled", paths: ["/github/repos/AgentWorkforce/cloud/issues/**"] },
    ],
  },
} as never;

describe("translatePersonaTriggersToWatchRules", () => {
  it("returns null when no trigger carries a where clause (zero-delta guarantee)", () => {
    expect(translatePersonaTriggersToWatchRules(PERSONA, AGENT_WITHOUT_WHERE)).toBeNull();
    expect(readDeploymentWatchRules(PERSONA, AGENT_WITHOUT_WHERE)).toBeNull();
  });

  it("derives a COMPLETE rule set covering every trigger when any carries where", () => {
    const rules = translatePersonaTriggersToWatchRules(PERSONA, AGENT_WITH_WHERE);
    expect(rules).not.toBeNull();
    // All three triggers represented — github opened, github labeled, slack message.
    expect(rules).toHaveLength(3);
    const labeled = rules!.find((rule) => rule.events.includes("issues.labeled"));
    expect(labeled).toMatchObject({
      paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
      events: ["issues.labeled"],
      conditions: [{ field: "label.name", equals: "small" }],
      triggerKey: integrationTriggerKey("github", 1),
    });
    const opened = rules!.find((rule) => rule.events.includes("issues.opened"));
    expect(opened?.conditions).toBeUndefined();
    expect(opened?.triggerKey).toBe(integrationTriggerKey("github", 0));
    const slack = rules!.find((rule) => rule.events.includes("message"));
    expect(slack).toMatchObject({
      paths: ["/slack/channels/proj-cloud/messages/**"],
      triggerKey: integrationTriggerKey("slack", 0),
    });
    // The forward path enqueues concrete subtypes (message.created), while
    // watch-rule event matching is EXACT — the translator must expand `on`
    // through the adapter catalog or the slack wakeup dies on redeploy
    // (codex-7's #1884 review finding).
    expect(slack!.events).toContain("message");
    expect(slack!.events).toContain("message.created");
  });

  it("ANDs comma-separated where pairs", () => {
    const rules = translatePersonaTriggersToWatchRules(PERSONA, {
      triggers: {
        github: [
          {
            on: "check_run.completed",
            paths: ["/github/repos/AgentWorkforce/cloud/**"],
            where: "check_run.conclusion=failure,check_run.name=Unit Tests",
          },
        ],
      },
    } as never);
    expect(rules![0]!.conditions).toEqual([
      { field: "check_run.conclusion", equals: "failure" },
      { field: "check_run.name", equals: "Unit Tests" },
    ]);
  });

  it("derives Linear issue watch rules with label and state conditions", () => {
    const rules = translatePersonaTriggersToWatchRules({
      integrations: { linear: {} },
    } as never, {
      triggers: {
        linear: [
          {
            on: "issue.update",
            where: "labels.nodes.name=factory,state.name=Ready for Agent",
          },
        ],
      },
    } as never);

    expect(rules).toHaveLength(1);
    expect(rules![0]).toMatchObject({
      paths: ["/linear/issues/**"],
      conditions: [
        { field: "labels.nodes.name", equals: "factory" },
        { field: "state.name", equals: "Ready for Agent" },
      ],
      triggerKey: integrationTriggerKey("linear", 0),
    });
    expect(rules![0]!.events).toContain("issue.update");
  });

  it("rejects malformed where clauses with a structured deploy error", () => {
    expect(() =>
      translatePersonaTriggersToWatchRules(PERSONA, {
        triggers: {
          github: [
            { on: "issues.labeled", paths: ["/github/repos/a/b/issues/**"], where: "label.name" },
          ],
        },
      } as never),
    ).toThrowError(/invalid trigger where clause/);
  });

  it("appends explicit agent.watch rules after the trigger-derived set", () => {
    const explicitRule = { paths: ["/granola/notes/**"], events: ["file.created"] };
    const rules = readDeploymentWatchRules(PERSONA, {
      ...(AGENT_WITH_WHERE as Record<string, unknown>),
      watch: [explicitRule],
    } as never);
    expect(rules).toHaveLength(4);
    expect(rules![3]).toEqual(explicitRule);
  });

  it("derives complete trigger-keyed rules when any trigger has maxConcurrency", () => {
    const rules = translatePersonaTriggersToWatchRules(PERSONA, {
      triggers: {
        github: [
          { on: "issues.opened", paths: ["/github/repos/AgentWorkforce/cloud/issues/**"] },
          { on: "issues.labeled", paths: ["/github/repos/AgentWorkforce/cloud/issues/**"], maxConcurrency: 1 },
        ],
        slack: [
          { on: "message", paths: ["/slack/channels/proj-cloud/messages/**"] },
        ],
      },
    } as never);

    expect(rules).toHaveLength(3);
    expect(rules?.map((rule) => rule.triggerKey)).toEqual([
      integrationTriggerKey("github", 0),
      integrationTriggerKey("github", 1),
      integrationTriggerKey("slack", 0),
    ]);
    expect(readDeploymentWatchRules(PERSONA, {
      triggers: {
        github: [{ on: "issues.labeled", maxConcurrency: 1 }],
      },
    } as never)).not.toBeNull();
  });

  it("can restore raw maxConcurrency stripped by the installed persona-kit parser before rule derivation", () => {
    const parsedAgent = {
      triggers: {
        github: [
          { on: "issues.opened", paths: ["/github/repos/AgentWorkforce/cloud/issues/**"] },
        ],
      },
    };
    copyTriggerMaxConcurrencyFromRawAgent(parsedAgent as never, {
      triggers: {
        github: [
          { on: "issues.opened", paths: ["/github/repos/AgentWorkforce/cloud/issues/**"], maxConcurrency: 1 },
        ],
      },
    });

    expect(translatePersonaTriggersToWatchRules(PERSONA, parsedAgent as never)?.[0]).toMatchObject({
      triggerKey: integrationTriggerKey("github", 0),
    });
  });
});

// Trigger `match` is the content-filter sibling of `where`. Like `where` it was
// validated by persona-kit then dropped before reaching dispatch, so a Slack
// chat agent declaring `match: "@mention"` woke + provisioned a Daytona box on
// EVERY channel message. These pin the deploy-side propagation + dispatch gate.
describe("translatePersonaTriggersToWatchRules — match propagation", () => {
  const SLACK_ONLY = { integrations: { slack: {} } } as never;

  it("returns null when no trigger carries match (zero-delta)", () => {
    const agent = {
      triggers: {
        slack: [{ on: "message.created", paths: ["/slack/channels/C1/messages/**"] }],
      },
    } as never;
    expect(translatePersonaTriggersToWatchRules(SLACK_ONLY, agent)).toBeNull();
  });

  it("carries match onto the derived watch rule when a trigger declares it", () => {
    const agent = {
      triggers: {
        slack: [
          { on: "message.created", paths: ["/slack/channels/C1/messages/**"], match: "@mention" },
        ],
      },
    } as never;
    const rules = translatePersonaTriggersToWatchRules(SLACK_ONLY, agent);
    expect(rules).not.toBeNull();
    expect(rules![0]).toMatchObject({
      paths: ["/slack/channels/C1/messages/**"],
      match: "@mention",
      triggerKey: integrationTriggerKey("slack", 0),
    });
  });

  it("@mention gates dispatch: fires on a mention, NOT on a plain message", () => {
    const agent = {
      triggers: {
        slack: [
          { on: "message.created", paths: ["/slack/channels/C1/messages/**"], match: "@mention" },
        ],
      },
    } as never;
    const row = {
      id: "slack-chat-bot",
      watch_globs: ["/slack/channels/C1/messages/**"],
      watch_rules: translatePersonaTriggersToWatchRules(SLACK_ONLY, agent)!,
    } as never;
    const eventPaths = ["/slack/channels/C1/messages/1717500000_1.json"];

    expect(
      agentMatchesEvent({
        row,
        provider: "slack",
        eventType: "message.created",
        eventPaths,
        payload: { channel: "C1", text: "<@UBOT> can you summarize this thread?" },
      }),
    ).toBe(true);

    expect(
      agentMatchesEvent({
        row,
        provider: "slack",
        eventType: "message.created",
        eventPaths,
        payload: { channel: "C1", text: "just chatting, no mention here" },
      }),
    ).toBe(false);
  });
});

describe("deriveDeliveryMaxConcurrency", () => {
  it("uses the most conservative positive integer declared across raw triggers", () => {
    expect(
      deriveDeliveryMaxConcurrency({
        triggers: {
          slack: [{ on: "message.created", maxConcurrency: 1 }],
          github: [{ on: "issues.opened", maxConcurrency: 4 }],
        },
      }),
    ).toBe(1);
  });

  it("treats invalid or absent maxConcurrency values as unset", () => {
    expect(
      deriveDeliveryMaxConcurrency({
        triggers: {
          slack: [
            { on: "message.created", maxConcurrency: 0 },
            { on: "message.changed", maxConcurrency: 1.5 },
            { on: "message.deleted", maxConcurrency: Number.NaN },
          ],
        },
      }),
    ).toBeNull();
    expect(deriveDeliveryMaxConcurrency({ triggers: { slack: [{ on: "message.created" }] } })).toBeNull();
    expect(deriveDeliveryMaxConcurrency(null)).toBeNull();
  });
});

describe("deriveDeliveryMaxConcurrencyByTrigger", () => {
  it("maps positive integer caps by stable provider/index trigger key", () => {
    expect(
      deriveDeliveryMaxConcurrencyByTrigger({
        triggers: {
          slack: [{ on: "message.created", maxConcurrency: 1 }],
          github: [
            { on: "issues.opened" },
            { on: "issues.labeled", maxConcurrency: 4 },
          ],
        },
      }),
    ).toEqual({
      [integrationTriggerKey("slack", 0)]: 1,
      [integrationTriggerKey("github", 1)]: 4,
    });
  });

  it("treats invalid or absent per-trigger caps as unset", () => {
    expect(
      deriveDeliveryMaxConcurrencyByTrigger({
        triggers: {
          slack: [
            { on: "message.created", maxConcurrency: 0 },
            { on: "message.changed", maxConcurrency: 1.5 },
            { on: "message.deleted", maxConcurrency: Number.NaN },
          ],
        },
      }),
    ).toBeNull();
    expect(deriveDeliveryMaxConcurrencyByTrigger({ triggers: { slack: [{ on: "message.created" }] } })).toBeNull();
    expect(deriveDeliveryMaxConcurrencyByTrigger(null)).toBeNull();
  });
});

describe("dispatch matching with derived rules", () => {
  const rules = translatePersonaTriggersToWatchRules(PERSONA, AGENT_WITH_WHERE)!;
  const row = {
    id: "agent-1",
    watch_globs: ["/github/repos/AgentWorkforce/cloud/issues/**"],
    watch_rules: rules,
  } as never;
  const issuePaths = ["/github/repos/AgentWorkforce/cloud/issues/123__t/meta.json"];

  it("does NOT wake the persona for a non-matching label (the wasted-provision case)", () => {
    expect(
      agentMatchesEvent({
        row,
        provider: "github",
        eventType: "issues.labeled",
        eventPaths: issuePaths,
        payload: { label: { name: "docs" }, issue: { number: 123 } },
      }),
    ).toBe(false);
  });

  it("wakes the persona for the matching label", () => {
    expect(
      agentMatchesEvent({
        row,
        provider: "github",
        eventType: "issues.labeled",
        eventPaths: issuePaths,
        payload: { label: { name: "small" }, issue: { number: 123 } },
      }),
    ).toBe(true);
  });

  it("keeps the issues.opened wakeup alive (complete-set invariant)", () => {
    expect(
      agentMatchesEvent({
        row,
        provider: "github",
        eventType: "issues.opened",
        eventPaths: issuePaths,
        payload: { issue: { number: 123 } },
      }),
    ).toBe(true);
  });

  it("keeps the slack wakeup alive for the PRODUCTION event shape (complete-set invariant)", () => {
    // The slack forward path enqueues `message.created` — not the trigger's
    // literal `message`. This is the exact case the first cut missed.
    expect(
      agentMatchesEvent({
        row,
        provider: "slack",
        eventType: "message.created",
        eventPaths: ["/slack/channels/proj-cloud/messages/1717500000_1.json"],
        payload: { channel: "proj-cloud", text: "hi" },
      }),
    ).toBe(true);
  });

  it("also matches the literal trigger event shape", () => {
    expect(
      agentMatchesEvent({
        row,
        provider: "slack",
        eventType: "message",
        eventPaths: ["/slack/channels/proj-cloud/messages/1717500000_1.json"],
        payload: { channel: "proj-cloud", text: "hi" },
      }),
    ).toBe(true);
  });
});
