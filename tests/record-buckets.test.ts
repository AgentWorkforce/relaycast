import { describe, expect, it } from "vitest";

import { bucketByModel } from "../packages/core/src/sync/record-writer.js";
import type { RecordBucketMap } from "../packages/core/src/sync/record-buckets.js";

type GitHubBuckets = RecordBucketMap & {
  issues?: unknown[];
  pullRequests?: unknown[];
};

type SlackBuckets = RecordBucketMap & {
  messages?: unknown[];
  threads?: unknown[];
  threadReplies?: unknown[];
};

const DELETE_META = {
  _nango_metadata: {
    last_action: "deleted",
    deleted_at: "2026-05-12T00:00:00Z",
  },
};

describe("bucketByModel — confluence", () => {
  it("routes ConfluencePage records to the pages bucket", () => {
    const result = bucketByModel(
      [{ id: "p1", title: "P1" }, { id: "p2", title: "P2" }],
      "ConfluencePage",
      "confluence",
    );
    expect(result.provider).toBe("confluence");
    expect(result.buckets).toEqual({
      pages: [
        { id: "p1", title: "P1" },
        { id: "p2", title: "P2" },
      ],
    });
  });

  it("routes ConfluenceSpace records to the spaces bucket", () => {
    const result = bucketByModel(
      [{ id: "s1", key: "ENG" }],
      "ConfluenceSpace",
      "confluence",
    );
    expect(result.buckets).toEqual({ spaces: [{ id: "s1", key: "ENG" }] });
  });

  it("rewrites deleted confluence records to { id, _deleted: true }", () => {
    const result = bucketByModel(
      [{ id: "p1", title: "P1", ...DELETE_META }],
      "ConfluencePage",
      "confluence",
    );
    expect(result.buckets).toEqual({ pages: [{ id: "p1", _deleted: true }] });
  });
});

describe("bucketByModel — linear", () => {
  it("routes each Linear model to the correct bucket", () => {
    const cases: Array<[string, keyof typeof bucketSlots]> = [
      ["Issue", "issues"],
      ["Comment", "comments"],
      ["User", "users"],
      ["Team", "teams"],
      ["Project", "projects"],
      ["Cycle", "cycles"],
      ["Milestone", "milestones"],
      ["Roadmap", "roadmaps"],
    ];
    const bucketSlots = {
      issues: 1, comments: 1, users: 1, teams: 1, projects: 1,
      cycles: 1, milestones: 1, roadmaps: 1,
    };
    for (const [model, slot] of cases) {
      const result = bucketByModel([{ id: "x1" }], model, "linear");
      expect(result.provider).toBe("linear");
      expect(Object.keys(result.buckets)).toEqual([slot]);
    }
  });

  it("rewrites deleted linear records to tombstones", () => {
    const result = bucketByModel(
      [{ id: "i1", title: "I1", ...DELETE_META }],
      "LinearIssue",
      "linear",
    );
    expect(result.buckets).toEqual({ issues: [{ id: "i1", _deleted: true }] });
  });
});

describe("bucketByModel — jira", () => {
  it("routes Jira models to issues/projects/sprints/comments", () => {
    expect(bucketByModel([{ id: "1" }], "Issue", "jira").buckets).toEqual({
      issues: [{ id: "1" }],
    });
    expect(bucketByModel([{ id: "1" }], "Project", "jira").buckets).toEqual({
      projects: [{ id: "1" }],
    });
    expect(bucketByModel([{ id: "1" }], "Sprint", "jira").buckets).toEqual({
      sprints: [{ id: "1" }],
    });
    expect(bucketByModel([{ id: "1" }], "Comment", "jira").buckets).toEqual({
      comments: [{ id: "1" }],
    });
  });
});

describe("bucketByModel — notion", () => {
  it("routes NotionPage → pages, NotionDatabase → databases, NotionUser → users", () => {
    expect(bucketByModel([{ id: "p" }], "NotionPage", "notion").buckets).toEqual({
      pages: [{ id: "p" }],
    });
    expect(
      bucketByModel([{ id: "d" }], "NotionDatabase", "notion").buckets,
    ).toEqual({ databases: [{ id: "d" }] });
    expect(bucketByModel([{ id: "u" }], "NotionUser", "notion").buckets).toEqual({
      users: [{ id: "u" }],
    });
  });

  it("returns empty for NotionPageContent (no aux-file emission)", () => {
    expect(
      bucketByModel([{ id: "p" }], "NotionPageContent", "notion").buckets,
    ).toEqual({});
  });
});

describe("bucketByModel — github", () => {
  it("routes each GitHub model and preserves owner/repo fields", () => {
    const pr = {
      number: 7,
      title: "PR",
      owner: "AgentWorkforce",
      repo: "cloud",
      full_name: "AgentWorkforce/cloud",
    };
    const result = bucketByModel([pr], "PullRequest", "github");
    expect(result.provider).toBe("github");
    const buckets = result.buckets as GitHubBuckets;
    expect(buckets.pullRequests).toEqual([pr]);
  });

  it("rewrites GitHub deletes with owner/repo scoping when available", () => {
    const result = bucketByModel(
      [
        {
          id: "42",
          owner: "AgentWorkforce",
          repo: "cloud",
          full_name: "AgentWorkforce/cloud",
          ...DELETE_META,
        },
      ],
      "Issue",
      "github",
    );
    const buckets = result.buckets as GitHubBuckets;
    expect(buckets.issues).toEqual([
      {
        id: "42",
        _deleted: true,
        owner: "AgentWorkforce",
        repo: "cloud",
        full_name: "AgentWorkforce/cloud",
      },
    ]);
  });
});

describe("bucketByModel — slack", () => {
  it("routes SlackChannel → channels and SlackUser → users", () => {
    expect(
      bucketByModel([{ id: "C1", name: "general" }], "SlackChannel", "slack")
        .buckets,
    ).toEqual({ channels: [{ id: "C1", name: "general" }] });
    expect(
      bucketByModel([{ id: "U1", name: "u" }], "SlackUser", "slack").buckets,
    ).toEqual({ users: [{ id: "U1", name: "u" }] });
  });

  it("splits SlackMessage into messages/threads/threadReplies by thread_ts", () => {
    const lone = { id: "m1", channel: "C1", ts: "100.1", text: "hi" };
    const threadRoot = {
      id: "m2",
      channel: "C1",
      ts: "100.2",
      thread_ts: "100.2",
      reply_count: 1,
    };
    const reply = {
      id: "m3",
      channel: "C1",
      ts: "100.3",
      thread_ts: "100.2",
    };
    const root = bucketByModel(
      [lone, threadRoot, reply],
      "SlackMessage",
      "slack",
    );
    expect(root.provider).toBe("slack");
    const b = root.buckets as SlackBuckets;
    expect(b.messages?.length).toBe(1);
    expect(b.threads?.length).toBe(1);
    expect(b.threadReplies?.length).toBe(1);
    // channelId aliasing applied so the adapter sees its canonical field.
    expect((b.messages![0] as { channelId?: string }).channelId).toBe("C1");
    expect((b.threads![0] as { channelId?: string }).channelId).toBe("C1");
    expect((b.threadReplies![0] as { replyTs?: string }).replyTs).toBe("100.3");
  });

  it("rewrites slack message deletes with channelId/ts scoping", () => {
    const result = bucketByModel(
      [{ id: "X", channel: "C9", ts: "111.1", ...DELETE_META }],
      "SlackMessage",
      "slack",
    );
    const buckets = result.buckets as SlackBuckets;
    expect(buckets.messages).toEqual([
      { id: "X", _deleted: true, channelId: "C9", ts: "111.1" },
    ]);
  });

  it("routes slack thread-root deletes to the threads bucket", () => {
    const result = bucketByModel(
      [{ id: "T1", channel: "C9", ts: "111.2", thread_ts: "111.2", ...DELETE_META }],
      "SlackMessage",
      "slack",
    );
    const buckets = result.buckets as SlackBuckets;
    expect(buckets.threads).toEqual([
      { id: "T1", _deleted: true, channelId: "C9", ts: "111.2", threadTs: "111.2" },
    ]);
  });

  it("routes slack thread-reply deletes to the threadReplies bucket", () => {
    const result = bucketByModel(
      [{ id: "R1", channel: "C9", ts: "111.3", thread_ts: "111.2", ...DELETE_META }],
      "SlackMessage",
      "slack",
    );
    const buckets = result.buckets as SlackBuckets;
    expect(buckets.threadReplies).toEqual([
      {
        id: "R1",
        _deleted: true,
        channelId: "C9",
        ts: "111.3",
        threadTs: "111.2",
        replyTs: "111.3",
      },
    ]);
  });

  it("treats slack-bot as a slack provider", () => {
    const result = bucketByModel(
      [{ id: "C1", name: "general" }],
      "SlackChannel",
      "slack-bot",
    );
    expect(result.provider).toBe("slack");
    expect(result.buckets).toEqual({
      channels: [{ id: "C1", name: "general" }],
    });
  });
});

describe("bucketByModel — fathom", () => {
  it("routes Fathom models into meetings/recording summaries/transcripts/teams/team-members", () => {
    expect(bucketByModel([{ id: "123", title: "QBR" }], "FathomMeeting", "fathom")).toEqual({
      provider: "fathom",
      buckets: { meetings: [{ id: "123", title: "QBR" }] },
    });
    expect(
      bucketByModel([{ id: "123", summary: {} }], "FathomRecordingSummary", "fathom-relay").buckets,
    ).toEqual({
      recordingSummaries: [{ id: "123", summary: {} }],
    });
    expect(
      bucketByModel([{ id: "123", transcript: [] }], "FathomRecordingTranscript", "fathom").buckets,
    ).toEqual({
      recordingTranscripts: [{ id: "123", transcript: [] }],
    });
    expect(bucketByModel([{ id: "Sales", name: "Sales" }], "FathomTeam", "fathom").buckets).toEqual({
      teams: [{ id: "Sales", name: "Sales" }],
    });
    expect(
      bucketByModel([{ id: "alice@acme.com", email: "alice@acme.com" }], "FathomTeamMember", "fathom").buckets,
    ).toEqual({
      teamMembers: [{ id: "alice@acme.com", email: "alice@acme.com" }],
    });
  });

  it("rewrites Fathom deletes to id tombstones", () => {
    expect(
      bucketByModel([{ id: "123", ...DELETE_META }], "FathomMeeting", "fathom").buckets,
    ).toEqual({
      meetings: [{ id: "123", _deleted: true }],
    });
  });
});

describe("bucketByModel — recall", () => {
  it("routes Recall recordings and transcripts into the recordings resource", () => {
    expect(bucketByModel([{ id: "rec_123" }], "RecallRecording", "recall")).toEqual({
      provider: "recall",
      buckets: { recordings: [{ id: "rec_123" }] },
    });
    expect(
      bucketByModel(
        [{ id: "tr_123", recording_id: "rec_123", transcript_text: "Hello" }],
        "RecallTranscript",
        "recall-relay",
      ).buckets,
    ).toEqual({
      recordings: [
        { id: "tr_123", recording_id: "rec_123", transcript_text: "Hello" },
      ],
    });
  });

  it("rewrites Recall deletes to id tombstones", () => {
    expect(
      bucketByModel([{ id: "rec_123", ...DELETE_META }], "RecallRecording", "recall").buckets,
    ).toEqual({
      recordings: [{ id: "rec_123", _deleted: true }],
    });
  });
});

describe("bucketByModel — fallbacks", () => {
  it("returns an empty bucket on unknown models", () => {
    const result = bucketByModel([{ id: "x" }], "MysteryModel", "github");
    expect(result.provider).toBe("github");
    expect(result.buckets).toEqual({});
  });

  it("skips non-object records (numbers, nulls, arrays)", () => {
    const result = bucketByModel(
      [null, 42, ["arr"], { id: "p" }],
      "ConfluencePage",
      "confluence",
    );
    expect(result.buckets).toEqual({ pages: [{ id: "p" }] });
  });
});
