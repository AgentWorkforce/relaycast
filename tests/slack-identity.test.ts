import test from "node:test";
import assert from "node:assert/strict";

const {
  extractSlackConnectionIdentityFromForwardPayload,
  mergeSlackConnectionIdentity,
  mergeSlackConnectionIdentityMetadata,
  metadataMatchesSlackTeamId,
} = await import(
  new URL("../packages/web/lib/integrations/slack-identity.ts", import.meta.url).href
);

test("extractSlackConnectionIdentityFromForwardPayload reads canonical Slack identity fields", () => {
  const identity = extractSlackConnectionIdentityFromForwardPayload({
    context_team_id: "T0AD97QUZDJ",
    context_enterprise_id: null,
    authorizations: [
      {
        user_id: "U0AS9TATB8F",
        team_id: "T0AD97QUZDJ",
        enterprise_id: null,
      },
    ],
    event: {
      team: "T0AD97QUZDJ",
    },
  });

  assert.deepEqual(identity, {
    teamId: "T0AD97QUZDJ",
    enterpriseId: null,
    botUserId: "U0AS9TATB8F",
    workspaceName: null,
    workspaceUrl: null,
  });
});

test("mergeSlackConnectionIdentity prefers auth.test values and falls back to webhook payload values", () => {
  const merged = mergeSlackConnectionIdentity(
    {
      teamId: "T0AD97QUZDJ",
      workspaceName: "AgentRelay",
      botUserId: null,
    },
    {
      teamId: "T_STALE",
      botUserId: "U0AS9TATB8F",
      workspaceUrl: "https://agentrelay.slack.com/",
    },
  );

  assert.deepEqual(merged, {
    teamId: "T0AD97QUZDJ",
    enterpriseId: null,
    botUserId: "U0AS9TATB8F",
    workspaceName: "AgentRelay",
    workspaceUrl: "https://agentrelay.slack.com/",
  });
});

test("mergeSlackConnectionIdentityMetadata stores canonical keys and team matching recognizes legacy records", () => {
  const metadata = mergeSlackConnectionIdentityMetadata(
    {
      team: {
        id: "T0LEGACY",
      },
      foo: "bar",
    },
    {
      teamId: "T0AD97QUZDJ",
      botUserId: "U0AS9TATB8F",
    },
  );

  assert.equal(metadata.slackTeamId, "T0AD97QUZDJ");
  assert.equal(metadata.slackBotUserId, "U0AS9TATB8F");
  assert.equal(metadata.foo, "bar");
  assert.equal(metadataMatchesSlackTeamId(metadata, "T0AD97QUZDJ"), true);
  assert.equal(
    metadataMatchesSlackTeamId(
      {
        authorizations: [
          {
            team_id: "T0AD97QUZDJ",
          },
        ],
      },
      "T0AD97QUZDJ",
    ),
    true,
  );
});
