import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleRickySlackForward: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@/lib/ricky/slack/ingress", () => ({
  handleRickySlackForward: mocks.handleRickySlackForward,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    info: mocks.loggerInfo,
  },
}));

describe("normalizeSlackForwardRecord", () => {
  it.each([
    ["channel_archive", { channel: "C123" }, "SlackChannel", "C123", "channel.archive", true, false],
    [
      "channel_created",
      { channel: { id: "C234", name: "new-channel", created: 1711111000 } },
      "SlackChannel",
      "C234",
      "channel.created",
      false,
      false,
    ],
    ["channel_deleted", { channel: "C345" }, "SlackChannel", "C345", "channel.deleted", true, true],
    [
      "channel_rename",
      { channel: { id: "C456", name: "renamed-channel", created: 1711111000 } },
      "SlackChannel",
      "C456",
      "channel.rename",
      false,
      false,
    ],
    ["channel_unarchive", { channel: "C567" }, "SlackChannel", "C567", "channel.unarchive", false, false],
    ["group_archive", { channel: "G123" }, "SlackChannel", "G123", "group.archive", true, false],
    ["group_deleted", { channel: "G234" }, "SlackChannel", "G234", "group.deleted", true, true],
    [
      "group_rename",
      { channel: { id: "G345", name: "renamed-group", created: 1711111000 } },
      "SlackChannel",
      "G345",
      "group.rename",
      false,
      false,
    ],
    ["group_unarchive", { channel: "G456" }, "SlackChannel", "G456", "group.unarchive", false, false],
    [
      "member_joined_channel",
      { channel: "C678", user: "U123" },
      "SlackChannel",
      "C678",
      "member.joined.channel",
      false,
      false,
    ],
    [
      "member_left_channel",
      { channel: "C789", user: "U123" },
      "SlackChannel",
      "C789",
      "member.left.channel",
      false,
      false,
    ],
    [
      "team_join",
      { user: { id: "U234", name: "joined-user" } },
      "SlackUser",
      "U234",
      "team.join",
      false,
      false,
    ],
    [
      "user_change",
      { user: { id: "U345", name: "changed-user" } },
      "SlackUser",
      "U345",
      "user.change",
      false,
      false,
    ],
  ])(
    "normalizes %s forwards",
    async (type, event, model, id, eventType, archived, deleted) => {
      const { normalizeSlackForwardRecord } = await import("./nango-webhook-router");
      const normalized = normalizeSlackForwardRecord({
        event: {
          type,
          event_ts: "1711111000.000100",
          ...event,
        },
      });

      expect(normalized?.model).toBe(model);
      expect(normalized?.record.id).toBe(id);
      expect(normalized?.record._webhook).toMatchObject({ eventType });
      if (model === "SlackChannel") {
        expect(normalized?.record.is_archived).toBe(archived);
        expect(normalized?.record.is_private).toBe(type.startsWith("group_"));
      }
      expect(Boolean(normalized?.record._nango_metadata)).toBe(deleted);
    },
  );

  it("leaves sparse Slack channel lifecycle names unset so the writer can preserve prior names", async () => {
    const { normalizeSlackForwardRecord } = await import("./nango-webhook-router");
    const normalized = normalizeSlackForwardRecord({
      event: {
        type: "channel_archive",
        channel: "C123",
      },
    });

    expect(normalized?.record.id).toBe("C123");
    expect(normalized?.record).not.toHaveProperty("name");
  });

  it("normalizes Slack app_mention forwards as proactive message events", async () => {
    const { normalizeSlackForwardRecord } = await import("./nango-webhook-router");
    const normalized = normalizeSlackForwardRecord({
      event: {
        type: "app_mention",
        channel: "C123",
        ts: "1711111000.000100",
        event_ts: "1711111000.000100",
        text: "<@U0B2596R7EZ> file this",
        user: "U234",
      },
    });

    expect(normalized?.model).toBe("SlackMessage");
    expect(normalized?.record).toMatchObject({
      id: "C123:1711111000.000100",
      channel: "C123",
      ts: "1711111000.000100",
      text: "<@U0B2596R7EZ> file this",
      user: "U234",
      _webhook: { eventType: "app_mention" },
    });
  });

  it("normalizes GitLab terminal issue and merge request forwards for Relayfile writes", async () => {
    const { normalizeGitLabForwardPayload } = await import("./nango-webhook-router");

    expect(
      normalizeGitLabForwardPayload({
        object_kind: "issue",
        project: { id: 10, path_with_namespace: "acme/api" },
        object_attributes: {
          id: 100,
          iid: 7,
          action: "close",
          title: "Fix auth",
          state: "opened",
        },
      }),
    ).toMatchObject({
      model: "GitLabIssue",
      eventType: "issue.close",
      records: [
        {
          id: "100",
          iid: "7",
          project_id: "10",
          project_path: "acme/api",
          state: "closed",
          _webhook: { eventType: "issue.close", action: "close" },
        },
      ],
    });

    expect(
      normalizeGitLabForwardPayload({
        object_kind: "merge_request",
        project: { id: 10, path_with_namespace: "acme/api" },
        object_attributes: {
          id: 200,
          iid: 12,
          action: "merge",
          title: "Ship it",
          state: "opened",
        },
      }),
    ).toMatchObject({
      model: "GitLabMergeRequest",
      eventType: "merge_request.merge",
      records: [
        {
          id: "200",
          iid: "12",
          project_id: "10",
          project_path: "acme/api",
          state: "merged",
          _webhook: { eventType: "merge_request.merge", action: "merge" },
        },
      ],
    });
  });

  it("normalizes GitLab pipeline, deployment, and tag forwards for immediate Relayfile writes", async () => {
    const { normalizeGitLabForwardPayload } = await import("./nango-webhook-router");

    expect(
      normalizeGitLabForwardPayload({
        object_kind: "pipeline",
        project: { id: 10, path_with_namespace: "acme/api" },
        object_attributes: {
          id: 9001,
          ref: "main",
          status: "failed",
          updated_at: "2026-05-15T10:00:00.000Z",
        },
      }),
    ).toMatchObject({
      model: "GitLabPipeline",
      eventType: "pipeline.failed",
      records: [
        {
          id: "9001",
          project_id: "10",
          project_path: "acme/api",
          ref: "main",
          status: "failed",
          updated_at: "2026-05-15T10:00:00.000Z",
          _webhook: { eventType: "pipeline.failed" },
        },
      ],
    });

    expect(
      normalizeGitLabForwardPayload({
        object_kind: "deployment",
        project: { id: 10, path_with_namespace: "acme/api" },
        deployment_id: 501,
        status: "success",
        environment: "production",
        status_changed_at: "2026-05-15T10:05:00.000Z",
      }),
    ).toMatchObject({
      model: "GitLabDeployment",
      eventType: "deployment.success",
      records: [
        {
          id: "501",
          project_id: "10",
          project_path: "acme/api",
          environment: "production",
          status: "success",
          updated_at: "2026-05-15T10:05:00.000Z",
          _webhook: { eventType: "deployment.success" },
        },
      ],
    });

    expect(
      normalizeGitLabForwardPayload({
        object_kind: "build",
        project: { id: 10, path_with_namespace: "acme/api" },
        build_id: 77,
        pipeline_id: 9001,
        build_name: "rspec",
        build_stage: "test",
        build_status: "failed",
        ref: "main",
        build_finished_at: "2026-05-15T10:07:00.000Z",
      }),
    ).toMatchObject({
      model: "GitLabPipelineJob",
      eventType: "build.failed",
      records: [
        {
          id: "77",
          pipeline_id: "9001",
          project_id: "10",
          project_path: "acme/api",
          name: "rspec",
          stage: "test",
          status: "failed",
          ref: "main",
          updated_at: "2026-05-15T10:07:00.000Z",
          _webhook: { eventType: "build.failed" },
        },
      ],
      triggerSyncs: ["fetch-pipelines"],
    });

    expect(
      normalizeGitLabForwardPayload({
        object_kind: "tag_push",
        project: { id: 10, path_with_namespace: "acme/api" },
        ref: "refs/tags/release/foo__bar",
        after: "0123456789012345678901234567890123456789",
        checkout_sha: "0123456789012345678901234567890123456789",
      }),
    ).toMatchObject({
      model: "GitLabTag",
      eventType: "tag_push.update",
      records: [
        {
          id: "10:release/foo__bar",
          project_id: "10",
          project_path: "acme/api",
          ref: "release/foo__bar",
          name: "release/foo__bar",
          target: "0123456789012345678901234567890123456789",
          _webhook: { eventType: "tag_push.update" },
        },
      ],
    });
  });

  it("normalizes Confluence restore forwards instead of dropping them", async () => {
    const { normalizeConfluenceForwardPayload } = await import("./nango-webhook-router");

    expect(
      normalizeConfluenceForwardPayload({
        event: "page_restored",
        page: {
          id: "page-123",
          title: "Release Plan",
        },
      }),
    ).toMatchObject({
      model: "ConfluencePage",
      id: "page-123",
      isDelete: false,
      event: "page_restored",
      record: {
        id: "page-123",
        title: "Release Plan",
        status: "current",
      },
    });
  });
});
