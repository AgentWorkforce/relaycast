import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  RickyGateActionPayload,
  RickySlackActor,
  RickySlackEgressInput,
  RickySlackInstallation,
  RickySlackUserLink,
  RickySlackWorkspaceMembership,
} from "../../packages/web/lib/ricky/slack-agent-v2.ts";

const importedSlackModule = (await import(
  new URL("../../packages/web/lib/ricky/slack-agent-v2.ts", import.meta.url).href
)) as unknown as
  | typeof import("../../packages/web/lib/ricky/slack-agent-v2.ts")
  | { default: typeof import("../../packages/web/lib/ricky/slack-agent-v2.ts") };
const slackModule =
  "default" in importedSlackModule ? importedSlackModule.default : importedSlackModule;
const {
  InMemoryRickySlackDedupStore,
  authorizeRickySlackAction,
  createRickySlackEgress,
  handleRickySlackCommand,
  handleRickySlackEvent,
  handleRickySlackInteractivity,
  mapBlockKitGateActionToResolution,
  parseRickySlashCommand,
  postTerminalRunTransition,
  resolveRickySlackActor,
  signSlackRequest,
  verifySlackRequestSignature,
} = slackModule;

const ORG_ID = "org-1";
const WORKSPACE_ID = "workspace-1";
const TEAM_ID = "T01234567";
const SLACK_USER_ID = "U01234567";
const CLOUD_USER_ID = "user-1";

const activeInstallation: RickySlackInstallation = {
  id: "install-1",
  organizationId: ORG_ID,
  workspaceId: WORKSPACE_ID,
  slackTeamId: TEAM_ID,
  status: "active",
  connectionId: "conn-slack",
};

const activeLink: RickySlackUserLink = {
  id: "link-1",
  organizationId: ORG_ID,
  workspaceId: WORKSPACE_ID,
  cloudUserId: CLOUD_USER_ID,
  slackTeamId: TEAM_ID,
  slackUserId: SLACK_USER_ID,
  status: "active",
};

const activeMembership: RickySlackWorkspaceMembership = {
  organizationId: ORG_ID,
  workspaceId: WORKSPACE_ID,
  cloudUserId: CLOUD_USER_ID,
  role: "member",
  status: "active",
};

const actor: RickySlackActor = {
  organizationId: ORG_ID,
  workspaceId: WORKSPACE_ID,
  cloudUserId: CLOUD_USER_ID,
  slackTeamId: TEAM_ID,
  slackUserId: SLACK_USER_ID,
  role: "member",
  isWorkspaceAdmin: false,
};

function gatePayload(overrides: Partial<RickyGateActionPayload> = {}): RickyGateActionPayload {
  return {
    action: "approve",
    rickyRunId: "ricky-1",
    gateId: "gate-1",
    workspaceId: WORKSPACE_ID,
    slackTeamId: TEAM_ID,
    slackUserId: SLACK_USER_ID,
    channelId: "C01234567",
    messageTs: "1710000000.000100",
    ...overrides,
  };
}

function resolvedActor() {
  return {
    ok: true as const,
    actor,
    installation: activeInstallation,
  };
}

describe("Ricky Slack request signature verification", () => {
  it("rejects stale and invalid Slack signatures while accepting the deterministic expected signature", () => {
    const signingSecret = "slack-signing-secret";
    const timestamp = 1_714_000_000;
    const body = "team_id=T01234567&user_id=U01234567&text=run%20workflows/demo.ts";
    const signature = signSlackRequest({ signingSecret, timestamp, body });

    assert.deepEqual(
      verifySlackRequestSignature({
        signingSecret,
        timestamp,
        signature,
        body,
        nowSeconds: timestamp + 60,
      }),
      { ok: true },
    );
    assert.deepEqual(
      verifySlackRequestSignature({
        signingSecret,
        timestamp,
        signature,
        body,
        nowSeconds: timestamp + 301,
      }),
      { ok: false, reason: "stale" },
    );
    assert.deepEqual(
      verifySlackRequestSignature({
        signingSecret,
        timestamp,
        signature: "v0=bad",
        body,
        nowSeconds: timestamp,
      }),
      { ok: false, reason: "invalid" },
    );
    assert.deepEqual(
      verifySlackRequestSignature({
        signingSecret,
        timestamp: null,
        signature,
        body,
        nowSeconds: timestamp,
      }),
      { ok: false, reason: "missing" },
    );
    assert.deepEqual(
      verifySlackRequestSignature({
        signingSecret,
        timestamp,
        signature: null,
        body,
        nowSeconds: timestamp,
      }),
      { ok: false, reason: "missing" },
    );
    assert.deepEqual(
      verifySlackRequestSignature({
        signingSecret,
        timestamp: "not-a-timestamp",
        signature,
        body,
        nowSeconds: timestamp,
      }),
      { ok: false, reason: "invalid" },
    );
  });
});

describe("Ricky Slack deduplication", () => {
  it("prevents duplicate slash commands from creating duplicate Ricky runs", async () => {
    const dedup = new InMemoryRickySlackDedupStore();
    const launchCalls: string[] = [];
    const baseInput = {
      text: "run workflows/deploy-staging.ts",
      slackTeamId: TEAM_ID,
      slackUserId: SLACK_USER_ID,
      channelId: "C01234567",
      triggerId: "trigger-1",
      dedup,
      resolveActor: resolvedActor,
      launchRun: async (_actor: RickySlackActor, workflowRef: string) => {
        launchCalls.push(workflowRef);
        return { rickyRunId: "ricky-1" };
      },
      postEphemeral: async () => ({ ok: true }),
    };

    assert.deepEqual(await handleRickySlackCommand(baseInput), {
      type: "run_started",
      rickyRunId: "ricky-1",
    });
    assert.deepEqual(await handleRickySlackCommand(baseInput), { type: "deduped" });
    assert.deepEqual(launchCalls, ["workflows/deploy-staging.ts"]);
  });

  it("prevents duplicate app mention events from creating duplicate Ricky runs", async () => {
    const dedup = new InMemoryRickySlackDedupStore();
    let launchCount = 0;
    const baseInput = {
      eventId: "Ev01234567",
      slackTeamId: TEAM_ID,
      slackUserId: SLACK_USER_ID,
      text: "<@URICKY> run workflows/fix-tests.ts",
      dedup,
      resolveActor: resolvedActor,
      launchRun: async () => {
        launchCount += 1;
        return { rickyRunId: "ricky-event" };
      },
    };

    assert.deepEqual(await handleRickySlackEvent(baseInput), {
      type: "run_started",
      rickyRunId: "ricky-event",
    });
    assert.deepEqual(await handleRickySlackEvent(baseInput), { type: "deduped" });
    assert.equal(launchCount, 1);
  });
});

describe("Ricky Slack team and user resolution", () => {
  it("enforces Cloud workspace membership for linked Slack users", () => {
    const resolved = resolveRickySlackActor({
      slackTeamId: TEAM_ID,
      slackUserId: SLACK_USER_ID,
      installations: [activeInstallation],
      userLinks: [activeLink],
      memberships: [activeMembership],
    });

    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.actor.cloudUserId, CLOUD_USER_ID);
      assert.equal(resolved.actor.workspaceId, WORKSPACE_ID);
    }

    assert.deepEqual(
      resolveRickySlackActor({
        slackTeamId: TEAM_ID,
        slackUserId: SLACK_USER_ID,
        installations: [activeInstallation],
        userLinks: [activeLink],
        memberships: [],
      }),
      {
        ok: false,
        reason: "missing_membership",
        workspaceId: WORKSPACE_ID,
        organizationId: ORG_ID,
      },
    );
    assert.deepEqual(
      resolveRickySlackActor({
        slackTeamId: TEAM_ID,
        slackUserId: SLACK_USER_ID,
        installations: [activeInstallation],
        userLinks: [activeLink],
        memberships: [
          {
            ...activeMembership,
            workspaceId: "other-workspace",
          },
          {
            ...activeMembership,
            status: "inactive",
          },
        ],
      }),
      {
        ok: false,
        reason: "missing_membership",
        workspaceId: WORKSPACE_ID,
        organizationId: ORG_ID,
      },
    );
    assert.deepEqual(
      resolveRickySlackActor({
        slackTeamId: TEAM_ID,
        slackUserId: SLACK_USER_ID,
        installations: [{ ...activeInstallation, status: "revoked" }],
        userLinks: [activeLink],
        memberships: [activeMembership],
      }),
      {
        ok: false,
        reason: "installation_revoked",
        workspaceId: WORKSPACE_ID,
        organizationId: ORG_ID,
      },
    );
    assert.deepEqual(
      resolveRickySlackActor({
        slackTeamId: TEAM_ID,
        slackUserId: SLACK_USER_ID,
        installations: [activeInstallation],
        userLinks: [{ ...activeLink, status: "revoked" }],
        memberships: [activeMembership],
      }),
      {
        ok: false,
        reason: "link_revoked",
        workspaceId: WORKSPACE_ID,
        organizationId: ORG_ID,
      },
    );
  });
});

describe("Ricky slash command parsing", () => {
  it("parses run, status, approve, deny, and connect commands deterministically", () => {
    assert.deepEqual(parseRickySlashCommand("run workflows/deploy.ts"), {
      type: "run",
      workflowRef: "workflows/deploy.ts",
    });
    assert.deepEqual(parseRickySlashCommand("/ricky status ricky-123"), {
      type: "status",
      rickyRunId: "ricky-123",
    });
    assert.deepEqual(parseRickySlashCommand("status"), { type: "status" });
    assert.deepEqual(parseRickySlashCommand("approve gate-123"), {
      type: "approve",
      gateId: "gate-123",
    });
    assert.deepEqual(parseRickySlashCommand("deny gate-123"), {
      type: "deny",
      gateId: "gate-123",
    });
    assert.deepEqual(parseRickySlashCommand("connect"), { type: "connect" });
  });
});

describe("Ricky Slack gate policy", () => {
  it("blocks unauthorized gate approval, deny, and edit actions", () => {
    const gate = {
      id: "gate-1",
      rickyRunId: "ricky-1",
      workspaceId: WORKSPACE_ID,
      status: "open" as const,
      eligibleApproverCloudUserIds: ["user-approver"],
    };

    for (const action of ["approve_gate", "deny_gate", "edit_gate"] as const) {
      assert.deepEqual(authorizeRickySlackAction({ action, actor, gate }), {
        allowed: false,
        reason: "not_gate_approver",
      });
    }

    assert.deepEqual(
      authorizeRickySlackAction({
        action: "approve_gate",
        actor: { ...actor, cloudUserId: "user-approver" },
        gate,
      }),
      { allowed: true },
    );
    assert.deepEqual(
      authorizeRickySlackAction({
        action: "deny_gate",
        actor: { ...actor, role: "admin", isWorkspaceAdmin: true },
        gate,
      }),
      { allowed: true },
    );
    assert.deepEqual(
      authorizeRickySlackAction({
        action: "edit_gate",
        actor,
        gate,
        runOwnerCloudUserId: CLOUD_USER_ID,
      }),
      { allowed: true },
    );
  });

  it("does not resolve or resume gate actions that fail Slack policy", async () => {
    for (const action of ["approve", "deny", "edit"] as const) {
      const resolvedGates: unknown[] = [];
      const resumedRuns: unknown[] = [];
      const result = await handleRickySlackInteractivity({
        body: {
          actions: [
            {
              value: JSON.stringify(
                gatePayload({
                  action,
                  ...(action === "edit" ? { instruction: "Try a narrower repair." } : {}),
                }),
              ),
            },
          ],
        },
        gate: {
          id: "gate-1",
          rickyRunId: "ricky-1",
          workspaceId: WORKSPACE_ID,
          status: "open",
          eligibleApproverCloudUserIds: ["user-approver"],
        },
        resolveActor: () => resolvedActor(),
        resolveGate: async (input) => {
          resolvedGates.push(input);
        },
        resumeSupervisor: async (input) => {
          resumedRuns.push(input);
        },
      });

      assert.deepEqual(result, { type: "unauthorized", reason: "not_gate_approver" });
      assert.deepEqual(resolvedGates, []);
      assert.deepEqual(resumedRuns, []);
    }
  });
});

describe("Ricky Slack Block Kit gate payloads", () => {
  it("maps approve, deny, and edit button payloads to v1 gate resolutions", () => {
    const approve = mapBlockKitGateActionToResolution({
      actions: [{ value: JSON.stringify(gatePayload({ action: "approve" })) }],
    });
    assert.deepEqual(approve, {
      rickyRunId: "ricky-1",
      gateId: "gate-1",
      workspaceId: WORKSPACE_ID,
      resolution: { decision: "approve" },
      audit: {
        slackTeamId: TEAM_ID,
        slackUserId: SLACK_USER_ID,
        channelId: "C01234567",
        messageTs: "1710000000.000100",
      },
    });

    const deny = mapBlockKitGateActionToResolution({
      actions: [{ value: JSON.stringify(gatePayload({ action: "deny" })) }],
    });
    assert.equal(deny?.resolution.decision, "deny");

    const edit = mapBlockKitGateActionToResolution({
      actions: [
        {
          value: JSON.stringify(
            gatePayload({
              action: "edit",
              instruction: "Retry after rotating the staging token.",
            }),
          ),
        },
      ],
    });
    assert.deepEqual(edit?.resolution, {
      decision: "edit",
      instruction: "Retry after rotating the staging token.",
    });
  });
});

describe("Ricky Slack missing Cloud user link behavior", () => {
  it("returns an ephemeral connect prompt instead of creating a run", async () => {
    const ephemeralMessages: RickySlackEgressInput[] = [];
    let launchCount = 0;
    const result = await handleRickySlackCommand({
      text: "run workflows/demo.ts",
      slackTeamId: TEAM_ID,
      slackUserId: SLACK_USER_ID,
      channelId: "C01234567",
      triggerId: "trigger-missing-link",
      dedup: new InMemoryRickySlackDedupStore(),
      resolveActor: () => ({
        ok: false,
        reason: "missing_link",
        workspaceId: WORKSPACE_ID,
        organizationId: ORG_ID,
      }),
      launchRun: async () => {
        launchCount += 1;
        return { rickyRunId: "should-not-run" };
      },
      postEphemeral: async (message) => {
        ephemeralMessages.push(message);
        return { ok: true, ts: "1710000000.000200" };
      },
    });

    assert.equal(result.type, "connect_prompt");
    assert.equal(launchCount, 0);
    assert.equal(ephemeralMessages.length, 1);
    assert.equal(ephemeralMessages[0]?.channel, "C01234567");
    assert.equal(ephemeralMessages[0]?.user, SLACK_USER_ID);
    assert.match(ephemeralMessages[0]?.text ?? "", /\/ricky connect/);
  });
});

describe("Ricky Slack egress", () => {
  it("blocks Slack egress for a revoked installation", async () => {
    const sentMessages: RickySlackEgressInput[] = [];
    const egress = createRickySlackEgress({
      installations: [{ ...activeInstallation, status: "revoked" }],
      sink: async (message) => {
        sentMessages.push(message);
        return { ok: true, ts: "1710000000.000300" };
      },
    });

    const result = await egress.postMessage({
      workspaceId: WORKSPACE_ID,
      channel: "C01234567",
      text: "should not send",
    });

    assert.deepEqual(result, { ok: false, error: "installation_revoked" });
    assert.deepEqual(sentMessages, []);
  });
});

describe("Ricky Slack terminal run notifications", () => {
  it("posts success, failure, and exhaustion transitions in the correct Slack thread", async () => {
    const sentMessages: RickySlackEgressInput[] = [];
    const egress = {
      postMessage: async (message: RickySlackEgressInput) => {
        sentMessages.push(message);
        return { ok: true, ts: `1710000000.000${sentMessages.length}` };
      },
    };
    const threadFor = (rickyRunId: string, threadTs: string) => ({
      rickyRunId,
      workspaceId: WORKSPACE_ID,
      slackTeamId: TEAM_ID,
      channelId: "C01234567",
      threadTs,
      status: "active" as const,
    });

    await postTerminalRunTransition({
      rickyRunId: "ricky-1",
      status: "succeeded",
      thread: threadFor("ricky-1", "1710000000.000001"),
      egress,
    });
    await postTerminalRunTransition({
      rickyRunId: "ricky-2",
      status: "failed",
      thread: threadFor("ricky-2", "1710000000.000002"),
      egress,
    });
    await postTerminalRunTransition({
      rickyRunId: "ricky-3",
      status: "exhausted",
      thread: threadFor("ricky-3", "1710000000.000003"),
      egress,
    });
    await postTerminalRunTransition({
      rickyRunId: "ricky-4",
      status: "monitoring",
      thread: threadFor("ricky-4", "1710000000.000004"),
      egress,
    });

    assert.deepEqual(
      sentMessages.map((message) => ({
        channel: message.channel,
        threadTs: message.threadTs,
        text: message.text,
      })),
      [
        {
          channel: "C01234567",
          threadTs: "1710000000.000001",
          text: "Ricky run ricky-1 succeeded.",
        },
        {
          channel: "C01234567",
          threadTs: "1710000000.000002",
          text: "Ricky run ricky-2 failed.",
        },
        {
          channel: "C01234567",
          threadTs: "1710000000.000003",
          text: "Ricky run ricky-3 exhausted repair attempts.",
        },
      ],
    );
  });
});

describe("Ricky Slack gate approval", () => {
  it("resolves an approved Slack gate and resumes the v1 supervisor flow", async () => {
    const payload = gatePayload({ action: "approve" });
    const resolvedGates: unknown[] = [];
    const resumedRuns: unknown[] = [];

    const result = await handleRickySlackInteractivity({
      body: {
        actions: [{ value: JSON.stringify(payload) }],
      },
      gate: {
        id: "gate-1",
        rickyRunId: "ricky-1",
        workspaceId: WORKSPACE_ID,
        status: "open",
        eligibleApproverCloudUserIds: [CLOUD_USER_ID],
      },
      resolveActor: () => resolvedActor(),
      resolveGate: async (input) => {
        resolvedGates.push(input);
      },
      resumeSupervisor: async (input) => {
        resumedRuns.push(input);
      },
    });

    assert.deepEqual(result, { type: "resolved", resolution: { decision: "approve" } });
    assert.deepEqual(resolvedGates, [
      {
        rickyRunId: "ricky-1",
        gateId: "gate-1",
        cloudUserId: CLOUD_USER_ID,
        resolution: { decision: "approve" },
      },
    ]);
    assert.equal(resumedRuns.length, 1);
    assert.deepEqual(resumedRuns[0], {
      rickyRunId: "ricky-1",
      gateId: "gate-1",
      actor,
      resolution: { decision: "approve" },
    });
  });
});
