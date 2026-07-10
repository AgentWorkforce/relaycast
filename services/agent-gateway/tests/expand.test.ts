import assert from "node:assert/strict";
import { test } from "vitest";

import { createAgentEvent } from "@agent-relay/events";
import { FeatureNotImplementedError } from "@agent-relay/events";

import {
  expandGatewayEvent,
  setAirtableFetchOnDemand,
} from "../src/expand.js";
import { RelayFileClient } from "@relayfile/sdk";

type RelayfileClientStub = NonNullable<
  Parameters<typeof expandGatewayEvent>[0]["relayfileClient"]
>;

function createRelayfileClient(
  overrides: Partial<RelayfileClientStub>,
): RelayfileClientStub {
  return {
    async getResourceAtEvent(_eventId, options) {
      return {
        path: options.path,
        data: {},
      };
    },
    async listRecentChanges() {
      return [];
    },
    async readResource(_workspace, path) {
      return {
        path,
        data: {},
      };
    },
    async queryResources() {
      return {
        items: [],
        nextCursor: null,
      };
    },
    ...overrides,
  };
}

function threadItem(input: {
  id: string;
  authorId?: string;
  authorName?: string;
  createdAt?: string;
  body: string;
  kind?: "comment" | "reply" | "system";
}) {
  return {
    id: input.id,
    author: {
      id: input.authorId ?? "unknown",
      displayName: input.authorName ?? input.authorId ?? "unknown",
    },
    createdAt: input.createdAt ?? "1970-01-01T00:00:00.000Z",
    body: input.body,
    kind: input.kind ?? "comment",
  };
}

test("expandGatewayEvent resolves full expansion with relayfile resource data", async () => {
  const event = createAgentEvent({
    id: "evt_full_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/linear/issues/ENG-1.json",
    resource: {
      path: "/linear/issues/ENG-1.json",
      kind: "linear.issue",
      id: "ENG-1",
      provider: "linear",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "full",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(eventId, options) {
        assert.equal(eventId, "evt_full_1");
        assert.equal(options.path, "/linear/issues/ENG-1.json");
        return {
          path: options.path,
          data: { id: "ENG-1", title: "Ship expansion RPC" },
          digest: "digest-1",
          url: "https://relayfile.test/file",
        };
      },
      async listRecentChanges() {
        return [];
      },
    }),
  });

  assert.equal(expansion.level, "full");
  assert.equal(expansion.path, "/linear/issues/ENG-1.json");
  assert.deepEqual(expansion.data, {
    id: "ENG-1",
    title: "Ship expansion RPC",
  });
  assert.equal((expansion as { digest?: string }).digest, "digest-1");
  assert.equal((expansion as { url?: string }).url, "https://relayfile.test/file");
});

test("expandGatewayEvent resolves summary expansion without additional I/O", async () => {
  const event = createAgentEvent({
    id: "evt_summary_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/linear/issues/ENG-1.json",
    resource: {
      path: "/linear/issues/ENG-1.json",
      kind: "linear.issue",
      id: "ENG-1",
      provider: "linear",
    },
    summary: {
      title: "Ship expansion RPC",
      status: "in_progress",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "summary",
    relayfileAccessToken: "relayfile-token",
  });

  assert.deepEqual(expansion, {
    level: "summary",
    path: "/linear/issues/ENG-1.json",
    summary: {
      title: "Ship expansion RPC",
      status: "in_progress",
    },
  });
});

test("expandGatewayEvent resolves diff expansion from current and previous change snapshots", async () => {
  const event = createAgentEvent({
    id: "evt_diff_current",
    workspace: "support",
    type: "relayfile.changed",
    path: "/github/prs/42.json",
    resource: {
      path: "/github/prs/42.json",
      kind: "github.pull_request",
      id: "42",
      provider: "github",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "diff",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(eventId, options) {
        if (eventId === "evt_diff_current") {
          return {
            path: options.path,
            data: { title: "new title", state: "open" },
            digest: "digest-current",
          };
        }

        return {
          path: options.path,
          data: { title: "old title", state: "open" },
          digest: "digest-previous",
        };
      },
      async listRecentChanges() {
        return [
          {
            eventId: "evt_diff_current",
            path: "/github/prs/42.json",
          },
          {
            eventId: "evt_diff_previous",
            path: "/github/prs/42.json",
          },
        ];
      },
    }),
  });

  assert.equal(expansion.level, "diff");
  assert.equal(expansion.path, "/github/prs/42.json");
  assert.deepEqual(expansion.diff, {
    current: {
      path: "/github/prs/42.json",
      data: { title: "new title", state: "open" },
      digest: "digest-current",
    },
    previous: {
      path: "/github/prs/42.json",
      data: { title: "old title", state: "open" },
      digest: "digest-previous",
    },
    currentEventId: "evt_diff_current",
    previousEventId: "evt_diff_previous",
    fieldsChanged: ["title"],
    changes: {
      title: {
        previous: "old title",
        current: "new title",
      },
    },
  });
});

test("expandGatewayEvent only selects a previous change from the same resource path", async () => {
  const event = createAgentEvent({
    id: "evt_diff_target",
    workspace: "support",
    type: "relayfile.changed",
    path: "/github/prs/42.json",
    resource: {
      path: "/github/prs/42.json",
      kind: "github.pull_request",
      id: "42",
      provider: "github",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "diff",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(eventId, options) {
        if (eventId === "evt_diff_target") {
          return {
            path: options.path,
            data: { title: "new title", state: "open" },
          };
        }
        throw new Error(`unexpected lookup for ${eventId}`);
      },
      async listRecentChanges() {
        return [
          { eventId: "evt_unrelated", path: "/github/prs/99.json" },
        ];
      },
    }),
  });

  assert.equal(expansion.diff.previousEventId, null);
  assert.equal((expansion.diff.previous as unknown), null);
});

test("expandGatewayEvent resolves Linear thread expansion via related comment files", async () => {
  const event = createAgentEvent({
    id: "evt_linear_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/linear/issues/ENG-1.json",
    resource: {
      path: "/linear/issues/ENG-1.json",
      kind: "linear.issue",
      id: "ENG-1",
      provider: "linear",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    threadOptions: {
      cursor: "cursor-2",
      limit: 10,
    },
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async queryResources(workspace, options) {
        assert.equal(workspace, "support");
        assert.equal(options.provider, "linear");
        assert.equal(options.relation, "/linear/issues/ENG-1.json");
        assert.deepEqual(options.properties, { "linear.object_type": "comment" });
        assert.equal(options.cursor, "cursor-2");
        assert.equal(options.limit, 10);
        return {
          items: [{ path: "/linear/comments/c-2.json" }],
          nextCursor: null,
        };
      },
      async readResource(_workspace, path) {
        return {
          path,
          data: {
            id: "c-2",
            body: "Follow-up",
            created_at: "2026-05-12T00:00:00.000Z",
            user: { id: "usr_linear", name: "Ada" },
          },
        };
      },
    }),
  });

  assert.deepEqual(expansion, {
    level: "thread",
    items: [threadItem({
      id: "c-2",
      authorId: "usr_linear",
      authorName: "Ada",
      createdAt: "2026-05-12T00:00:00.000Z",
      body: "Follow-up",
    })],
    hasMore: false,
  });
});

test("expandGatewayEvent resolves GitHub thread expansion across reviews and comments", async () => {
  const event = createAgentEvent({
    id: "evt_github_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/github/repos/acme/widgets/pulls/42/reviews/9001.json",
    resource: {
      path: "/github/repos/acme/widgets/pulls/42/reviews/9001.json",
      kind: "github.review",
      id: "9001",
      provider: "github",
    },
  });

  const calls: Array<{ path?: string; cursor?: string; limit?: number }> = [];
  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    threadOptions: { limit: 2 },
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async queryResources(_workspace, options) {
        calls.push({
          path: options.path,
          cursor: options.cursor,
          limit: options.limit,
        });
        if (options.path?.endsWith("/reviews")) {
          return {
            items: [{ path: "/github/repos/acme/widgets/pulls/42/reviews/9001.json" }],
            nextCursor: null,
          };
        }
        return {
          items: [{ path: "/github/repos/acme/widgets/pulls/42/comments/9101.json" }],
          nextCursor: "comment-page-2",
        };
      },
      async readResource(_workspace, path) {
        return {
          path,
          data: path.includes("/reviews/")
            ? {
                id: "9001",
                state: "APPROVED",
                user: { id: "usr_github_1", name: "Reviewer" },
                submitted_at: "2026-05-12T00:00:00.000Z",
              }
            : {
                id: "9101",
                body: "Please rename this variable",
                user: { id: "usr_github_2", name: "Maintainer" },
                created_at: "2026-05-12T00:01:00.000Z",
              },
        };
      },
    }),
  });

  assert.deepEqual(calls, [
    { path: "/github/repos/acme/widgets/pulls/42/reviews", cursor: undefined, limit: 2 },
    { path: "/github/repos/acme/widgets/pulls/42/comments", cursor: undefined, limit: 1 },
  ]);
  assert.equal(expansion.level, "thread");
  assert.equal(expansion.items.length, 2);
  assert.equal(expansion.hasMore, true);
  assert.ok(typeof expansion.cursor === "string");
});

test("expandGatewayEvent resolves Slack thread expansion from reply files", async () => {
  const event = createAgentEvent({
    id: "evt_slack_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/slack/channels/C123/threads/1715000000_000100/meta.json",
    resource: {
      path: "/slack/channels/C123/threads/1715000000_000100/meta.json",
      kind: "slack.resource",
      id: "C123:1715000000.000100",
      provider: "slack",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async queryResources(_workspace, options) {
        assert.equal(options.path, "/slack/channels/C123/threads/1715000000_000100/replies");
        return {
          items: [{ path: "/slack/channels/C123/threads/1715000000_000100/replies/1715000001_000200.json" }],
          nextCursor: null,
        };
      },
      async readResource(_workspace, path) {
        return {
          path,
          data: {
            id: "reply-1",
            text: "Thread reply",
            user: { id: "usr_slack", name: "Grace" },
            ts: "2026-05-12T00:00:00.000Z",
          },
        };
      },
    }),
  });

  assert.deepEqual(expansion, {
    level: "thread",
    items: [threadItem({
      id: "reply-1",
      authorId: "usr_slack",
      authorName: "Grace",
      createdAt: "2026-05-12T00:00:00.000Z",
      body: "Thread reply",
      kind: "reply",
    })],
    hasMore: false,
  });
});

test("expandGatewayEvent resolves Notion page comments from comments.json", async () => {
  const event = createAgentEvent({
    id: "evt_notion_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/notion/pages/page-1.json",
    resource: {
      path: "/notion/pages/page-1.json",
      kind: "notion.page",
      id: "page-1",
      provider: "notion",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    threadOptions: { limit: 1 },
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async readResource(_workspace, path) {
        assert.equal(path, "/notion/pages/page-1/comments.json");
        return {
          path,
          data: [
            {
              id: "comment-1",
              rich_text: "First",
              created_at: "2026-05-12T00:00:00.000Z",
              created_by: { id: "usr_notion", name: "Ada" },
            },
            { id: "comment-2", rich_text: "Second" },
          ],
        };
      },
    }),
  });

  assert.deepEqual(expansion, {
    level: "thread",
    items: [threadItem({
      id: "comment-1",
      authorId: "usr_notion",
      authorName: "Ada",
      createdAt: "2026-05-12T00:00:00.000Z",
      body: "First",
    })],
    hasMore: true,
    cursor: "eyJvZmZzZXQiOjF9",
  });
});

test("expandGatewayEvent resolves Jira issue comments from the embedded issue payload", async () => {
  const event = createAgentEvent({
    id: "evt_jira_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/jira/issues/ENG-42.json",
    resource: {
      path: "/jira/issues/ENG-42.json",
      kind: "jira.issue",
      id: "ENG-42",
      provider: "jira",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(_eventId, options) {
        return {
          path: options.path,
          data: {
            fields: {
              comment: {
                comments: [{
                  id: "9001",
                  body: "Looks good.",
                  author: { accountId: "usr_jira", displayName: "Reviewer" },
                  created: "2026-05-12T00:00:00.000Z",
                }],
              },
            },
          },
        };
      },
    }),
  });

  assert.deepEqual(expansion, {
    level: "thread",
    items: [threadItem({
      id: "9001",
      authorId: "usr_jira",
      authorName: "Reviewer",
      body: "Looks good.",
      createdAt: "2026-05-12T00:00:00.000Z",
    })],
    hasMore: false,
  });
});

test("expandGatewayEvent resolves Asana task stories from the embedded payload", async () => {
  const event = createAgentEvent({
    id: "evt_asana_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/asana/tasks/1200.json",
    resource: {
      path: "/asana/tasks/1200.json",
      kind: "asana.task",
      id: "1200",
      provider: "asana",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(_eventId, options) {
        return {
          path: options.path,
          data: {
            stories: [
              {
                gid: "story-1",
                text: "Task reassigned",
                created_at: "2026-05-12T00:00:00.000Z",
                created_by: { gid: "usr_asana", name: "Grace" },
              },
            ],
          },
        };
      },
    }),
  });

  assert.deepEqual(expansion, {
    level: "thread",
    items: [threadItem({
      id: "story-1",
      authorId: "usr_asana",
      authorName: "Grace",
      createdAt: "2026-05-12T00:00:00.000Z",
      body: "Task reassigned",
    })],
    hasMore: false,
  });
});

test("expandGatewayEvent resolves Zendesk ticket comments from the embedded ticket payload", async () => {
  const event = createAgentEvent({
    id: "evt_zendesk_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/zendesk/tickets/1.json",
    resource: {
      path: "/zendesk/tickets/1.json",
      kind: "zendesk.ticket",
      id: "1",
      provider: "zendesk",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(_eventId, options) {
        return {
          path: options.path,
          data: {
            comments: [
              {
                id: "c_1",
                body: "Customer replied",
                author: { id: "usr_zendesk", name: "Customer" },
                created_at: "2026-05-12T00:00:00.000Z",
              },
            ],
          },
        };
      },
    }),
  });

  assert.deepEqual(expansion, {
    level: "thread",
    items: [threadItem({
      id: "c_1",
      authorId: "usr_zendesk",
      authorName: "Customer",
      body: "Customer replied",
      createdAt: "2026-05-12T00:00:00.000Z",
    })],
    hasMore: false,
  });
});

test("expandGatewayEvent resolves ClickUp task comments into normalized thread items", async () => {
  const event = createAgentEvent({
    id: "evt_clickup_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/clickup/tasks/task-1.json",
    resource: {
      path: "/clickup/tasks/task-1.json",
      kind: "clickup.task",
      id: "task-1",
      provider: "clickup",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(_eventId, options) {
        return {
          path: options.path,
          data: {
            comments: [{
              id: "cu-comment-1",
              comment_text: "Need a quick update from jane@example.com",
              created_at: "2026-05-12T00:00:00.000Z",
              user: { id: "usr_clickup", name: "Ada" },
            }],
          },
        };
      },
    }),
  });

  assert.deepEqual(expansion, {
    level: "thread",
    items: [threadItem({
      id: "cu-comment-1",
      authorId: "usr_clickup",
      authorName: "Ada",
      createdAt: "2026-05-12T00:00:00.000Z",
      body: "Need a quick update from [redacted-email]",
    })],
    hasMore: false,
  });
});

test("expandGatewayEvent resolves HubSpot engagements into normalized thread items", async () => {
  const event = createAgentEvent({
    id: "evt_hubspot_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/hubspot/deals/42.json",
    resource: {
      path: "/hubspot/deals/42.json",
      kind: "hubspot.deal",
      id: "42",
      provider: "hubspot",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(_eventId, options) {
        return {
          path: options.path,
          data: {
            engagements: [{
              id: "engagement-1",
              body: "Call +1 555 123 4567 tomorrow",
              createdAt: "2026-05-12T00:00:00.000Z",
              author: { id: "usr_hubspot", name: "Grace" },
            }],
          },
        };
      },
    }),
  });

  assert.deepEqual(expansion, {
    level: "thread",
    items: [threadItem({
      id: "engagement-1",
      authorId: "usr_hubspot",
      authorName: "Grace",
      createdAt: "2026-05-12T00:00:00.000Z",
      body: "Call [redacted-number] tomorrow",
    })],
    hasMore: false,
  });
});

test("expandGatewayEvent resolves Salesforce ChatterFeed items into normalized thread items", async () => {
  const event = createAgentEvent({
    id: "evt_salesforce_thread_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/salesforce/cases/5001.json",
    resource: {
      path: "/salesforce/cases/5001.json",
      kind: "salesforce.case",
      id: "5001",
      provider: "salesforce",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "thread",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(_eventId, options) {
        return {
          path: options.path,
          data: {
            ChatterFeed: [{
              id: "feed-1",
              body: "Escalated to support@example.com",
              createdDate: "2026-05-12T00:00:00.000Z",
              CreatedBy: { Id: "usr_sf", Name: "Reviewer" },
            }],
          },
        };
      },
    }),
  });

  assert.deepEqual(expansion, {
    level: "thread",
    items: [threadItem({
      id: "feed-1",
      authorId: "usr_sf",
      authorName: "Reviewer",
      createdAt: "2026-05-12T00:00:00.000Z",
      body: "Escalated to [redacted-email]",
    })],
    hasMore: false,
  });
});

test("expandGatewayEvent invokes Airtable fetch-on-demand before reading relayfile", async () => {
  const calls: string[] = [];
  setAirtableFetchOnDemand(async (event) => {
    calls.push(`fetch:${event.id}`);
  });

  const event = createAgentEvent({
    id: "evt_airtable_1",
    workspace: "support",
    type: "relayfile.changed",
    path: "/airtable/bases/app123/records/rec456.json",
    resource: {
      path: "/airtable/bases/app123/records/rec456.json",
      kind: "airtable.record",
      id: "rec456",
      provider: "airtable",
    },
  });

  await expandGatewayEvent({
    workspace: "support",
    event,
    level: "full",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(_eventId, options) {
        calls.push(`read:${options.path}`);
        return {
          path: options.path,
          data: { id: "rec456" },
        };
      },
      async listRecentChanges() {
        return [];
      },
    }),
  });

  assert.deepEqual(calls, [
    "fetch:evt_airtable_1",
    "read:/airtable/bases/app123/records/rec456.json",
  ]);
});

test("expandGatewayEvent uses relayfile retained changes with the M2 change-event shape", async () => {
  const event = createAgentEvent({
    id: "evt_diff_current",
    workspace: "support",
    type: "relayfile.changed",
    path: "/github/prs/42.json",
    resource: {
      path: "/github/prs/42.json",
      kind: "github.pull_request",
      id: "42",
      provider: "github",
    },
  });

  const expansion = await expandGatewayEvent({
    workspace: "support",
    event,
    level: "diff",
    relayfileAccessToken: "relayfile-token",
    relayfileClient: createRelayfileClient({
      async getResourceAtEvent(eventId, options) {
        if (eventId === "evt_diff_current") {
          return {
            path: options.path,
            data: { title: "new title", state: "open" },
            digest: "digest-current",
          };
        }

        return {
          path: options.path,
          data: { title: "old title", state: "open" },
          digest: "digest-previous",
        };
      },
      async listRecentChanges() {
        return [
          {
            eventId: "evt_diff_current",
            path: "/github/prs/42.json",
          },
          {
            eventId: "evt_diff_previous",
            path: "/github/prs/42.json",
          },
        ];
      },
    }),
  });

  assert.equal(expansion.level, "diff");
  assert.deepEqual(expansion.diff, {
    current: {
      path: "/github/prs/42.json",
      data: { title: "new title", state: "open" },
      digest: "digest-current",
    },
    previous: {
      path: "/github/prs/42.json",
      data: { title: "old title", state: "open" },
      digest: "digest-previous",
    },
    currentEventId: "evt_diff_current",
    previousEventId: "evt_diff_previous",
    fieldsChanged: ["title"],
    changes: {
      title: {
        previous: "old title",
        current: "new title",
      },
    },
  });
});

test("expandGatewayEvent calls RelayFileClient.listLastNChanges with limit first and workspace options", async () => {
  const event = createAgentEvent({
    id: "evt_diff_current",
    workspace: "support",
    type: "relayfile.changed",
    path: "/github/prs/42.json",
    resource: {
      path: "/github/prs/42.json",
      kind: "github.pull_request",
      id: "42",
      provider: "github",
    },
  });

  const prototype = RelayFileClient.prototype as RelayFileClient["prototype"] & {
    getResourceAtEvent?: (eventId: string) => Promise<unknown>;
    listLastNChanges?: (limit: number, options?: { workspace?: string }) => Promise<unknown>;
  };
  const originalGetResourceAtEvent = prototype.getResourceAtEvent;
  const originalListLastNChanges = prototype.listLastNChanges;

  const calls: Array<{ limit: number; workspace?: string }> = [];
  prototype.getResourceAtEvent = async (eventId: string) => {
    if (eventId === "evt_diff_current") {
      return {
        path: "/github/prs/42.json",
        data: { title: "new title" },
        digest: "digest-current",
      };
    }

    return {
      path: "/github/prs/42.json",
      data: { title: "old title" },
      digest: "digest-previous",
    };
  };
  prototype.listLastNChanges = async (limit: number, options?: { workspace?: string }) => {
    calls.push({ limit, workspace: options?.workspace });
    return {
      events: [
        {
          id: "evt_diff_current",
          occurredAt: "2026-05-12T00:00:00.000Z",
          resource: {
            path: "/github/prs/42.json",
            kind: "github.pull_request",
            id: "42",
            provider: "github",
          },
          type: "relayfile.changed",
        },
        {
          id: "evt_diff_previous",
          occurredAt: "2026-05-11T00:00:00.000Z",
          resource: {
            path: "/github/prs/42.json",
            kind: "github.pull_request",
            id: "42",
            provider: "github",
          },
          type: "relayfile.changed",
        },
      ],
    };
  };

  try {
    const expansion = await expandGatewayEvent({
      workspace: "support",
      event,
      level: "diff",
      relayfileAccessToken: "relayfile-token",
      relayfileUrl: "https://relayfile.test",
    });

    assert.equal(expansion.level, "diff");
    assert.deepEqual(calls, [{ limit: 64, workspace: "support" }]);
    assert.equal(expansion.diff.previousEventId, "evt_diff_previous");
  } finally {
    prototype.getResourceAtEvent = originalGetResourceAtEvent;
    prototype.listLastNChanges = originalListLastNChanges;
  }
});

test("expandGatewayEvent materializes Airtable notification payloads through Nango in production mode", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://nango.test/proxy");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as {
      endpoint: string;
      method: string;
      params?: Record<string, string>;
    };
    assert.equal(body.method, "GET");
    assert.equal(body.endpoint, "/v0/bases/app123/webhooks/wh_456/payloads");
    assert.deepEqual(body.params, { cursor: "7" });

    return new Response(
      JSON.stringify({
        payloads: [{ changedTablesById: { tbl_1: { changedRecordsById: {} } } }],
        cursor: 11,
        mightHaveMore: false,
        payloadFormat: "v0",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const event = createAgentEvent({
      id: "evt_airtable_prod_1",
      workspace: "support",
      type: "relayfile.changed",
      path: "/airtable/bases/app123/_notifications/wh_456.json",
      resource: {
        path: "/airtable/bases/app123/_notifications/wh_456.json",
        kind: "airtable.notification",
        id: "wh_456",
        provider: "airtable",
      },
    });

    const expansion = await expandGatewayEvent({
      workspace: "support",
      event,
      level: "full",
      relayfileAccessToken: "relayfile-token",
      nangoSecretKey: "nango-secret",
      nangoBaseUrl: "https://nango.test",
      relayfileClient: {
        async getResourceAtEvent(_eventId, options) {
          return {
            path: options.path,
            data: {
              baseId: "app123",
              webhookId: "wh_456",
              connectionId: "conn_airtable_1",
              providerConfigKey: "airtable-relay",
              cursor: 7,
            },
          };
        },
        async listRecentChanges() {
          return [];
        },
      },
    });

    assert.deepEqual(expansion, {
      level: "full",
      path: "/airtable/bases/app123/_notifications/wh_456.json",
      data: {
        baseId: "app123",
        webhookId: "wh_456",
        notificationId: "wh_456",
        endpoint: "/v0/bases/app123/webhooks/wh_456/payloads",
        path: "/airtable/bases/app123/_notifications/wh_456.json",
        payloads: [{ changedTablesById: { tbl_1: { changedRecordsById: {} } } }],
        data: {
          payloads: [{ changedTablesById: { tbl_1: { changedRecordsById: {} } } }],
          cursor: 11,
          mightHaveMore: false,
          payloadFormat: "v0",
        },
        cursor: 11,
        mightHaveMore: false,
        payloadFormat: "v0",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
