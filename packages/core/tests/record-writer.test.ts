import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADAPTERS,
  bucketByModel,
  buildDeletionRecord,
  createWebhookSyncJob,
  ensureProviderDiscoveryContractReport,
  resolveAdapter,
  sampleExistingRecordsByResource,
  writeBatchToRelayfile,
  writeProviderRecord,
  type RegisteredAdapter,
  type RelayfileWriteClient,
} from "../src/sync/record-writer.js";
import { assertLayoutDiscoveryConsistency } from "../src/sync/discovery-emitter.js";
import { toAuxiliaryEmitterClient } from "../src/sync/auxiliary-emitter-shim.js";
import {
  buildHubSpotCompanyRecord,
  buildHubSpotContactRecord,
  buildHubSpotDealRecord,
  buildHubSpotTicketRecord,
} from "../src/sync/hubspot-record-shapes.js";
import {
  buildHubSpotCompanyRecord as buildNangoHubSpotCompanyRecord,
  buildHubSpotContactRecord as buildNangoHubSpotContactRecord,
  buildHubSpotDealRecord as buildNangoHubSpotDealRecord,
  buildHubSpotTicketRecord as buildNangoHubSpotTicketRecord,
} from "../../../nango-integrations/hubspot-relay/shared/hubspot-record-shapes.js";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import { assertTodayDigestIncludes } from "./provider-write-planner-smoke-helpers.js";
import { readOnlyResources as gcpResources } from "@relayfile/adapter-gcp/resources";

interface RecordedWrite {
  path: string;
  content: string;
  contentType: string;
}

type RecordedBulkMutation =
  | {
      op?: "upsert";
      path: string;
      dependsOn?: string[];
      content: string;
      contentType?: string;
      encoding: "utf-8" | "base64";
    }
  | {
      op: "delete";
      path: string;
      dependsOn?: string[];
      baseRevision?: string;
    };

function makeClient(): RelayfileWriteClient & { writes: RecordedWrite[]; deletes: string[] } {
  const writes: RecordedWrite[] = [];
  const deletes: string[] = [];
  return {
    writes,
    deletes,
    async writeFile(input) {
      writes.push({
        path: input.path,
        content: input.content,
        contentType: input.contentType,
      });
    },
    async deleteFile(input) {
      deletes.push(input.path);
    },
  };
}

function linearJob(model: string): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "linear",
    providerConfigKey: "linear-relay",
    connectionId: "conn_test",
    syncName: `fetch-${model.replace(/^Linear/, "").toLowerCase()}s`,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function notionJob(model = "NotionPage"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "notion",
    providerConfigKey: "notion-relay",
    connectionId: "conn_test",
    syncName: "fetch-pages",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function slackJob(model = "SlackChannel"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "slack",
    providerConfigKey: "slack-relay",
    connectionId: "conn_test",
    syncName: model === "SlackUser" ? "fetch-users" : "fetch-channels",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function telegramJob(model = "TelegramMessage"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "telegram",
    providerConfigKey: "telegram-relay",
    connectionId: "conn_test",
    syncName: model === "TelegramBotConfig" ? "fetch-bot-config" : "fetch-updates",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function xJob(model = "XPost"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "x",
    providerConfigKey: "x-relay",
    connectionId: "conn_test",
    syncName: "fetch-searches",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function googleMailJob(
  model = "GoogleMailMessage",
  provider = "google-mail",
): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider,
    providerConfigKey: "google-mail-relay",
    connectionId: "conn_test",
    syncName: "fetch-messages",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function googleCalendarJob(model = "GoogleCalendarEvent"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "google-calendar",
    providerConfigKey: "google-calendar-relay",
    connectionId: "conn_test",
    syncName: "fetch-events",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function granolaJob(model = "GranolaNote"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "granola",
    providerConfigKey: "granola-relay",
    connectionId: "conn_test",
    syncName: model === "GranolaFolder" ? "fetch-folders" : "fetch-notes",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function recallJob(model = "RecallRecording"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "recall",
    providerConfigKey: "recall-relay",
    connectionId: "conn_test",
    syncName: model === "RecallTranscript" ? "fetch-transcripts" : "fetch-recordings",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function fathomJob(model = "FathomMeeting"): NangoSyncJob {
  const syncName =
    model === "FathomRecordingSummary"
      ? "fetch-recording-summaries"
      : model === "FathomRecordingTranscript"
        ? "fetch-recording-transcripts"
        : model === "FathomTeam"
          ? "fetch-teams"
          : model === "FathomTeamMember"
            ? "fetch-team-members"
            : "fetch-meetings";
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "fathom",
    providerConfigKey: "fathom-relay",
    connectionId: "conn_test",
    syncName,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function dockerHubJob(model = "DockerHubRepository"): NangoSyncJob {
  const syncName =
    model === "DockerHubTag"
      ? "fetch-tags"
      : model === "DockerHubWebhook"
        ? "fetch-webhooks"
        : "fetch-repositories";
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "docker-hub",
    providerConfigKey: "docker_hub-composio-relay",
    connectionId: "conn_test",
    syncName,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function redditJob(model = "RedditPost"): NangoSyncJob {
  const syncName = model === "RedditTrackedSubreddit" ? "fetch-subreddits" : "fetch-posts";
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "reddit",
    providerConfigKey: "reddit-composio-relay",
    connectionId: "conn_test",
    syncName,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function gcpJob(model = "GcpCloudRunService"): NangoSyncJob {
  const syncName =
    model === "GcpMonitoringAlert"
      ? "fetch-monitoring-alerts"
      : model === "GcpBilling"
        ? "fetch-billing"
        : model === "GcpErrorGroup"
          ? "fetch-error-groups"
        : "fetch-cloud-run";
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "gcp",
    providerConfigKey: "gcp-relay",
    connectionId: "conn_test",
    syncName,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function cloudflareJob(model = "CloudflareWorkerScript"): NangoSyncJob {
  const syncName =
    model === "CloudflareWorkerUsage"
      ? "fetch-workers-usage"
      : model === "CloudflareZone" || model === "CloudflareDnsRecord"
        ? "fetch-zone-topology"
        : model === "CloudflareNotificationEvent"
          ? "fetch-notification-events"
          : "fetch-account-topology";
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "cloudflare",
    providerConfigKey: "cloudflare-relay",
    connectionId: "conn_test",
    syncName,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function neonJob(model = "NeonProject"): NangoSyncJob {
  const syncName =
    model === "NeonOperation"
      ? "fetch-operations"
      : model === "NeonProjectConsumption" || model === "NeonBranchConsumption"
        ? "fetch-consumption"
        : model === "NeonAdvisorIssue"
          ? "fetch-advisor-issues"
          : "fetch-topology";
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "neon",
    providerConfigKey: "neon-relay",
    connectionId: "conn_test",
    syncName,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function hubspotJob(model = "Contact"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "hubspot",
    providerConfigKey: "hubspot-relay",
    connectionId: "conn_test",
    syncName: `fetch-${model.toLowerCase()}s`,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}
/**
 * The provider contract surface (root + provider LAYOUT.md and the
 * `discovery/<provider>/...` schema/example/adapter docs) is materialized on
 * EVERY sync batch, idempotently, even when no record was applied — that is
 * the fix for the rw_fc7b534b "discovery entirely absent" defect. Tests that
 * assert *record-level* write/delete behavior filter these paths out so they
 * keep asserting the record behavior, not the (orthogonal) contract surface.
 */
function isContractPath(path: string): boolean {
  return (
    path === "/LAYOUT.md" ||
    /\/LAYOUT\.md$/.test(path) ||
    path.startsWith("/discovery/")
  );
}

function recordWrites<T extends { path: string }>(writes: readonly T[]): T[] {
  return writes.filter((w) => !isContractPath(w.path));
}

function recordPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => !isContractPath(p));
}

function readJsonFile(
  client: { files: Map<string, string> },
  path: string,
): Record<string, unknown> {
  const content = client.files.get(path);
  assert.ok(content, `expected ${path} to exist`);
  return JSON.parse(content) as Record<string, unknown>;
}

function schemaPropertyCount(
  client: { files: Map<string, string> },
  path: string,
): number {
  const schema = readJsonFile(client, path);
  const properties = schema.properties;
  assert.ok(properties && typeof properties === "object");
  return Object.keys(properties).length;
}

function schemaProperties(
  client: { files: Map<string, string> },
  path: string,
): Record<string, unknown> {
  const schema = readJsonFile(client, path);
  const properties = schema.properties;
  assert.ok(properties && typeof properties === "object");
  return properties as Record<string, unknown>;
}

function createExamplePropertyCount(
  client: { files: Map<string, string> },
  path: string,
): number {
  return Object.keys(readJsonFile(client, path)).length;
}

describe("writeProviderRecord", () => {
  it("routes Nango LinearTeam records to /linear/teams/<id>.json", async () => {
    const client = makeClient();
    await writeProviderRecord(
      client,
      { id: "50cf92f3-f53c-4ab6-bf05-ea76ebd21692", name: "Agent Relay" },
      linearJob("LinearTeam"),
    );
    assert.equal(client.writes.length, 1);
    assert.equal(
      client.writes[0]?.path,
      "/linear/teams/50cf92f3-f53c-4ab6-bf05-ea76ebd21692.json",
    );
  });

  it("routes Nango LinearUser, LinearIssue, LinearComment, LinearMilestone, LinearRoadmap, LinearCycle, LinearProject", async () => {
    const cases: Array<{ model: string; expected: RegExp }> = [
      { model: "LinearUser", expected: /^\/linear\/users\// },
      { model: "LinearIssue", expected: /^\/linear\/issues\// },
      { model: "LinearComment", expected: /^\/linear\/comments\// },
      { model: "LinearMilestone", expected: /^\/linear\/milestones\// },
      { model: "LinearRoadmap", expected: /^\/linear\/roadmaps\// },
      { model: "LinearCycle", expected: /^\/linear\/cycles\// },
      { model: "LinearProject", expected: /^\/linear\/projects\// },
    ];

    for (const { model, expected } of cases) {
      const client = makeClient();
      await writeProviderRecord(client, { id: "id-1" }, linearJob(model));
      assert.equal(client.writes.length, 1, `expected one write for ${model}`);
      assert.match(client.writes[0]!.path, expected);
    }
  });

  it("moves Linear issue by-state aliases when Nango records only carry state_name", async () => {
    const client = makeSeededReadingClient({
      "/linear/issues/by-uuid/issue-123.json": {
        provider: "linear",
        objectType: "issue",
        objectId: "issue-123",
        payload: {
          id: "issue-123",
          identifier: "AGE-8",
          title: "Release Plan",
          state_name: "Todo",
        },
      },
      "/linear/issues/by-state/todo/AGE-8.json": {},
    });

    await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-123",
          identifier: "AGE-8",
          title: "Release Plan",
          state_name: "Done",
          updated_at: "2026-05-15T12:00:00.000Z",
        },
      ],
      linearJob("LinearIssue"),
    );

    assert.ok(client.deletes.includes("/linear/issues/by-state/todo/AGE-8.json"));
    assert.ok(
      client.writes.some(
        (write) => write.path === "/linear/issues/by-state/done/AGE-8.json",
      ),
    );
  });

  it("routes Nango NotionPage records under /notion/pages with an id-stable path", async () => {
    const client = makeClient();
    await writeProviderRecord(
      client,
      {
        id: "3586800c-1c90-80eb-aa52-ea4d88eb32d5",
        title: "Acme Q2 kickoff call",
      },
      notionJob("NotionPage"),
    );
    assert.equal(client.writes.length, 1);
    assert.equal(
      client.writes[0]?.path,
      "/notion/pages/3586800c-1c90-80eb-aa52-ea4d88eb32d5/meta.json",
    );
  });

  it("routes X posts, users, and searches through the adapter path mapper", async () => {
    const postClient = makeClient();
    await writeProviderRecord(
      postClient,
      { id: "post-1", text: "Relayfile social search", author_id: "user-1" },
      xJob("XPost"),
    );
    assert.equal(
      postClient.writes[0]?.path,
      "/x/posts/relayfile-social-search__post-1.json",
    );

    const userClient = makeClient();
    await writeProviderRecord(
      userClient,
      { id: "user-1", username: "agentrelay" },
      xJob("XUser"),
    );
    assert.equal(userClient.writes[0]?.path, "/x/users/agentrelay__user-1.json");

    const searchClient = makeClient();
    await writeProviderRecord(
      searchClient,
      { id: "search-1", query: "agent relay", title: "Agent Relay" },
      xJob("XSearch"),
    );
    assert.equal(searchClient.writes[0]?.path, "/x/searches/search-1__agent-relay/meta.json");
  });

  it("keeps the Notion path stable across title renames so deletes can find the file", async () => {
    // Title is mutable. A title-slugged path would create a new file on
    // rename and orphan the old slug forever (Nango's fetch-pages emits
    // delete events with only { id }, which can only target the current
    // path). The id-only path keeps writes/deletes addressing the same
    // file across renames.
    const client = makeClient();
    const id = "3586800c-1c90-80eb-aa52-ea4d88eb32d5";
    await writeProviderRecord(
      client,
      { id, title: "Original title" },
      notionJob("NotionPage"),
    );
    await writeProviderRecord(
      client,
      { id, title: "Renamed in Notion" },
      notionJob("NotionPage"),
    );
    assert.equal(client.writes.length, 2);
    assert.equal(
      client.writes[0]?.path,
      `/notion/pages/${id}/meta.json`,
    );
    assert.equal(
      client.writes[1]?.path,
      `/notion/pages/${id}/meta.json`,
      "second write should land on the same path as the first — id is stable, title is not",
    );
  });

  it("routes Nango NotionDatabase records under /notion/databases/<id>/metadata.json with an id-stable path", async () => {
    const client = makeClient();
    const id = "1f9c9d4e-1234-4abc-9def-abcdef012345";
    await writeProviderRecord(
      client,
      { id, title: "Acme product roadmap" },
      notionJob("NotionDatabase"),
    );
    assert.equal(client.writes.length, 1);
    assert.equal(
      client.writes[0]?.path,
      `/notion/databases/${id}/metadata.json`,
    );
  });

  it("keeps the Notion database path stable across title renames so deletes can find the file", async () => {
    // Mirrors the NotionPage rename-safety contract: database titles are
    // mutable, so we must address by id-only (the `notion-relay`
    // `fetch-databases` sync emits delete events with `{ id }` only).
    const client = makeClient();
    const id = "1f9c9d4e-1234-4abc-9def-abcdef012345";
    await writeProviderRecord(
      client,
      { id, title: "Original DB title" },
      notionJob("NotionDatabase"),
    );
    await writeProviderRecord(
      client,
      { id, title: "Renamed in Notion" },
      notionJob("NotionDatabase"),
    );
    assert.equal(client.writes.length, 2);
    assert.equal(
      client.writes[0]?.path,
      `/notion/databases/${id}/metadata.json`,
    );
    assert.equal(
      client.writes[1]?.path,
      `/notion/databases/${id}/metadata.json`,
      "second write should land on the same path as the first — id is stable, title is not",
    );
  });

  it("routes Nango NotionPageContent records to /notion/pages/<id>/content.md as text/markdown", async () => {
    // The cortical-demo orchestrator's `onWrite('/notion/pages/*/content.md')`
    // trigger discriminates on path AND contentType. Sending the body as a
    // JSON envelope (the default JSON write path) would not satisfy the
    // markdown subscriber, so this test pins both the path and the
    // contentType for the new content sync.
    const client = makeClient();
    const id = "3586800c-1c90-80eb-aa52-ea4d88eb32d5";
    const markdown = "# Acme Q2 kickoff\n\nNotes from the call.";
    await writeProviderRecord(
      client,
      {
        id,
        pageId: id,
        content: markdown,
        contentHash: "deadbeef",
        lastEditedTime: "2026-05-07T10:00:00.000Z",
      },
      notionJob("NotionPageContent"),
    );
    assert.equal(client.writes.length, 1);
    assert.equal(
      client.writes[0]?.path,
      `/notion/pages/${id}/content.md`,
    );
    assert.equal(
      client.writes[0]?.contentType,
      "text/markdown; charset=utf-8",
    );
    assert.equal(
      client.writes[0]?.content,
      markdown,
      "markdown body should be written verbatim, not JSON-stringified",
    );
  });

  it("routes Google Mail records for both provider aliases", async () => {
    const labelsClient = makeClient();
    await writeProviderRecord(
      labelsClient,
      { id: "Label_1", name: "Inbox" },
      googleMailJob("GoogleMailLabel"),
    );
    assert.equal(labelsClient.writes[0]?.path, "/google-mail/labels/Label_1.json");

    const messagesClient = makeClient();
    await writeProviderRecord(
      messagesClient,
      { id: "188f0032ef7d5a91" },
      googleMailJob("GoogleMailMessage", "google-mail-relay"),
    );
    assert.equal(
      messagesClient.writes[0]?.path,
      "/google-mail/messages/188f0032ef7d5a91.json",
    );
  });

  it("flattens Google Mail headers, decoded bodies, and attachments without raw payload duplication", async () => {
    const client = makeClient();
    const rawMessage = {
      id: "188f0032ef7d5a91",
      threadId: "thread-1",
      labelIds: ["INBOX"],
      snippet: "Plain body",
      historyId: "h1",
      internalDate: "1715600000000",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "Subject", value: "Readable Gmail" },
          { name: "From", value: "Alice Example <alice@example.com>" },
          { name: "To", value: "Bob Example <bob@example.com>" },
          { name: "Cc", value: "Carol Example <carol@example.com>" },
          { name: "Date", value: "Wed, 20 May 2026 10:37:00 +0000" },
          { name: "Message-ID", value: "<gmail-message@example.com>" },
        ],
        parts: [
          {
            partId: "0",
            mimeType: "text/plain",
            body: {
              size: 10,
              data: Buffer.from("Plain body", "utf8").toString("base64url"),
            },
          },
          {
            partId: "1",
            mimeType: "text/html",
            body: {
              size: 18,
              data: Buffer.from("<p>Plain body</p>", "utf8").toString("base64url"),
            },
          },
          {
            partId: "2",
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            body: {
              size: 42,
              attachmentId: "att-1",
            },
          },
        ],
      },
    };

    await writeProviderRecord(
      client,
      rawMessage,
      googleMailJob("GoogleMailMessage", "google-mail-relay"),
    );

    const stored = JSON.parse(client.writes[0]?.content ?? "{}") as Record<string, unknown>;
    assert.equal(stored.subject, "Readable Gmail");
    assert.equal(stored.from, "Alice Example <alice@example.com>");
    assert.equal(stored.to, "Bob Example <bob@example.com>");
    assert.equal(stored.cc, "Carol Example <carol@example.com>");
    assert.equal(stored.bcc, null);
    assert.equal(stored.messageId, "<gmail-message@example.com>");
    assert.equal(stored.body_text, "Plain body");
    assert.equal(stored.body_html, "<p>Plain body</p>");
    assert.deepEqual(stored.attachments, [
      {
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 42,
        attachmentId: "att-1",
        partId: "2",
      },
    ]);
    assert.equal("payload" in stored, false);
    assert.equal("raw_json" in stored, false);
  });

  it("preserves already-flattened Google Mail records without payload", async () => {
    const client = makeClient();
    const alreadyFlattened = {
      id: "188f0032ef7d5a92",
      threadId: "thread-2",
      labelIds: ["INBOX"],
      snippet: "Flattened body",
      historyId: "h2",
      internalDate: "1715600000000",
      subject: "Stored Gmail",
      from: "Alice Example <alice@example.com>",
      to: "Bob Example <bob@example.com>",
      cc: null,
      bcc: null,
      date: "Wed, 20 May 2026 10:40:00 +0000",
      messageId: "<stored-gmail@example.com>",
      inReplyTo: null,
      references: null,
      body_text: "Flattened body",
      body_html: "<p>Flattened body</p>",
      attachments: [],
      raw_json: "{\"id\":\"188f0032ef7d5a92\"}",
    };

    await writeProviderRecord(
      client,
      alreadyFlattened,
      googleMailJob("GoogleMailMessage", "google-mail-relay"),
    );

    const stored = JSON.parse(client.writes[0]?.content ?? "{}") as Record<string, unknown>;
    assert.equal(stored.subject, "Stored Gmail");
    assert.equal(stored.from, "Alice Example <alice@example.com>");
    assert.equal(stored.to, "Bob Example <bob@example.com>");
    assert.equal(stored.body_text, "Flattened body");
    assert.equal(stored.body_html, "<p>Flattened body</p>");
    assert.deepEqual(stored.attachments, []);
    assert.equal("raw_json" in stored, false);
  });

  it("skips unchanged Google Mail records instead of rewriting the WorkspaceDO", async () => {
    const client = makeMutableReadingClient();
    const message = {
      id: "19e5c59efdbabc3a",
      threadId: "thread-dedup",
      labelIds: ["INBOX"],
      snippet: "Repeated Gmail notification",
      historyId: "105",
      internalDate: "1715600000000",
      payload: {
        headers: [
          { name: "Subject", value: "Repeated" },
          { name: "From", value: "Alice Example <alice@example.com>" },
          { name: "To", value: "Bob Example <bob@example.com>" },
        ],
      },
    };
    const job = googleMailJob("GoogleMailMessage", "google-mail-relay");

    assert.equal(await writeProviderRecord(client, message, job), "written");
    assert.equal(await writeProviderRecord(client, message, job), "skipped");
    assert.equal(
      client.writes.filter((write) => write.path === "/google-mail/messages/19e5c59efdbabc3a.json").length,
      1,
    );
  });

  it("routes Google Calendar events and ACLs under calendar-scoped paths", async () => {
    const eventsClient = makeClient();
    await writeProviderRecord(
      eventsClient,
      { id: "primary:event_123", summary: "Standup" },
      googleCalendarJob("GoogleCalendarEvent"),
    );
    assert.equal(
      eventsClient.writes[0]?.path,
      "/google-calendar/calendars/primary/events/event_123.json",
    );

    const aclClient = makeClient();
    await writeProviderRecord(
      aclClient,
      { id: "primary:rule_1", role: "owner" },
      googleCalendarJob("GoogleCalendarAcl"),
    );
    assert.equal(
      aclClient.writes[0]?.path,
      "/google-calendar/calendars/primary/acls/rule_1.json",
    );
  });

  it("routes Telegram bot, chat, message, reaction, callback, inline, and update records through the adapter path mapper", async () => {
    const messageClient = makeClient();
    await writeProviderRecord(
      messageClient,
      {
        id: "8587455921:42",
        chatId: "8587455921",
        messageId: "42",
        chat: { id: 8587455921, title: "Agent Relay Bot Test" },
        text: "rich reply",
      },
      telegramJob("TelegramMessage"),
    );
    assert.equal(
      messageClient.writes[0]?.path,
      "/telegram/chats/8587455921__agent-relay-bot-test/messages/42/meta.json",
    );

    const threadClient = makeClient();
    await writeProviderRecord(
      threadClient,
      {
        chatId: "-100123",
        messageId: "43",
        messageThreadId: "7",
        chatTitle: "Forum",
      },
      telegramJob("TelegramMessage"),
    );
    assert.equal(
      threadClient.writes[0]?.path,
      "/telegram/chats/-100123__forum/threads/7/messages/43/meta.json",
    );

    const cases: Array<{ model: string; record: Record<string, unknown>; expected: string }> = [
      {
        model: "TelegramBotConfig",
        record: { id: "bot", username: "initial_nango_test_bot" },
        expected: "/telegram/bot/config.json",
      },
      {
        model: "TelegramChat",
        record: { id: "8587455921", title: "Agent Relay Bot Test" },
        expected: "/telegram/chats/8587455921__agent-relay-bot-test/meta.json",
      },
      {
        model: "TelegramReaction",
        record: {
          updateId: "900",
          chatId: "8587455921",
          messageId: "42",
          chatTitle: "Agent Relay Bot Test",
        },
        expected: "/telegram/chats/8587455921__agent-relay-bot-test/messages/42/reactions/900.json",
      },
      {
        model: "TelegramCallbackQuery",
        record: { id: "callback-1", data: "demo:ok" },
        expected: "/telegram/callback-queries/callback-1.json",
      },
      {
        model: "TelegramInlineQuery",
        record: { id: "inline-1", query: "search" },
        expected: "/telegram/inline-queries/inline-1.json",
      },
      {
        model: "TelegramUpdate",
        record: { updateId: "1000", kind: "message" },
        expected: "/telegram/updates/1000.json",
      },
    ];

    for (const { model, record, expected } of cases) {
      const client = makeClient();
      await writeProviderRecord(client, record, telegramJob(model));
      assert.equal(client.writes[0]?.path, expected, model);
    }
  });

  it("deletes /notion/pages/<id>/content.md when a NotionPageContent record is tombstoned", async () => {
    const client = makeClient();
    const id = "3586800c-1c90-80eb-aa52-ea4d88eb32d5";
    await writeProviderRecord(
      client,
      {
        id,
        pageId: id,
        content: "",
        contentHash: "",
        lastEditedTime: "",
        _nango_metadata: { last_action: "DELETED" },
      },
      notionJob("NotionPageContent"),
    );
    assert.equal(client.writes.length, 0);
    assert.deepEqual(client.deletes, [`/notion/pages/${id}/content.md`]);
  });

  it("rejects Notion models that are mapped in the path-mapper but not yet wired in the writer", async () => {
    // `NotionBlock`, `NotionComment`, and `NotionDatabasePage` are recognized
    // by `normalizeNangoNotionModel` (forward-compat) but writing them
    // requires additional context (databaseId, pageId, etc.) that the writer
    // does not yet thread through. Keep the explicit rejection so we notice
    // when a sync starts emitting these models before the writer is ready.
    const client = makeClient();
    await assert.rejects(
      () =>
        writeProviderRecord(
          client,
          { id: "block-1" },
          notionJob("NotionBlock"),
        ),
      /not yet supported/i,
    );
    assert.equal(client.writes.length, 0);
  });
});

function confluenceJob(model: string): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "confluence",
    providerConfigKey: "confluence-relay",
    connectionId: "conn_test",
    syncName: `fetch-${model.replace(/^Confluence/, "").toLowerCase()}s`,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function jiraJob(model = "JiraIssue"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "jira",
    providerConfigKey: "jira-relay",
    connectionId: "conn_test",
    syncName: "fetch-issues",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function gitlabJob(model = "GitLabMergeRequest"): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "gitlab",
    providerConfigKey: "gitlab-relay",
    connectionId: "conn_test",
    syncName: "fetch-merge-requests",
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function makeReadingClient(): RelayfileWriteClient & {
  writes: RecordedWrite[];
  deletes: string[];
} {
  // Mirrors the cloud's relayfile client well enough to exercise the
  // aux-file index reconciliation (which short-circuits when readFile is
  // absent). Reads always 404 — fresh-workspace semantics.
  const base = makeClient();
  return {
    ...base,
    writes: base.writes,
    deletes: base.deletes,
    async readFile() {
      const err = new Error("not found") as Error & { status: number };
      err.status = 404;
      throw err;
    },
  };
}

describe("HubSpot record shapes and buckets", () => {
  it("routes writable HubSpot models and tombstones to adapter buckets", () => {
    const record = { id: "101", email: "ada@example.com" };
    assert.deepEqual(bucketByModel([record], "Contact", "hubspot"), {
      provider: "hubspot",
      buckets: { contacts: [record] },
    });
    assert.deepEqual(
      bucketByModel([{ id: "201", name: "Example Inc" }], "Company", "hubspot").buckets,
      { companies: [{ id: "201", name: "Example Inc" }] },
    );
    assert.deepEqual(
      bucketByModel([{ id: "301", name: "Expansion" }], "Deal", "hubspot").buckets,
      { deals: [{ id: "301", name: "Expansion" }] },
    );
    assert.deepEqual(
      bucketByModel([{ id: "401", subject: "Billing" }], "Ticket", "hubspot").buckets,
      { tickets: [{ id: "401", subject: "Billing" }] },
    );
    assert.deepEqual(bucketByModel([{ id: "o1" }], "Order", "hubspot").buckets, {});
    assert.deepEqual(bucketByModel([{ id: "p1" }], "Product", "hubspot").buckets, {});
    assert.deepEqual(bucketByModel([{ id: "u1" }], "User", "hubspot").buckets, {});
    assert.deepEqual(
      bucketByModel([buildDeletionRecord("101")], "Contact", "hubspot").buckets,
      { contacts: [{ id: "101", _deleted: true }] },
    );
  });

  it("keeps core and Nango HubSpot shape builders in parity", async () => {
    const contact = {
      id: "101",
      properties: {
        firstname: "Ada",
        lastname: "Lovelace",
        email: "ada@example.com",
        phone: "555",
        jobtitle: "Analyst",
        company: "Example",
        createdate: "2026-05-01T00:00:00.000Z",
        lastmodifieddate: "2026-05-02T00:00:00.000Z",
      },
    };
    assert.deepEqual(
      buildHubSpotContactRecord(contact),
      buildNangoHubSpotContactRecord(contact),
    );

    const company = {
      id: "201",
      properties: {
        name: "Example Inc",
        domain: "example.com",
        industry: "Software",
        city: "Oslo",
        state: "Oslo",
        country: "NO",
        phone: "555",
        website: "https://example.com",
        description: "Customer",
        createdate: "2026-05-01T00:00:00.000Z",
        hs_lastmodifieddate: "2026-05-02T00:00:00.000Z",
      },
    };
    assert.deepEqual(
      buildHubSpotCompanyRecord(company),
      buildNangoHubSpotCompanyRecord(company),
    );

    const deal = {
      id: "301",
      properties: {
        dealname: "Expansion",
        amount: "4200",
        closedate: "2026-06-01",
        dealstage: "closedwon",
        hubspot_owner_id: "owner-1",
        description: "Renewal",
        hs_lastmodifieddate: "2026-05-03T00:00:00.000Z",
      },
      associations: {
        companies: { results: [{ id: "201" }] },
        contacts: { results: [{ id: "101" }] },
      },
      updatedAt: "2026-05-03T00:00:00.000Z",
    };
    assert.deepEqual(
      await buildHubSpotDealRecord(deal),
      await buildNangoHubSpotDealRecord(deal),
    );

    const ticket = {
      id: "401",
      properties: {
        subject: "Billing",
        content: "Need help",
        hubspot_owner_id: "owner-1",
        hs_pipeline: "support",
        hs_pipeline_stage: "open",
        hs_category: "billing",
        hs_ticket_priority: "HIGH",
        createdate: "2026-05-01T00:00:00.000Z",
        hs_lastmodifieddate: "2026-05-04T00:00:00.000Z",
      },
    };
    assert.deepEqual(
      buildHubSpotTicketRecord(ticket),
      buildNangoHubSpotTicketRecord(ticket),
    );
  });

  it("writes HubSpot canonical record and by-id alias through adapter registry", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [{ id: "101", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" }],
      hubspotJob("Contact"),
    );
    assert.ok(client.writes.some((write) => write.path === "/hubspot/contacts/101.json"));
    assert.ok(client.writes.some((write) => write.path === "/hubspot/contacts/by-id/101.json"));
  });
});

describe("Docker Hub record buckets", () => {
  it("routes Docker Hub sync models and tombstones to materialization buckets", () => {
    const repository = { id: "khaliqgant/api", namespace: "khaliqgant", name: "api" };
    assert.deepEqual(
      bucketByModel([repository], "DockerHubRepository", "docker-hub"),
      {
        provider: "docker-hub",
        buckets: { repositories: [repository] },
      },
    );
    assert.deepEqual(
      bucketByModel(
        [{ id: "khaliqgant/api/latest", namespace: "khaliqgant", repository: "api", name: "latest" }],
        "DockerHubTag",
        "docker_hub-composio-relay",
      ).buckets,
      {
        tags: [
          {
            id: "khaliqgant/api/latest",
            namespace: "khaliqgant",
            repository: "api",
            name: "latest",
          },
        ],
      },
    );
    assert.deepEqual(
      bucketByModel([buildDeletionRecord("khaliqgant/api/hook-1")], "DockerHubWebhook", "docker-hub").buckets,
      { webhooks: [{ id: "khaliqgant/api/hook-1", _deleted: true, objectType: "webhook" }] },
    );
  });
});

describe("Reddit record buckets", () => {
  it("routes Reddit sync models and tombstones to materialization buckets", () => {
    const subreddit = {
      id: "agentrelay",
      name: "agentrelay",
      title: "Agent Relay",
    };
    assert.deepEqual(
      bucketByModel([subreddit], "RedditTrackedSubreddit", "reddit"),
      {
        provider: "reddit",
        buckets: { subreddits: [subreddit] },
      },
    );
    assert.deepEqual(
      bucketByModel(
        [{ id: "agentrelay/abc123", post_id: "abc123", subreddit: "agentrelay", title: "Launch" }],
        "RedditPost",
        "reddit-composio-relay",
      ).buckets,
      {
        posts: [
          {
            id: "agentrelay/abc123",
            post_id: "abc123",
            subreddit: "agentrelay",
            title: "Launch",
          },
        ],
      },
    );
    assert.deepEqual(
      bucketByModel([buildDeletionRecord("agentrelay/abc123")], "RedditPost", "reddit").buckets,
      { posts: [{ id: "agentrelay/abc123", _deleted: true, objectType: "post" }] },
    );
  });
});

// Variant of makeReadingClient that serves seeded JSON bodies for
// known paths and 404s for everything else. Used to exercise the
// previous-context-aware cleanup branches (rename, status transition,
// space move) which would otherwise be unreachable on a fresh workspace.
function makeSeededReadingClient(seed: Record<string, unknown>): RelayfileWriteClient & {
  writes: RecordedWrite[];
  deletes: string[];
} {
  const base = makeClient();
  return {
    ...base,
    writes: base.writes,
    deletes: base.deletes,
    async readFile(_workspaceId, path) {
      if (Object.prototype.hasOwnProperty.call(seed, path)) {
        return { content: JSON.stringify(seed[path]), revision: `rev:${path}` };
      }
      const err = new Error("not found") as Error & { status: number };
      err.status = 404;
      throw err;
    },
  };
}

function makeMutableReadingClient(seed: Record<string, string> = {}): RelayfileWriteClient & {
  writes: RecordedWrite[];
  deletes: string[];
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(seed));
  const writes: RecordedWrite[] = [];
  const deletes: string[] = [];
  return {
    writes,
    deletes,
    files,
    async writeFile(input) {
      writes.push({
        path: input.path,
        content: input.content,
        contentType: input.contentType,
      });
      files.set(input.path, input.content);
    },
    async deleteFile(input) {
      deletes.push(input.path);
      files.delete(input.path);
    },
    async readFile(_workspaceId, path) {
      if (files.has(path)) {
        return { content: files.get(path), revision: `rev:${path}` };
      }
      const err = new Error("not found") as Error & { status: number };
      err.status = 404;
      throw err;
    },
    async listTree(_workspaceId, options) {
      const root = options?.path?.replace(/\/$/u, "") ?? "";
      return {
        entries: [...files.keys()]
          .filter((path) => !root || path.startsWith(`${root}/`) || path === root)
          .map((path) => ({
            path,
            name: path.split("/").pop(),
            type: "file",
          })),
      };
    },
  };
}

function makeBulkMutableReadingClient(
  seed: Record<string, string> = {},
  options: {
    bulkErrors?: Array<{ path: string; code: string; message: string }>;
    bulkReject?: unknown;
    // Simulate the DO accepting the batch (202) but committing fewer rows than
    // sent without reporting them as per-file errors (relayfile#306).
    bulkSilentDrop?: number;
  } = {},
): RelayfileWriteClient & {
  writes: RecordedWrite[];
  deletes: string[];
  files: Map<string, string>;
  bulkCalls: RecordedBulkMutation[][];
} {
  const base = makeMutableReadingClient(seed);
  const bulkCalls: RecordedBulkMutation[][] = [];
  return {
    ...base,
    bulkCalls,
    async bulkWrite(input) {
      const files = input.files.map((file) => ({ ...file })) as RecordedBulkMutation[];
      bulkCalls.push(files);
      if (options.bulkReject) {
        throw options.bulkReject;
      }
      const failed = new Set((options.bulkErrors ?? []).map((error) => error.path));
      for (const file of files) {
        if (failed.has(file.path)) {
          continue;
        }
        if (file.op === "delete") {
          base.deletes.push(file.path);
          base.files.delete(file.path);
        } else {
          base.writes.push({
            path: file.path,
            content: file.content,
            contentType: file.contentType ?? "text/plain",
          });
          base.files.set(file.path, file.content);
        }
      }
      return {
        written: files.length - failed.size - (options.bulkSilentDrop ?? 0),
        errorCount: options.bulkErrors?.length ?? 0,
        errors: options.bulkErrors ?? [],
        correlationId: input.correlationId,
      };
    },
  };
}

function githubRepositoryRecord(owner: string, repo: string): Record<string, unknown> {
  return {
    id: `${owner}/${repo}`,
    name: repo,
    full_name: `${owner}/${repo}`,
    owner,
    repo,
    html_url: `https://github.com/${owner}/${repo}`,
    updated_at: "2026-05-01T00:00:00.000Z",
  };
}

function githubWebhookRepoJob() {
  return createWebhookSyncJob({
    workspaceId: "rw_test",
    connectionId: "conn_test",
    providerConfigKey: "github",
    provider: "github",
    syncName: "fetch-repositories",
    model: "repository",
  });
}

function errorWithStatus(status: number): Error & { status: number } {
  const error = new Error(`simulated ${status}`) as Error & { status: number };
  error.status = status;
  return error;
}

function errorWithResponseStatus(status: number): Error & {
  response: { status: number };
} {
  const error = new Error(`simulated response ${status}`) as Error & {
    response: { status: number };
  };
  error.response = { status };
  return error;
}

describe("toAuxiliaryEmitterClient read/write guard", () => {
  it("refuses to rewrite a path after a non-404 read failure", async () => {
    const writes: RecordedWrite[] = [];
    const shim = toAuxiliaryEmitterClient({
      async readFile() {
        throw errorWithStatus(500);
      },
      async writeFile(input) {
        writes.push({
          path: input.path,
          content: input.content,
          contentType: input.contentType,
        });
      },
    });

    assert.equal(
      await shim.readFile?.({ workspaceId: "rw_test", path: "/github/repos/_index.json" }),
      null,
    );
    await assert.rejects(
      shim.writeFile({
        workspaceId: "rw_test",
        path: "/github/repos/_index.json",
        content: "[]\n",
      }),
      /prior read of \/github\/repos\/_index\.json failed/,
    );
    assert.equal(writes.length, 0);
  });

  it("refuses to rewrite a path after a non-Error read failure", async () => {
    const writes: RecordedWrite[] = [];
    const shim = toAuxiliaryEmitterClient({
      async readFile() {
        throw undefined;
      },
      async writeFile(input) {
        writes.push({
          path: input.path,
          content: input.content,
          contentType: input.contentType,
        });
      },
    });

    assert.equal(
      await shim.readFile?.({ workspaceId: "rw_test", path: "/github/repos/_index.json" }),
      null,
    );
    await assert.rejects(
      shim.writeFile({
        workspaceId: "rw_test",
        path: "/github/repos/_index.json",
        content: "[]\n",
      }),
      /prior read of \/github\/repos\/_index\.json failed/,
    );
    assert.equal(writes.length, 0);
  });

  it("allows a write after a successful re-read clears the guard", async () => {
    const writes: RecordedWrite[] = [];
    let readAttempts = 0;
    const shim = toAuxiliaryEmitterClient({
      async readFile() {
        readAttempts += 1;
        if (readAttempts === 1) {
          throw errorWithStatus(500);
        }
        return { content: "[{\"id\":\"existing\"}]\n", revision: "rev-1" };
      },
      async writeFile(input) {
        writes.push({
          path: input.path,
          content: input.content,
          contentType: input.contentType,
        });
      },
    });

    assert.equal(
      await shim.readFile?.({ workspaceId: "rw_test", path: "/github/repos/_index.json" }),
      null,
    );
    assert.deepEqual(
      await shim.readFile?.({ workspaceId: "rw_test", path: "/github/repos/_index.json" }),
      { content: "[{\"id\":\"existing\"}]\n" },
    );
    await shim.writeFile({
      workspaceId: "rw_test",
      path: "/github/repos/_index.json",
      content: "[{\"id\":\"existing\"}]\n",
    });

    assert.equal(writes.length, 1);
  });

  it("does not block non-index alias rewrites after a failed prior-alias read", async () => {
    const writes: RecordedWrite[] = [];
    const aliasPath = "/github/repos/acme__api/issues/by-id/42.json";
    const shim = toAuxiliaryEmitterClient({
      async readFile(_workspaceId, path) {
        if (path === aliasPath) {
          throw errorWithStatus(500);
        }
        throw errorWithStatus(404);
      },
      async writeFile(input) {
        writes.push({
          path: input.path,
          content: input.content,
          contentType: input.contentType,
        });
      },
    });

    assert.equal(
      await shim.readFile?.({ workspaceId: "rw_test", path: aliasPath }),
      null,
    );
    await shim.writeFile({
      workspaceId: "rw_test",
      path: aliasPath,
      content: "{\"id\":\"42\"}\n",
    });

    assert.deepEqual(
      writes.map((write) => write.path),
      [aliasPath],
    );
  });
});

describe("writeXAuxiliaryFiles (via writeBatchToRelayfile)", () => {
  it("preserves Linear team and project indexes across separate model syncs", async () => {
    const client = makeMutableReadingClient();

    await writeBatchToRelayfile(
      client,
      [{
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        updatedAt: "2026-05-10T10:00:00.000Z",
      }],
      linearJob("LinearTeam"),
    );

    await writeBatchToRelayfile(
      client,
      [{
        id: "project-1",
        name: "Webhook Reliability",
        updatedAt: "2026-05-11T10:00:00.000Z",
      }],
      linearJob("LinearProject"),
    );

    await writeBatchToRelayfile(
      client,
      [{
        id: "issue-1",
        identifier: "ENG-1",
        title: "Keep Linear indexes visible",
        state_name: "Todo",
        updatedAt: "2026-05-12T10:00:00.000Z",
      }],
      linearJob("LinearIssue"),
    );

    const teamsIndex = JSON.parse(
      client.files.get("/linear/teams/_index.json") ?? "null",
    ) as Array<Record<string, unknown>>;
    const projectsIndex = JSON.parse(
      client.files.get("/linear/projects/_index.json") ?? "null",
    ) as Array<Record<string, unknown>>;

    assert.deepEqual(teamsIndex, [{
      id: "team-1",
      title: "Engineering",
      updated: "2026-05-10T10:00:00.000Z",
    }]);
    assert.deepEqual(projectsIndex, [{
      id: "project-1",
      title: "Webhook Reliability",
      updated: "2026-05-11T10:00:00.000Z",
    }]);
  });

  it("backfills empty Linear team, project, and label indexes from canonical files on provider refresh", async () => {
    const client = makeMutableReadingClient({
      "/linear/teams/_index.json": "[]\n",
      "/linear/teams/team-1.json": JSON.stringify({
        provider: "linear",
        objectType: "team",
        objectId: "team-1",
        payload: {
          id: "team-1",
          key: "ENG",
          name: "Engineering",
          updatedAt: "2026-05-10T10:00:00.000Z",
        },
      }),
      "/linear/projects/_index.json": "[]\n",
      "/linear/projects/project-1/meta.json": JSON.stringify({
        provider: "linear",
        objectType: "project",
        objectId: "project-1",
        payload: {
          id: "project-1",
          name: "Webhook Reliability",
          updatedAt: "2026-05-11T10:00:00.000Z",
        },
      }),
      "/linear/labels/_index.json": "[]\n",
      "/linear/labels/label-1.json": JSON.stringify({
        provider: "linear",
        objectType: "label",
        objectId: "label-1",
        payload: {
          id: "label-1",
          name: "Escalation",
          updatedAt: "2026-05-12T10:00:00.000Z",
        },
      }),
    });
    client.listTree = async (_workspaceId, options) => {
      const root = options?.path?.replace(/\/$/u, "") ?? "";
      return {
        entries: [...client.files.keys()]
          .filter((path) => path.startsWith(`${root}/`))
          .map((path) => ({
            path,
            name: path.split("/").pop(),
            type: "file",
          })),
      };
    };

    await ensureProviderDiscoveryContractReport(client, "linear", "rw_test");

    assert.deepEqual(
      JSON.parse(client.files.get("/linear/teams/_index.json") ?? "null"),
      [{
        id: "team-1",
        title: "Engineering",
        updated: "2026-05-10T10:00:00.000Z",
      }],
    );
    assert.deepEqual(
      JSON.parse(client.files.get("/linear/projects/_index.json") ?? "null"),
      [{
        id: "project-1",
        title: "Webhook Reliability",
        updated: "2026-05-11T10:00:00.000Z",
      }],
    );
    assert.deepEqual(
      JSON.parse(client.files.get("/linear/labels/_index.json") ?? "null"),
      [{
        id: "label-1",
        title: "Escalation",
        updated: "2026-05-12T10:00:00.000Z",
      }],
    );
  });

  it("emits X layout, indexes, aliases, and search result pointers", async () => {
    const client = makeMutableReadingClient();
    const requestedAt = "2026-05-17T10:00:00.000Z";

    await writeBatchToRelayfile(
      client,
      [{
        id: "search-1",
        run: {
          id: "search-1",
          title: "Agent Relay",
          query: "agent relay",
          mode: "recent",
          requestedAt,
          resultCount: 1,
          costEstimate: {
            posts: 1,
            users: 1,
            postReadUnitUsd: 0.005,
            userReadUnitUsd: 0.01,
            estimatedUsd: 0.015,
            cappedByBudget: false,
            cappedByMaxResults: false,
          },
          source: {
            provider: "x",
            endpoint: "/2/tweets/search/recent",
            docs: "https://docs.x.com/x-api/posts/search/introduction",
          },
        },
        posts: [{
          id: "post-1",
          text: "Relayfile social search",
          author_id: "user-1",
          conversation_id: "conversation-1",
          created_at: requestedAt,
        }],
        users: [{ id: "user-1", username: "agentrelay", name: "Agent Relay" }],
        results: [{
          id: "search-1:post-1",
          searchId: "search-1",
          postId: "post-1",
          rank: 1,
          matchedAt: requestedAt,
          canonicalPath: "/x/posts/relayfile-social-search__post-1.json",
          query: "agent relay",
        }],
      }],
      xJob("XSearchBundle"),
    );

    assert.ok(client.writes.some((write) => write.path === "/x/LAYOUT.md"));
    assert.ok(client.writes.some((write) => write.path === "/x/searches/_index.json"));
    assert.ok(client.writes.some((write) => write.path === "/x/searches/by-id/search-1.json"));
    assert.ok(client.writes.some((write) => write.path === "/x/posts/by-query/search-1/post-1.json"));
    assert.ok(client.writes.some((write) => write.path === "/x/searches/search-1__agent-relay/results/post-1.json"));
  });
});

describe("writeConfluenceAuxiliaryFiles (via writeBatchToRelayfile)", () => {
  it("emits a curated /confluence/pages/_index.json row per synced page", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "page-1",
          title: "Onboarding Checklist",
          spaceId: "SP1",
          status: "current",
          version: { createdAt: "2026-05-10T10:00:00.000Z" },
        },
        {
          id: "page-2",
          title: "Q2 Roadmap",
          spaceId: "SP1",
          status: "current",
          version: { createdAt: "2026-05-09T10:00:00.000Z" },
        },
      ],
      confluenceJob("ConfluencePage"),
    );

    const indexWrite = client.writes.find(
      (w) => w.path === "/confluence/pages/_index.json",
    );
    assert.ok(indexWrite, "expected pages _index.json to be written");
    const rows = JSON.parse(indexWrite!.content) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    const row = rows.find((r) => r.id === "page-1")!;
    assert.equal(row.title, "Onboarding Checklist");
    assert.equal(row.spaceId, "SP1");
    assert.equal(row.updated, "2026-05-10T10:00:00.000Z");
  });

  it("writes canonical page records under a __id slug path", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "12345",
          title: "Acme Q2 Kickoff",
          spaceId: "SP1",
          status: "current",
        },
      ],
      confluenceJob("ConfluencePage"),
    );
    const canonical = client.writes.find(
      (w) =>
        w.path.startsWith("/confluence/spaces/SP1/pages/") &&
        w.path.endsWith(".json") &&
        !w.path.includes("/by-"),
    );
    assert.ok(canonical, "canonical confluence page path missing");
    assert.match(canonical!.path, /\/[^/]+__12345\.json$/);
  });

  it("emits by-title and by-id alias files when title is present", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "page-7",
          title: "Architecture",
          spaceId: "SP1",
          status: "current",
        },
      ],
      confluenceJob("ConfluencePage"),
    );
    const byId = client.writes.find((w) =>
      w.path.includes("/confluence/pages/by-id/"),
    );
    const byTitle = client.writes.find((w) =>
      w.path.includes("/confluence/pages/by-title/"),
    );
    const byState = client.writes.find((w) =>
      w.path.includes("/confluence/pages/by-state/"),
    );
    assert.ok(byId, "by-id alias missing");
    assert.ok(byTitle, "by-title alias missing");
    assert.ok(byState, "by-state alias missing");
  });

  it("emits a /confluence/spaces/_index.json row per synced space", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "SP1",
          key: "SP1",
          name: "Engineering",
          type: "global",
          updatedAt: "2026-05-10T10:00:00.000Z",
        },
      ],
      confluenceJob("ConfluenceSpace"),
    );
    const indexWrite = client.writes.find(
      (w) => w.path === "/confluence/spaces/_index.json",
    );
    assert.ok(indexWrite, "expected spaces _index.json to be written");
    const rows = JSON.parse(indexWrite!.content) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "SP1");
    assert.equal(rows[0]!.key, "SP1");
    assert.equal(rows[0]!.title, "Engineering");
  });
});

describe("writeJiraAuxiliaryFiles (via writeBatchToRelayfile)", () => {
  it("emits a curated /jira/issues/_index.json row per synced issue", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "10001",
          key: "ENG-1",
          fields: {
            summary: "Fix login bug",
            status: { name: "In Progress" },
            updated: "2026-05-10T10:00:00.000Z",
          },
        },
      ],
      jiraJob("JiraIssue"),
    );
    const indexWrite = client.writes.find(
      (w) => w.path === "/jira/issues/_index.json",
    );
    assert.ok(indexWrite, "expected issues _index.json to be written");
    const rows = JSON.parse(indexWrite!.content) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "10001");
    assert.equal(rows[0]!.key, "ENG-1");
    assert.equal(rows[0]!.title, "Fix login bug");
    assert.equal(rows[0]!.state, "In Progress");
  });

  it("emits by-key, by-id, and by-state alias files for jira issues", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "10002",
          key: "ENG-2",
          fields: {
            summary: "Refactor auth",
            status: { name: "Done" },
          },
        },
      ],
      jiraJob("JiraIssue"),
    );
    const byId = client.writes.find((w) =>
      w.path.includes("/jira/issues/by-id/"),
    );
    const byKey = client.writes.find((w) =>
      w.path.includes("/jira/issues/by-key/"),
    );
    const byState = client.writes.find((w) =>
      w.path.includes("/jira/issues/by-state/"),
    );
    assert.ok(byId, "jira by-id alias missing");
    assert.ok(byKey, "jira by-key alias missing");
    assert.ok(byState, "jira by-state alias missing");
    assert.match(byKey!.path, /by-key\/ENG-2\.json$/);
  });

  it("writes jira issue canonical record under a __id slug path", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "10003",
          key: "ENG-3",
          fields: { summary: "Tighten retry policy" },
        },
      ],
      jiraJob("JiraIssue"),
    );
    const canonical = client.writes.find(
      (w) =>
        w.path.startsWith("/jira/issues/") &&
        !w.path.includes("/by-") &&
        !w.path.endsWith("_index.json"),
    );
    assert.ok(canonical, "canonical jira issue path missing");
    assert.match(canonical!.path, /\/[^/]+__10003\.json$/);
  });
});

describe("writeGitLabRecord and auxiliary files", () => {
  it("maps GitLab tombstones using adapter identity fields", () => {
    const mergeRequestBuckets = bucketByModel(
      [
        {
          id: "9001",
          iid: "7",
          project_path: "acme/api",
          title: "Ship relayfile state updates",
          state: "merged",
          _nango_metadata: { last_action: "deleted" },
        },
      ],
      "GitLabMergeRequest",
      "gitlab",
    );
    assert.equal(mergeRequestBuckets.provider, "gitlab");
    assert.deepEqual(mergeRequestBuckets.buckets.mergeRequests, [
      {
        iid: "7",
        project_path: "acme/api",
        title: "Ship relayfile state updates",
        state: "merged",
        _deleted: true,
      },
    ]);

    const issueBuckets = bucketByModel(
      [
        {
          id: "3001",
          iid: 17,
          project: { path_with_namespace: "acme/api" },
          title: "Fix sync state",
          _nango_metadata: { last_action: "deleted" },
        },
      ],
      "GitLabIssue",
      "gitlab",
    );
    assert.equal(issueBuckets.provider, "gitlab");
    assert.deepEqual(issueBuckets.buckets.issues, [
      {
        iid: "17",
        project: { path_with_namespace: "acme/api" },
        title: "Fix sync state",
        _deleted: true,
      },
    ]);

    const commitBuckets = bucketByModel(
      [
        {
          id: "row-1",
          sha: "abc123",
          project_path: "acme/api",
          title: "Wire GitLab relayfile",
          _nango_metadata: { last_action: "deleted" },
        },
      ],
      "GitLabCommit",
      "gitlab",
    );
    assert.equal(commitBuckets.provider, "gitlab");
    assert.deepEqual(commitBuckets.buckets.commits, [
      {
        sha: "abc123",
        project_path: "acme/api",
        title: "Wire GitLab relayfile",
        _deleted: true,
      },
    ]);

    const tagBuckets = bucketByModel(
      [
        {
          id: "20:v1.0.0",
          ref: "v1.0.0",
          project_path: "acme/api",
          _nango_metadata: { last_action: "deleted" },
        },
      ],
      "GitLabTag",
      "gitlab",
    );
    assert.equal(tagBuckets.provider, "gitlab");
    assert.deepEqual(tagBuckets.buckets.tags, [
      {
        ref: "v1.0.0",
        project_path: "acme/api",
        _deleted: true,
      },
    ]);

    const pipelineBuckets = bucketByModel(
      [
        {
          id: "9001",
          iid: "17",
          project_path: "acme/api",
          ref: "main",
          status: "failed",
          _nango_metadata: { last_action: "deleted" },
        },
      ],
      "GitLabPipeline",
      "gitlab",
    );
    assert.equal(pipelineBuckets.provider, "gitlab");
    assert.deepEqual(pipelineBuckets.buckets.pipelines, [
      {
        id: "9001",
        project_path: "acme/api",
        ref: "main",
        status: "failed",
        _deleted: true,
      },
    ]);

    const deploymentBuckets = bucketByModel(
      [
        {
          id: "501",
          iid: "12",
          project_path: "acme/api",
          status: "success",
          _nango_metadata: { last_action: "deleted" },
        },
      ],
      "GitLabDeployment",
      "gitlab",
    );
    assert.equal(deploymentBuckets.provider, "gitlab");
    assert.deepEqual(deploymentBuckets.buckets.deployments, [
      {
        id: "501",
        project_path: "acme/api",
        status: "success",
        _deleted: true,
      },
    ]);
  });

  it("writes GitLab project metadata, by-id alias, and projects index", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "20",
          name: "api",
          name_with_namespace: "Acme / API",
          path_with_namespace: "acme/api",
          updated_at: "2026-05-15T09:00:00.000Z",
        },
      ],
      gitlabJob("GitLabProject"),
    );

    assert.ok(client.writes.some((w) => w.path === "/gitlab/_index.json"));
    assert.ok(
      client.writes.some((w) => w.path === "/gitlab/projects/acme/api/meta.json"),
      "canonical GitLab project metadata missing",
    );
    assert.ok(
      client.writes.some((w) => w.path === "/gitlab/projects/by-id/20.json"),
      "GitLab project by-id alias missing",
    );
    const indexWrite = client.writes.find(
      (w) => w.path === "/gitlab/projects/_index.json",
    );
    assert.ok(indexWrite, "GitLab projects index missing");
    assert.deepEqual(JSON.parse(indexWrite!.content), [
      {
        id: "acme/api",
        title: "Acme / API",
        updated: "2026-05-15T09:00:00.000Z",
      },
    ]);
  });

  it("uses shared provider timestamp keys for cloud-owned GitLab project indexes", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "20",
          name: "api",
          name_with_namespace: "Acme / API",
          path_with_namespace: "acme/api",
          modified_at: "2026-05-16T09:00:00.000Z",
        },
      ],
      gitlabJob("GitLabProject"),
    );

    const indexWrite = client.writes.find(
      (w) => w.path === "/gitlab/projects/_index.json",
    );
    assert.ok(indexWrite, "GitLab projects index missing");
    assert.deepEqual(JSON.parse(indexWrite!.content), [
      {
        id: "acme/api",
        title: "Acme / API",
        updated: "2026-05-16T09:00:00.000Z",
      },
    ]);
  });

  it("merges GitLab project rows into the existing projects index", async () => {
    const client = makeMutableReadingClient({
      "/gitlab/projects/_index.json": JSON.stringify([
        {
          id: "acme/web",
          title: "Acme / Web",
          updated: "2026-05-14T09:00:00.000Z",
        },
      ]),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "20",
          name: "api",
          name_with_namespace: "Acme / API",
          path_with_namespace: "acme/api",
          updated_at: "2026-05-15T09:00:00.000Z",
        },
      ],
      gitlabJob("GitLabProject"),
    );

    assert.equal(result.errors, 0);
    const rows = JSON.parse(
      client.files.get("/gitlab/projects/_index.json") ?? "[]",
    ) as Array<{ id: string; title: string; updated: string }>;
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.id === "acme/web"));
    assert.ok(
      rows.some(
        (row) =>
          row.id === "acme/api" &&
          row.title === "Acme / API" &&
          row.updated === "2026-05-15T09:00:00.000Z",
      ),
    );
  });

  it("refuses to shrink GitLab projects index after a failed read", async () => {
    const indexPath = "/gitlab/projects/_index.json";
    const existingIndex = JSON.stringify([
      {
        id: "acme/web",
        title: "Acme / Web",
        updated: "2026-05-14T09:00:00.000Z",
      },
      {
        id: "acme/mobile",
        title: "Acme / Mobile",
        updated: "2026-05-13T09:00:00.000Z",
      },
    ]);
    const client = makeMutableReadingClient({
      [indexPath]: existingIndex,
    });

    const originalReadFile = client.readFile!.bind(client);
    client.readFile = async (workspaceId, path, correlationId, signal) => {
      if (path === indexPath) {
        const err = new Error("simulated transient GitLab index read failure") as Error & {
          status: number;
        };
        err.status = 503;
        throw err;
      }
      return originalReadFile(workspaceId, path, correlationId, signal);
    };

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "20",
          name: "api",
          name_with_namespace: "Acme / API",
          path_with_namespace: "acme/api",
          updated_at: "2026-05-15T09:00:00.000Z",
        },
      ],
      gitlabJob("GitLabProject"),
    );

    assert.ok(
      result.errors > 0,
      "the refused GitLab projects index write should surface as a sync error",
    );
    assert.equal(
      client.files.get(indexPath),
      existingIndex,
      "existing GitLab projects index must not be replaced by a partial baseline after a read failure",
    );
    assert.ok(
      client.files.has("/gitlab/projects/acme/api/meta.json"),
      "canonical GitLab project metadata should still be written",
    );
    assert.ok(
      client.files.has("/gitlab/projects/by-id/20.json"),
      "GitLab project by-id alias should still be written",
    );
  });

  it("treats a null GitLab projects index read as empty baseline", async () => {
    const indexPath = "/gitlab/projects/_index.json";
    const client = makeMutableReadingClient();
    const originalReadFile = client.readFile!.bind(client);
    client.readFile = async (workspaceId, path, correlationId, signal) => {
      if (path === indexPath) {
        return null as never;
      }
      return originalReadFile(workspaceId, path, correlationId, signal);
    };

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "20",
          name: "api",
          name_with_namespace: "Acme / API",
          path_with_namespace: "acme/api",
          updated_at: "2026-05-15T09:00:00.000Z",
        },
      ],
      gitlabJob("GitLabProject"),
    );

    assert.equal(result.errors, 0);
    const rows = JSON.parse(client.files.get(indexPath) ?? "[]") as Array<{
      id: string;
    }>;
    assert.deepEqual(rows.map((row) => row.id), ["acme/api"]);
  });

  it("deletes GitLab project metadata using the by-id alias when tombstones only carry id", async () => {
    const client = makeMutableReadingClient({
      "/gitlab/projects/acme/api/meta.json": JSON.stringify({
        id: "20",
        path_with_namespace: "acme/api",
        name_with_namespace: "Acme / API",
      }),
      "/gitlab/projects/by-id/20.json": JSON.stringify({
        id: "20",
        projectPath: "acme/api",
        canonicalPath: "/gitlab/projects/acme/api/meta.json",
        title: "Acme / API",
      }),
      "/gitlab/projects/_index.json": JSON.stringify([
        {
          id: "acme/api",
          title: "Acme / API",
          updated: "2026-05-15T09:00:00.000Z",
        },
      ]),
    });

    await writeBatchToRelayfile(
      client,
      [{ id: "20", _nango_metadata: { last_action: "DELETED" } }],
      gitlabJob("GitLabProject"),
    );

    assert.ok(client.deletes.includes("/gitlab/projects/acme/api/meta.json"));
    assert.ok(client.deletes.includes("/gitlab/projects/by-id/20.json"));
    const indexWrite = client.writes.find(
      (w) => w.path === "/gitlab/projects/_index.json",
    );
    assert.ok(indexWrite, "GitLab projects index rewrite missing");
    assert.deepEqual(JSON.parse(indexWrite!.content), []);
    assert.equal(client.files.get("/gitlab/projects/_index.json"), "[]\n");
  });

  it("writes GitLab merge request records under the adapter path and emits indexes", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "9001",
          iid: "7",
          project_id: "20",
          project_path: "acme/api",
          title: "Ship relayfile state updates",
          state: "merged",
          web_url: "https://gitlab.com/acme/api/-/merge_requests/7",
          updated_at: "2026-05-15T10:00:00.000Z",
        },
      ],
      gitlabJob("GitLabMergeRequest"),
    );

    const canonical = client.writes.find(
      (w) =>
        w.path ===
        "/gitlab/projects/acme/api/merge_requests/7__ship-relayfile-state-updates/meta.json",
    );
    assert.ok(canonical, "canonical GitLab MR write missing");
    const indexWrite = client.writes.find(
      (w) => w.path === "/gitlab/projects/acme/api/merge_requests/_index.json",
    );
    assert.ok(indexWrite, "GitLab MR index write missing");
    const rows = JSON.parse(indexWrite!.content) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      {
        id: "7",
        title: "Ship relayfile state updates",
        updated: "2026-05-15T10:00:00.000Z",
        iid: 7,
        state: "merged",
      },
    ]);
  });

  it("deletes GitLab merge request metadata when tombstones retain project context", async () => {
    const canonicalPath =
      "/gitlab/projects/acme/api/merge_requests/7__ship-relayfile-state-updates/meta.json";
    const byIdPath = "/gitlab/projects/acme/api/merge_requests/by-id/7.json";
    const byTitlePath =
      "/gitlab/projects/acme/api/merge_requests/by-title/ship-relayfile-state-updates__7.json";
    const indexPath = "/gitlab/projects/acme/api/merge_requests/_index.json";
    const client = makeSeededReadingClient({
      [canonicalPath]: {
        id: "9001",
        iid: "7",
        project_path: "acme/api",
        title: "Ship relayfile state updates",
      },
      [byIdPath]: {
        id: "7",
        canonicalPath,
        title: "Ship relayfile state updates",
      },
      [byTitlePath]: {
        id: "7",
        canonicalPath,
        title: "Ship relayfile state updates",
      },
      [indexPath]: [
        {
          id: "7",
          title: "Ship relayfile state updates",
          updated: "2026-05-15T10:00:00.000Z",
          iid: 7,
        },
      ],
    });

    await writeBatchToRelayfile(
      client,
      [
        {
          id: "9001",
          iid: "7",
          project_path: "acme/api",
          title: "Ship relayfile state updates",
          _nango_metadata: { last_action: "deleted" },
        },
      ],
      gitlabJob("GitLabMergeRequest"),
    );

    assert.ok(
      client.deletes.includes(canonicalPath),
      `expected GitLab MR canonical delete; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(byIdPath),
      `expected GitLab MR by-id delete; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(byTitlePath),
      `expected GitLab MR by-title delete; got ${JSON.stringify(client.deletes)}`,
    );
    assert.equal(
      client.writes.some((write) => write.path === canonicalPath),
      false,
      "GitLab tombstone should not be re-written during auxiliary emission",
    );
    const indexWrite = client.writes.find((write) => write.path === indexPath);
    assert.deepEqual(indexWrite ? JSON.parse(indexWrite.content) : null, []);
  });

  it("skips stale GitLab title updates before they can resurrect old canonical paths", async () => {
    const currentCanonicalPath =
      "/gitlab/projects/acme/api/issues/17__current-title/meta.json";
    const oldCanonicalPath =
      "/gitlab/projects/acme/api/issues/17__old-title/meta.json";
    const byIdPath = "/gitlab/projects/acme/api/issues/by-id/17.json";
    const indexPath = "/gitlab/projects/acme/api/issues/_index.json";
    const client = makeSeededReadingClient({
      [currentCanonicalPath]: {
        id: "3001",
        iid: "17",
        project_path: "acme/api",
        title: "Current title",
        updated_at: "2026-05-15T10:00:00.000Z",
      },
      [byIdPath]: {
        id: "17",
        canonicalPath: currentCanonicalPath,
        title: "Current title",
      },
      [indexPath]: [
        {
          id: "17",
          title: "Current title",
          updated: "2026-05-15T10:00:00.000Z",
          iid: 17,
        },
      ],
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "3001",
          iid: "17",
          project_path: "acme/api",
          title: "Old title",
          updated_at: "2026-05-14T10:00:00.000Z",
        },
      ],
      gitlabJob("GitLabIssue"),
    );

    assert.deepEqual(result, { written: 0, deleted: 0, errors: 0 });
    assert.equal(
      client.writes.some((write) => write.path === oldCanonicalPath),
      false,
      "stale GitLab title update should not write the old canonical path",
    );
    assert.deepEqual(client.deletes, []);
  });

  it("removes stale GitLab deployment status aliases before canonical overwrite hides prior status", async () => {
    const canonicalPath = "/gitlab/projects/acme/api/deployments/501.json";
    const runningAliasPath = "/gitlab/projects/acme/api/deployments/by-status/running/501.json";
    const client = makeSeededReadingClient({
      [canonicalPath]: {
        id: "501",
        project_path: "acme/api",
        status: "running",
        updated_at: "2026-05-15T10:00:00.000Z",
      },
      [runningAliasPath]: {
        id: "501",
        canonicalPath,
        status: "running",
      },
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "501",
          project_path: "acme/api",
          status: "success",
          updated_at: "2026-05-15T10:05:00.000Z",
        },
      ],
      gitlabJob("GitLabDeployment"),
    );

    assert.equal(result.errors, 0);
    assert.ok(
      client.deletes.includes(runningAliasPath),
      `expected stale deployment status alias delete; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.writes.some((write) => write.path === "/gitlab/projects/acme/api/deployments/by-status/success/501.json"),
      "expected new deployment status alias write",
    );
  });

  it("removes stale GitLab pipeline status aliases before canonical overwrite hides prior status", async () => {
    const canonicalPath = "/gitlab/projects/acme/api/pipelines/9001__main/meta.json";
    const runningAliasPath = "/gitlab/projects/acme/api/pipelines/by-status/running/9001.json";
    const client = makeSeededReadingClient({
      [canonicalPath]: {
        id: "9001",
        project_path: "acme/api",
        ref: "main",
        status: "running",
        updated_at: "2026-05-15T10:00:00.000Z",
      },
      [runningAliasPath]: {
        id: "9001",
        canonicalPath,
        ref: "main",
        status: "running",
      },
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "9001",
          project_path: "acme/api",
          ref: "main",
          status: "failed",
          updated_at: "2026-05-15T10:05:00.000Z",
        },
      ],
      gitlabJob("GitLabPipeline"),
    );

    assert.equal(result.errors, 0);
    assert.ok(
      client.deletes.includes(runningAliasPath),
      `expected stale pipeline status alias delete; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.writes.some((write) => write.path === "/gitlab/projects/acme/api/pipelines/by-status/failed/9001.json"),
      "expected new pipeline status alias write",
    );
  });

  it("removes prior GitLab deployment status aliases for tombstones that omit status", async () => {
    const canonicalPath = "/gitlab/projects/acme/api/deployments/501.json";
    const runningAliasPath = "/gitlab/projects/acme/api/deployments/by-status/running/501.json";
    const client = makeSeededReadingClient({
      [canonicalPath]: {
        id: "501",
        project_path: "acme/api",
        status: "running",
        updated_at: "2026-05-15T10:00:00.000Z",
      },
      [runningAliasPath]: {
        id: "501",
        canonicalPath,
        status: "running",
      },
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "501",
          project_path: "acme/api",
          _nango_metadata: {
            last_action: "deleted",
            deleted_at: "2026-05-15T10:05:00.000Z",
          },
        },
      ],
      gitlabJob("GitLabDeployment"),
    );

    assert.equal(result.errors, 0);
    assert.ok(
      client.deletes.includes(runningAliasPath),
      `expected tombstone to delete prior deployment status alias; got ${JSON.stringify(client.deletes)}`,
    );
  });

  it("treats already-missing GitLab tombstone deletes as idempotent across canonical and auxiliary cleanup", async () => {
    const canonicalPath =
      "/gitlab/projects/acme/api/issues/17__fix-sync-state/meta.json";
    const byIdPath = "/gitlab/projects/acme/api/issues/by-id/17.json";
    const client = makeSeededReadingClient({
      [byIdPath]: {
        id: "17",
        canonicalPath,
        title: "Fix sync state",
        state: "opened",
      },
    });
    client.deleteFile = async (input) => {
      if (input.path === canonicalPath) {
        const err = new Error("not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      client.deletes.push(input.path);
    };

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "3001",
          iid: "17",
          project_path: "acme/api",
          title: "Fix sync state",
          state: "closed",
          _nango_metadata: { last_action: "deleted" },
        },
      ],
      gitlabJob("GitLabIssue"),
    );

    assert.equal(result.errors, 0);
    const shimDelete = toAuxiliaryEmitterClient(client).deleteFile;
    assert.ok(shimDelete);
    await assert.doesNotReject(
      shimDelete({
        workspaceId: "rw_test",
        path: canonicalPath,
      }),
      "auxiliary cleanup should also tolerate an already-missing canonical delete",
    );
  });

  it("writes GitLab issue and commit records to GitLab project paths", async () => {
    const client = makeClient();
    await writeProviderRecord(
      client,
      {
        id: "3001",
        iid: "17",
        project_path: "acme/api",
        title: "Fix sync state",
        state: "closed",
      },
      gitlabJob("GitLabIssue"),
    );
    await writeProviderRecord(
      client,
      {
        id: "abc123",
        project_path: "acme/api",
        title: "Wire GitLab relayfile",
      },
      gitlabJob("GitLabCommit"),
    );

    assert.equal(
      client.writes[0]?.path,
      "/gitlab/projects/acme/api/issues/17__fix-sync-state/meta.json",
    );
    assert.equal(
      client.writes[1]?.path,
      "/gitlab/projects/acme/api/commits/abc123__wire-gitlab-relayfile/meta.json",
    );
  });

  it("writes GitLab pipeline, job, deployment, and tag records to adapter paths", async () => {
    const client = makeClient();
    await writeProviderRecord(
      client,
      {
        id: "9001",
        iid: "17",
        project_path: "acme/api",
        ref: "main",
        status: "failed",
      },
      gitlabJob("GitLabPipeline"),
    );
    await writeProviderRecord(
      client,
      {
        id: "101",
        pipeline_id: "9001",
        project_path: "acme/api",
        ref: "main",
        status: "failed",
      },
      gitlabJob("GitLabPipelineJob"),
    );
    await writeProviderRecord(
      client,
      {
        id: "501",
        iid: "12",
        project_path: "acme/api",
        status: "success",
      },
      gitlabJob("GitLabDeployment"),
    );
    await writeProviderRecord(
      client,
      {
        id: "20:v1.0.0",
        ref: "v1.0.0",
        project_path: "acme/api",
      },
      gitlabJob("GitLabTag"),
    );
    await writeProviderRecord(
      client,
      {
        id: "20:refs/tags/release/foo__bar",
        ref: "refs/tags/release/foo__bar",
        name: "release/foo__bar",
        project_path: "acme/api",
      },
      gitlabJob("GitLabTag"),
    );

    assert.equal(
      client.writes[0]?.path,
      "/gitlab/projects/acme/api/pipelines/9001__main/meta.json",
    );
    assert.equal(
      client.writes[1]?.path,
      "/gitlab/projects/acme/api/pipelines/9001__main/jobs/101.json",
    );
    assert.equal(client.writes[2]?.path, "/gitlab/projects/acme/api/deployments/501.json");
    assert.equal(client.writes[3]?.path, "/gitlab/projects/acme/api/tags/v1-0-0__v1.0.0.json");
    assert.equal(client.writes[4]?.path, "/gitlab/projects/acme/api/tags/release-foo-bar__release%2Ffoo__bar.json");
  });

  it("deletes GitLab tag pushes using the same bare-ref path as tag sync records", async () => {
    const canonicalPath = "/gitlab/projects/acme/api/tags/release-foo-bar__release%2Ffoo__bar.json";
    const aliasPath = "/gitlab/projects/acme/api/tags/by-ref/release-foo-bar__release%2Ffoo__bar.json";
    const legacyCanonicalPath = "/gitlab/projects/acme/api/tags/release/foo__bar.json";
    const legacyAliasPath = "/gitlab/projects/acme/api/tags/by-ref/release/foo__bar.json";
    const client = makeSeededReadingClient({
      [canonicalPath]: { ref: "release/foo__bar", project_path: "acme/api" },
      [aliasPath]: { ref: "release/foo__bar", canonicalPath },
      [legacyCanonicalPath]: { ref: "release/foo__bar", project_path: "acme/api" },
      [legacyAliasPath]: { ref: "release/foo__bar", canonicalPath: legacyCanonicalPath },
    });

    await writeBatchToRelayfile(
      client,
      [
        {
          id: "20:refs/tags/release/foo__bar",
          ref: "refs/tags/release/foo__bar",
          name: "release/foo__bar",
          project_path: "acme/api",
          _nango_metadata: { last_action: "deleted" },
        },
      ],
      gitlabJob("GitLabTag"),
    );

    assert.ok(
      client.deletes.includes(canonicalPath),
      `expected bare-ref tag canonical delete; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(aliasPath),
      `expected bare-ref tag alias delete; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(legacyCanonicalPath),
      `expected legacy tag canonical delete; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(legacyAliasPath),
      `expected legacy tag alias delete; got ${JSON.stringify(client.deletes)}`,
    );
  });

  it("normalizes id-only GitLab tag records before writing and deleting", async () => {
    const canonicalPath = "/gitlab/projects/acme/api/tags/release-id-only__release%2Fid-only.json";
    const aliasPath = "/gitlab/projects/acme/api/tags/by-ref/release-id-only__release%2Fid-only.json";
    const rawCanonicalPath = "/gitlab/projects/acme/api/tags/refs-tags-release-id-only__refs%2Ftags%2Frelease%2Fid-only.json";
    const rawAliasPath = "/gitlab/projects/acme/api/tags/by-ref/refs-tags-release-id-only__refs%2Ftags%2Frelease%2Fid-only.json";
    const client = makeMutableReadingClient();

    let result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "20:refs/tags/release/id-only",
          project_path: "acme/api",
          updated_at: "2026-05-15T10:00:00.000Z",
        },
      ],
      gitlabJob("GitLabTag"),
    );

    assert.equal(result.errors, 0);
    assert.ok(client.files.has(canonicalPath), "expected normalized id-only tag canonical write");
    assert.ok(client.files.has(aliasPath), "expected normalized id-only tag alias write");
    assert.equal(client.files.has(rawCanonicalPath), false);
    const canonical = JSON.parse(client.files.get(canonicalPath) ?? "{}") as Record<string, unknown>;
    assert.equal(canonical.id, "20:refs/tags/release/id-only");
    assert.equal(canonical.ref, "release/id-only");
    assert.equal(canonical.name, "release/id-only");

    client.files.set(rawCanonicalPath, "{}");
    client.files.set(rawAliasPath, "{}");
    result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "20:refs/tags/release/id-only",
          project_path: "acme/api",
          _deleted: true,
        },
      ],
      gitlabJob("GitLabTag"),
    );

    assert.equal(result.errors, 0);
    assert.ok(client.deletes.includes(canonicalPath));
    assert.ok(client.deletes.includes(aliasPath));
    assert.ok(client.deletes.includes(rawCanonicalPath));
    assert.ok(client.deletes.includes(rawAliasPath));
  });

  it("cleans adapter 0.2.9 legacy GitLab tag paths after complex tag writes", async () => {
    const legacyCanonicalPath = "/gitlab/projects/acme/api/tags/release/foo__bar.json";
    const legacyAliasPath = "/gitlab/projects/acme/api/tags/by-ref/release/foo__bar.json";
    const rawEncodedCanonicalPath = "/gitlab/projects/acme/api/tags/refs-tags-release-foo-bar__refs%2Ftags%2Frelease%2Ffoo__bar.json";
    const rawEncodedAliasPath = "/gitlab/projects/acme/api/tags/by-ref/refs-tags-release-foo-bar__refs%2Ftags%2Frelease%2Ffoo__bar.json";
    const rawSlashCanonicalPath = "/gitlab/projects/acme/api/tags/refs/tags/release/foo__bar.json";
    const rawSlashAliasPath = "/gitlab/projects/acme/api/tags/by-ref/refs/tags/release/foo__bar.json";
    const client = makeSeededReadingClient({
      [legacyCanonicalPath]: { ref: "release/foo__bar", project_path: "acme/api" },
      [legacyAliasPath]: { ref: "release/foo__bar", canonicalPath: legacyCanonicalPath },
      [rawEncodedCanonicalPath]: { ref: "refs/tags/release/foo__bar", project_path: "acme/api" },
      [rawEncodedAliasPath]: { ref: "refs/tags/release/foo__bar", canonicalPath: rawEncodedCanonicalPath },
      [rawSlashCanonicalPath]: { ref: "refs/tags/release/foo__bar", project_path: "acme/api" },
      [rawSlashAliasPath]: { ref: "refs/tags/release/foo__bar", canonicalPath: rawSlashCanonicalPath },
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "20:release/foo__bar",
          ref: "release/foo__bar",
          project_path: "acme/api",
          updated_at: "2026-05-15T10:00:00.000Z",
        },
      ],
      gitlabJob("GitLabTag"),
    );

    assert.equal(result.errors, 0);
    assert.ok(
      client.writes.some((write) => write.path === "/gitlab/projects/acme/api/tags/by-ref/release-foo-bar__release%2Ffoo__bar.json"),
      "expected fixed tag by-ref alias write",
    );
    assert.ok(
      client.deletes.includes(legacyCanonicalPath),
      `expected legacy tag canonical cleanup; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(legacyAliasPath),
      `expected legacy tag alias cleanup; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(rawEncodedCanonicalPath),
      `expected raw full-ref canonical cleanup; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(rawEncodedAliasPath),
      `expected raw full-ref alias cleanup; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(rawSlashCanonicalPath),
      `expected raw slash canonical cleanup; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.includes(rawSlashAliasPath),
      `expected raw slash alias cleanup; got ${JSON.stringify(client.deletes)}`,
    );
  });

  it("removes adapter 0.2.9 legacy GitLab tag paths written in the same batch", async () => {
    const legacyCanonicalPath = "/gitlab/projects/acme/api/tags/release/foo__bar.json";
    const rawLegacyCanonicalPath = "/gitlab/projects/acme/api/tags/refs/tags/release/foo__bar.json";
    const rawLegacyAliasPath = "/gitlab/projects/acme/api/tags/by-ref/refs-tags-release-foo-bar__refs%2Ftags%2Frelease%2Ffoo__bar.json";
    const fixedAliasPath = "/gitlab/projects/acme/api/tags/by-ref/release-foo-bar__release%2Ffoo__bar.json";
    const client = makeMutableReadingClient();

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "20:refs/tags/release/foo__bar",
          ref: "refs/tags/release/foo__bar",
          name: "release/foo__bar",
          project_path: "acme/api",
          updated_at: "2026-05-15T10:00:00.000Z",
        },
      ],
      gitlabJob("GitLabTag"),
    );

    assert.equal(result.errors, 0);
    assert.equal(client.files.has(legacyCanonicalPath), false);
    assert.equal(client.files.has(rawLegacyCanonicalPath), false);
    assert.equal(client.files.has(rawLegacyAliasPath), false);
    assert.equal(client.files.has(fixedAliasPath), true);
  });

  it("emits GitLab auxiliary indexes and aliases for pipeline, deployment, and tag sync records", async () => {
    const client = makeReadingClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "9001",
          project_id: "20",
          project_path: "acme/api",
          ref: "main",
          status: "failed",
          updated_at: "2026-05-15T10:00:00.000Z",
        },
      ],
      gitlabJob("GitLabPipeline"),
    );
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "501",
          project_id: "20",
          project_path: "acme/api",
          status: "success",
          updated_at: "2026-05-15T10:05:00.000Z",
        },
      ],
      gitlabJob("GitLabDeployment"),
    );
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "20:v1.0.0",
          ref: "v1.0.0",
          project_id: "20",
          project_path: "acme/api",
          updated_at: "2026-05-15T10:10:00.000Z",
        },
      ],
      gitlabJob("GitLabTag"),
    );

    assert.ok(client.writes.some((w) => w.path === "/gitlab/projects/acme/api/pipelines/by-status/failed/9001.json"));
    assert.ok(client.writes.some((w) => w.path === "/gitlab/projects/acme/api/deployments/by-status/success/501.json"));
    assert.ok(client.writes.some((w) => w.path === "/gitlab/projects/acme/api/tags/by-ref/v1-0-0__v1.0.0.json"));
    assert.ok(client.writes.some((w) => w.path === "/gitlab/projects/acme/api/pipelines/_index.json"));
    assert.ok(client.writes.some((w) => w.path === "/gitlab/projects/acme/api/deployments/_index.json"));
    assert.ok(client.writes.some((w) => w.path === "/gitlab/projects/acme/api/tags/_index.json"));
  });
});

describe("stale-artifact cleanup (review feedback on cloud#531)", () => {
  it("confluence: stale title updates skip before deleting the newer canonical path", async () => {
    const client = makeSeededReadingClient({
      "/confluence/pages/by-id/12345.json": {
        provider: "confluence",
        objectType: "page",
        objectId: "12345",
        payload: {
          id: "12345",
          title: "Current Title",
          spaceId: "SP1",
          status: "current",
          version: { createdAt: "2026-05-15T12:00:00.000Z" },
        },
      },
      "/confluence/spaces/SP1/pages/current-title__12345.json": {},
    });
    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "12345",
          title: "Old Title",
          spaceId: "SP1",
          status: "current",
          version: { createdAt: "2026-05-14T12:00:00.000Z" },
        },
      ],
      confluenceJob("ConfluencePage"),
    );

    // The stale record itself must produce NO canonical/alias/index
    // mutation (the behavior under test). The provider contract surface
    // (LAYOUT.md + discovery/) is now materialized on every sync and is
    // orthogonal to record staleness — filter it out before asserting.
    assert.equal(result.errors, 0);
    assert.equal(result.written, 0);
    assert.equal(result.deleted, 0);
    assert.deepEqual(recordWrites(client.writes), []);
    assert.deepEqual(recordPaths(client.deletes), []);
  });

  it("confluence: stale title updates skip when freshness is only in the index row", async () => {
    const client = makeSeededReadingClient({
      "/confluence/pages/_index.json": [
        {
          id: "12345",
          title: "Current Title",
          spaceId: "SP1",
          status: "current",
          updated: "2026-05-15T12:00:00.000Z",
        },
      ],
      "/confluence/spaces/SP1/pages/current-title__12345.json": {},
    });
    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "12345",
          title: "Old Title",
          spaceId: "SP1",
          status: "current",
          version: { createdAt: "2026-05-14T12:00:00.000Z" },
        },
      ],
      confluenceJob("ConfluencePage"),
    );

    // The stale record itself must produce NO canonical/alias/index
    // mutation (the behavior under test). The provider contract surface
    // (LAYOUT.md + discovery/) is now materialized on every sync and is
    // orthogonal to record staleness — filter it out before asserting.
    assert.equal(result.errors, 0);
    assert.equal(result.written, 0);
    assert.equal(result.deleted, 0);
    assert.deepEqual(recordWrites(client.writes), []);
    assert.deepEqual(recordPaths(client.deletes), []);
  });

  it("jira: stale summary updates skip before deleting the newer canonical path", async () => {
    const client = makeSeededReadingClient({
      "/jira/issues/by-id/10001.json": {
        provider: "jira",
        objectType: "issue",
        objectId: "10001",
        payload: {
          id: "10001",
          key: "ENG-1",
          fields: {
            summary: "Current summary",
            status: { name: "Open" },
            updated: "2026-05-15T12:00:00.000Z",
          },
        },
      },
      "/jira/issues/current-summary__10001.json": {},
    });
    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "10001",
          key: "ENG-1",
          fields: {
            summary: "Old summary",
            status: { name: "Open" },
            updated: "2026-05-14T12:00:00.000Z",
          },
        },
      ],
      jiraJob("JiraIssue"),
    );

    // The stale record itself must produce NO canonical/alias/index
    // mutation (the behavior under test). The provider contract surface
    // (LAYOUT.md + discovery/) is now materialized on every sync and is
    // orthogonal to record staleness — filter it out before asserting.
    assert.equal(result.errors, 0);
    assert.equal(result.written, 0);
    assert.equal(result.deleted, 0);
    assert.deepEqual(recordWrites(client.writes), []);
    assert.deepEqual(recordPaths(client.deletes), []);
  });

  it("jira: stale summary updates skip when freshness is only in the index row", async () => {
    const client = makeSeededReadingClient({
      "/jira/issues/_index.json": [
        {
          id: "10001",
          key: "ENG-1",
          title: "Current summary",
          status: "Open",
          updated: "2026-05-15T12:00:00.000Z",
        },
      ],
      "/jira/issues/current-summary__10001.json": {},
    });
    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "10001",
          key: "ENG-1",
          fields: {
            summary: "Old summary",
            status: { name: "Open" },
            updated: "2026-05-14T12:00:00.000Z",
          },
        },
      ],
      jiraJob("JiraIssue"),
    );

    // The stale record itself must produce NO canonical/alias/index
    // mutation (the behavior under test). The provider contract surface
    // (LAYOUT.md + discovery/) is now materialized on every sync and is
    // orthogonal to record staleness — filter it out before asserting.
    assert.equal(result.errors, 0);
    assert.equal(result.written, 0);
    assert.equal(result.deleted, 0);
    assert.deepEqual(recordWrites(client.writes), []);
    assert.deepEqual(recordPaths(client.deletes), []);
  });

  it("buildDeletionRecord can preserve the provider event timestamp", () => {
    const deletedAt = "2026-05-14T12:00:00.000Z";
    const record = buildDeletionRecord("page-1", { deletedAt });
    assert.deepEqual(record, {
      id: "page-1",
      _nango_metadata: {
        last_action: "deleted",
        deleted_at: deletedAt,
      },
    });
  });

  it("confluence: title change deletes the old by-title alias and old canonical path", async () => {
    const client = makeSeededReadingClient({
      // Pre-existing by-id alias is the source of truth the writer reads
      // to discover the previous title + spaceId.
      "/confluence/pages/by-id/12345.json": {
        id: "12345",
        title: "Old Title",
        spaceId: "SP1",
        status: "current",
      },
      "/confluence/pages/by-title/old-title.json": {},
      "/confluence/spaces/SP1/pages/old-title__12345.json": {},
      "/confluence/pages/_index.json": [
        {
          id: "12345",
          title: "Old Title",
          spaceId: "SP1",
          status: "current",
          updated: "2026-05-10T10:00:00.000Z",
        },
      ],
    });
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "12345",
          title: "New Title",
          spaceId: "SP1",
          status: "current",
        },
      ],
      confluenceJob("ConfluencePage"),
    );

    assert.ok(
      client.deletes.some((p) => p.startsWith("/confluence/pages/by-title/") && p.includes("old")),
      `expected by-title alias for old title to be deleted; got ${JSON.stringify(client.deletes)}`,
    );
    assert.ok(
      client.deletes.some(
        (p) => p.startsWith("/confluence/spaces/SP1/pages/") && p.endsWith("12345.json"),
      ),
      `expected old canonical path to be deleted; got ${JSON.stringify(client.deletes)}`,
    );
  });

  it("confluence: status transition deletes the old by-state alias", async () => {
    const client = makeSeededReadingClient({
      "/confluence/pages/by-id/77.json": {
        id: "77",
        title: "Draft",
        spaceId: "SP1",
        status: "draft",
      },
      "/confluence/pages/by-state/draft/77.json": {},
      "/confluence/pages/_index.json": [
        {
          id: "77",
          title: "Draft",
          spaceId: "SP1",
          status: "draft",
          updated: "2026-05-10T10:00:00.000Z",
        },
      ],
    });
    await writeBatchToRelayfile(
      client,
      [{ id: "77", title: "Draft", spaceId: "SP1", status: "current" }],
      confluenceJob("ConfluencePage"),
    );
    assert.ok(
      client.deletes.some(
        (p) => p.includes("/confluence/pages/by-state/draft/") && p.endsWith("77.json"),
      ),
      `expected old by-state alias to be deleted; got ${JSON.stringify(client.deletes)}`,
    );
  });

  it("confluence: delete tombstone recovers status from the index row and cleans by-state", async () => {
    const client = makeSeededReadingClient({
      "/confluence/pages/by-id/99.json": {
        id: "99",
        title: "Released",
        status: "current",
      },
      "/confluence/pages/by-state/current/99.json": {},
      "/confluence/pages/_index.json": [
        {
          id: "99",
          title: "Released",
          spaceId: "SP1",
          status: "current",
          updated: "2026-05-10T10:00:00.000Z",
        },
      ],
    });
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "99",
          _nango_metadata: { last_action: "DELETED" },
        },
      ],
      confluenceJob("ConfluencePage"),
    );
    assert.ok(
      client.deletes.some(
        (p) => p.includes("/confluence/pages/by-state/current/") && p.endsWith("99.json"),
      ),
      `expected by-state alias to be deleted using status recovered from index; got ${JSON.stringify(client.deletes)}`,
    );
  });

  it("jira: key change deletes the old by-key alias", async () => {
    const client = makeSeededReadingClient({
      "/jira/issues/by-id/10001.json": {
        id: "10001",
        key: "ENG-1",
        fields: { summary: "Fix bug", status: { name: "Open" } },
      },
      "/jira/issues/by-key/ENG-1.json": {},
      "/jira/issues/_index.json": [
        {
          id: "10001",
          key: "ENG-1",
          title: "Fix bug",
          status: "Open",
          updated: "2026-05-10T10:00:00.000Z",
        },
      ],
    });
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "10001",
          key: "PLAT-1",
          fields: {
            summary: "Fix bug",
            status: { name: "Open" },
            updated: "2026-05-10T10:00:00.000Z",
          },
        },
      ],
      jiraJob("JiraIssue"),
    );
    assert.ok(
      client.deletes.some((p) => p.endsWith("/jira/issues/by-key/ENG-1.json")),
      `expected by-key alias for old key to be deleted; got ${JSON.stringify(client.deletes)}`,
    );
  });

  it("jira: status transition deletes the old by-state alias", async () => {
    const client = makeSeededReadingClient({
      "/jira/issues/by-id/10001.json": {
        id: "10001",
        key: "ENG-1",
        fields: { summary: "Fix bug", status: { name: "Open" } },
      },
      "/jira/issues/by-state/open/10001.json": {},
      "/jira/issues/_index.json": [
        {
          id: "10001",
          key: "ENG-1",
          title: "Fix bug",
          status: "Open",
          updated: "2026-05-10T10:00:00.000Z",
        },
      ],
    });
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "10001",
          key: "ENG-1",
          fields: {
            summary: "Fix bug",
            status: { name: "Done" },
            updated: "2026-05-10T10:00:00.000Z",
          },
        },
      ],
      jiraJob("JiraIssue"),
    );
    assert.ok(
      client.deletes.some((p) => p === "/jira/issues/by-state/open/10001.json"),
      `expected old by-state alias to be deleted; got ${JSON.stringify(client.deletes)}`,
    );
  });

  it("jira: summary change deletes the old canonical path", async () => {
    const client = makeSeededReadingClient({
      "/jira/issues/by-id/10001.json": {
        id: "10001",
        key: "ENG-1",
        fields: { summary: "Old summary", status: { name: "Open" } },
      },
      "/jira/issues/old-summary__10001.json": {},
      "/jira/issues/_index.json": [
        {
          id: "10001",
          key: "ENG-1",
          title: "Old summary",
          status: "Open",
          updated: "2026-05-10T10:00:00.000Z",
        },
      ],
    });
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "10001",
          key: "ENG-1",
          fields: {
            summary: "New summary",
            status: { name: "Open" },
            updated: "2026-05-10T10:00:00.000Z",
          },
        },
      ],
      jiraJob("JiraIssue"),
    );
    // The previous canonical encodes the old summary slug at the leaf;
    // the new one encodes the new summary. Both end in 10001.json, so
    // assert a delete was issued for some old `/jira/issues/...10001.json`
    // path that is different from the new canonical write.
    const canonicalDeletes = client.deletes.filter(
      (p) =>
        p.startsWith("/jira/issues/") &&
        p.endsWith("10001.json") &&
        !p.includes("/by-"),
    );
    assert.ok(
      canonicalDeletes.length > 0,
      `expected old canonical jira path to be deleted; got ${JSON.stringify(client.deletes)}`,
    );
  });
});

describe("writeBatchToRelayfile", () => {
  it("samples resources whose index hint is a full _index.json path or singleton file path", async () => {
    const client = makeMutableReadingClient({
      "/sample/items/_index.json": JSON.stringify([{ id: "one" }]),
      "/sample/items/by-id/one.json": JSON.stringify({
        provider: "sample",
        objectType: "item",
        payload: { id: "one", name: "One" },
      }),
      "/sample/singleton/_index.json": JSON.stringify([{ id: "current" }]),
      "/sample/singleton/by-id/current.json": JSON.stringify({
        provider: "sample",
        objectType: "singleton",
        payload: { id: "current", enabled: true },
      }),
    });

    const sampled = await sampleExistingRecordsByResource(client, "rw_test", [
      {
        name: "items",
        path: "/sample/items/{id}.json",
        sampleIndexPath: "/sample/items/_index.json",
      },
      {
        name: "singleton",
        path: "/sample/singleton/current.json",
      },
    ]);

    assert.deepEqual(sampled.get("items"), [{ id: "one", name: "One" }]);
    assert.deepEqual(sampled.get("singleton"), [{ id: "current", enabled: true }]);
  });

  it("bulk path skips records before startOffset and checkpoints with original page offsets", async () => {
    const client = makeBulkMutableReadingClient();

    const result = await writeBatchToRelayfile(
      client,
      [
        { id: "team-0", name: "Skipped Zero" },
        { id: "team-1", name: "Skipped One" },
        { id: "team-2", name: "Written Two" },
      ],
      linearJob("LinearTeam"),
      {
        concurrency: 1,
        startOffset: 2,
        shouldCheckpoint: (nextOffset) => nextOffset === 3,
        materializeContract: false,
        materializeAuxiliaryFiles: false,
      },
    );

    assert.deepEqual(result, {
      written: 1,
      deleted: 0,
      errors: 0,
      checkpointOffset: 3,
    });
    assert.equal(client.bulkCalls.length, 1);
    assert.deepEqual(
      client.bulkCalls.flat().map((file) => file.path),
      ["/linear/teams/team-2.json"],
    );
    assert.equal(client.files.has("/linear/teams/team-0.json"), false);
    assert.equal(client.files.has("/linear/teams/team-1.json"), false);
  });

  it("retries Relayfile workspace_busy bulk flushes using the advertised delay", async () => {
    const warnings: Parameters<typeof console.warn>[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: Parameters<typeof console.warn>) => {
      warnings.push(args);
    };
    try {
      const client = makeBulkMutableReadingClient();
      const originalBulkWrite = client.bulkWrite.bind(client);
      let attempts = 0;
      client.bulkWrite = async (input) => {
        attempts += 1;
        if (attempts === 1) {
          throw {
            status: 429,
            code: "workspace_busy",
            message:
              "workspace write path is busy; retry after the advertised delay",
            headers: { "Retry-After": "0" },
            details: { retryAfterSeconds: 0 },
          };
        }
        return originalBulkWrite(input);
      };

      const result = await writeBatchToRelayfile(
        client,
        [{ id: "team-retry", name: "Retry Team" }],
        linearJob("LinearTeam"),
        {
          concurrency: 1,
          materializeContract: false,
          materializeAuxiliaryFiles: false,
        },
      );

      assert.deepEqual(result, { written: 1, deleted: 0, errors: 0 });
      assert.equal(attempts, 2);
      assert.equal(client.files.has("/linear/teams/team-retry.json"), true);
      assert.equal(
        warnings.some(
          ([message, detail]) =>
            message === "Nango staged Relayfile bulk write busy; retrying" &&
            (detail as { code?: string }).code === "workspace_busy",
        ),
        true,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("throws when the bulk flush commits fewer rows than sent so the workflow retries (relayfile#306)", async () => {
    // DO returns 202 with written one short of the batch and no per-file errors:
    // the silent "accepted but unreadable" mode. The writer must NOT report a
    // clean success — it reconciles sent vs committed+deduped+errored and throws
    // so the CF Workflow page step fails/retries (a non-throwing error count is
    // inert: NangoSyncWorkflow.run advances the cursor without inspecting it).
    const errors: Parameters<typeof console.error>[] = [];
    const originalError = console.error;
    console.error = (...args: Parameters<typeof console.error>) => {
      errors.push(args);
    };
    try {
      const client = makeBulkMutableReadingClient({}, { bulkSilentDrop: 1 });
      await assert.rejects(
        () =>
          writeBatchToRelayfile(
            client,
            [
              { id: "team-a", name: "Team A" },
              { id: "team-b", name: "Team B" },
            ],
            linearJob("LinearTeam"),
            {
              concurrency: 1,
              materializeContract: false,
              materializeAuxiliaryFiles: false,
            },
          ),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: string }).code === "bulk_write_under_committed" &&
          (error as { detail?: { shortfall?: number } }).detail?.shortfall === 1,
      );
    } finally {
      console.error = originalError;
    }

    assert.ok(
      errors.some(
        ([message, detail]) =>
          message === "Nango staged Relayfile bulk write under-committed" &&
          (detail as { shortfall?: number }).shortfall === 1,
      ),
      "expected an under-committed diagnostic with shortfall=1",
    );
  });

  it("does not surface a shortfall when committed plus deduped accounts for the batch (relayfile#306)", async () => {
    // A legitimately deduped file is accounted for and must NOT count as a drop.
    const client = {
      ...makeBulkMutableReadingClient(),
      async bulkWrite(input: { files: unknown[]; correlationId?: string }) {
        return {
          written: input.files.length - 1,
          errors: [],
          dedupedFiles: [{ path: "deduped" }],
          correlationId: input.correlationId,
        };
      },
    } as unknown as RelayfileWriteClient;
    const result = await writeBatchToRelayfile(
      client,
      [
        { id: "team-c", name: "Team C" },
        { id: "team-d", name: "Team D" },
      ],
      linearJob("LinearTeam"),
      {
        concurrency: 1,
        materializeContract: false,
        materializeAuxiliaryFiles: false,
      },
    );
    assert.equal(result.errors, 0);
  });

  it("stages canonical, auxiliary, and index writes into one bulk flush", async () => {
    const client = makeBulkMutableReadingClient();

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-1",
          identifier: "AGE-1",
          title: "First issue",
          state_name: "Todo",
          updatedAt: "2026-05-12T10:00:00.000Z",
        },
        {
          id: "issue-2",
          identifier: "AGE-2",
          title: "Second issue",
          state_name: "Done",
          updatedAt: "2026-05-12T11:00:00.000Z",
        },
      ],
      linearJob("LinearIssue"),
      { materializeContract: false },
    );

    assert.deepEqual(result, { written: 2, deleted: 0, errors: 0 });
    assert.equal(client.bulkCalls.length, 1);
    assert.equal(client.writes.length, client.bulkCalls[0]!.length);
    const paths = client.bulkCalls[0]!.map((file) => file.path);
    assert.ok(paths.includes("/linear/issues/AGE-1__issue-1.json"));
    assert.ok(paths.includes("/linear/issues/AGE-2__issue-2.json"));
    assert.ok(paths.includes("/linear/issues/by-uuid/issue-1.json"));
    assert.ok(paths.includes("/linear/issues/by-uuid/issue-2.json"));
    assert.ok(paths.includes("/linear/issues/_index.json"));
    assert.equal(
      client.bulkCalls[0]!.find(
        (file) => file.path === "/linear/issues/AGE-1__issue-1.json",
      )?.dependsOn,
      undefined,
    );
    assert.deepEqual(
      client.bulkCalls[0]!.find(
        (file) => file.path === "/linear/issues/by-uuid/issue-1.json",
      )?.dependsOn,
      [
        "/linear/issues/AGE-1__issue-1.json",
        "/linear/issues/AGE-2__issue-2.json",
      ],
    );
    assert.deepEqual(
      client.bulkCalls[0]!.find((file) => file.path === "/linear/issues/_index.json")
        ?.dependsOn,
      [
        "/linear/issues/AGE-1__issue-1.json",
        "/linear/issues/AGE-2__issue-2.json",
      ],
    );

    const indexRows = JSON.parse(
      client.files.get("/linear/issues/_index.json") ?? "[]",
    ) as Array<{ id: string; title: string }>;
    assert.deepEqual(
      indexRows
        .map((row) => [row.id, row.title])
        .sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
      [
        ["issue-1", "First issue"],
        ["issue-2", "Second issue"],
      ],
    );
  });

  it("makes staged bulk writes visible to later same-batch reads", async () => {
    const client = makeBulkMutableReadingClient();

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "label-1",
          name: "Bug",
          updatedAt: "2026-05-12T10:00:00.000Z",
        },
        {
          id: "label-2",
          name: "Relayfile Adapters",
          updatedAt: "2026-05-12T11:00:00.000Z",
        },
      ],
      linearJob("LinearLabel"),
      {
        concurrency: 1,
        materializeContract: false,
      },
    );

    assert.deepEqual(result, { written: 2, deleted: 0, errors: 0 });
    assert.equal(client.bulkCalls.length, 1);
    const indexRows = JSON.parse(
      client.files.get("/linear/labels/_index.json") ?? "[]",
    ) as Array<{ id: string; title: string }>;
    assert.deepEqual(
      indexRows
        .map((row) => [row.id, row.title])
        .sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
      [
        ["label-1", "Bug"],
        ["label-2", "Relayfile Adapters"],
      ],
    );
  });

  it("preserves delete and re-add ordering in one staged bulk page", async () => {
    const oldAlias = "/linear/issues/by-state/todo/AGE-1.json";
    const newAlias = "/linear/issues/by-state/done/AGE-1.json";
    const client = makeBulkMutableReadingClient({
      "/linear/issues/by-uuid/issue-1.json": JSON.stringify({
        provider: "linear",
        objectType: "issue",
        objectId: "issue-1",
        payload: {
          id: "issue-1",
          identifier: "AGE-1",
          title: "Move state",
          state_name: "Todo",
        },
      }),
      [oldAlias]: "{}",
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-1",
          identifier: "AGE-1",
          title: "Move state",
          state_name: "Done",
          updatedAt: "2026-05-12T10:00:00.000Z",
        },
      ],
      linearJob("LinearIssue"),
      { materializeContract: false },
    );

    assert.deepEqual(result, { written: 1, deleted: 0, errors: 0 });
    assert.equal(client.bulkCalls.length, 1);
    const oldAliasDeleteIndex = client.bulkCalls[0]!.findIndex(
      (file) => file.path === oldAlias && file.op === "delete",
    );
    const newAliasWriteIndex = client.bulkCalls[0]!.findIndex(
      (file) => file.path === newAlias && file.op !== "delete",
    );
    assert.ok(oldAliasDeleteIndex >= 0, "expected old alias delete in bulk payload");
    assert.ok(newAliasWriteIndex >= 0, "expected new alias write in bulk payload");
    assert.ok(oldAliasDeleteIndex < newAliasWriteIndex);
    assert.equal(client.files.has(oldAlias), false);
    assert.equal(client.files.has(newAlias), true);
    const indexRows = JSON.parse(
      client.files.get("/linear/issues/_index.json") ?? "[]",
    ) as Array<{ id: string; state: string }>;
    assert.deepEqual(indexRows.map((row) => [row.id, row.state]), [
      ["issue-1", "Done"],
    ]);
  });

  it("attributes partial bulk canonical write errors to the failed record only", async () => {
    const client = makeBulkMutableReadingClient(
      {},
      {
        bulkErrors: [
          {
            path: "/linear/teams/team-2.json",
            code: "workspace_busy",
            message: "workspace busy",
          },
        ],
      },
    );
    const logs: Array<Parameters<typeof console.error>> = [];
    const originalConsoleError = console.error;
    console.error = (...args: Parameters<typeof console.error>) => {
      logs.push(args);
    };
    try {
      const result = await writeBatchToRelayfile(
        client,
        [
          { id: "team-1", name: "Applied" },
          { id: "team-2", name: "Failed" },
        ],
        linearJob("LinearTeam"),
        { materializeContract: false, materializeAuxiliaryFiles: false },
      );

      assert.deepEqual(result, {
        written: 1,
        deleted: 0,
        errors: 1,
        errorSamples: [
          {
            path: "/linear/teams/team-2.json",
            code: "workspace_busy",
            message: "workspace busy",
            ownerOffsets: [1],
          },
        ],
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(client.files.has("/linear/teams/team-1.json"), true);
    assert.equal(client.files.has("/linear/teams/team-2.json"), false);
    assert.equal(
      logs.filter(([message]) => message === "Nango staged Relayfile bulk write failed").length,
      1,
    );
    const [, payload] = logs.find(
      ([message]) => message === "Nango staged Relayfile bulk write failed",
    ) as [string, Record<string, unknown>];
    assert.deepEqual(payload.ownerOffsets, [1]);
  });

  it("rejects whole bulk failures so SQS can redrive instead of advancing the cursor", async () => {
    const error = new Error("workspace is saturated") as Error & { code: string };
    error.code = "workspace_busy";
    const client = makeBulkMutableReadingClient(
      {},
      {
        bulkReject: error,
      },
    );
    const logs: Array<Parameters<typeof console.error>> = [];
    const originalConsoleError = console.error;
    console.error = (...args: Parameters<typeof console.error>) => {
      logs.push(args);
    };
    try {
      await assert.rejects(
        writeBatchToRelayfile(
          client,
          [
            { id: "team-1", name: "Retry Me" },
            { id: "team-2", name: "Retry Me Too" },
          ],
          linearJob("LinearTeam"),
          { materializeContract: false, materializeAuxiliaryFiles: false },
        ),
        (reason: unknown) => reason === error,
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(client.bulkCalls.length, 1);
    assert.equal(client.files.size, 0);
    assert.equal(
      logs.filter(([message]) => message === "Nango staged Relayfile bulk write failed").length,
      1,
    );
  });

  it("flushes provider contract files through bulk even when no records apply", async () => {
    const client = makeBulkMutableReadingClient();

    const result = await writeBatchToRelayfile(
      client,
      [],
      linearJob("LinearIssue"),
    );

    assert.deepEqual(result, { written: 0, deleted: 0, errors: 0 });
    assert.equal(client.bulkCalls.length, 1);
    const paths = client.bulkCalls[0]!.map((file) => file.path);
    assert.ok(paths.includes("/LAYOUT.md"));
    assert.ok(paths.includes("/linear/LAYOUT.md"));
    assert.ok(
      paths.some((path) => path.startsWith("/discovery/linear/issues/")),
      `expected linear discovery files in bulk payload, got ${paths.join(", ")}`,
    );
    assert.equal(client.files.has("/linear/LAYOUT.md"), true);
  });

  it("logs the rejection reason instead of swallowing it silently", async () => {
    const client: RelayfileWriteClient = {
      async writeFile() {
        throw new Error("simulated write failure");
      },
      async deleteFile() {},
    };

    const errors: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const result = await writeBatchToRelayfile(
        client,
        [{ id: "id-1" }],
        linearJob("LinearTeam"),
      );
      assert.equal(result.errors, 1);
      assert.equal(result.written, 0);
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(errors.length, 1);
    const [message, payload] = errors[0] as [string, Record<string, unknown>];
    assert.equal(message, "Nango record write failed");
    assert.equal(payload.provider, "linear");
    assert.equal(payload.model, "LinearTeam");
    // Post-B4-OBS: the rejection reason is surfaced via the canonical
    // `errorLogFields` shape (errorMessage / errorCode / errorCauseChain),
    // not a bespoke `reason.message`. This preserves the original assertion
    // intent (the reason is not silently swallowed) while keeping the log
    // shape uniform across every per-hop emission.
    assert.match(
      (payload.errorMessage as string | undefined) ?? "",
      /simulated write failure/,
    );
  });

  it("mirrors Slack channel discovery index during a zero-record refresh", async () => {
    const client = makeMutableReadingClient({
      "/slack/channels/_index.json": `${JSON.stringify([
        {
          id: "C0AD7UU0J1G",
          title: "proj-cloud",
          path: "/slack/channels/C0AD7UU0J1G__proj-cloud/meta.json",
          updated: "2026-06-05T10:00:00.000Z",
        },
        { id: "C0AD7SAGE", title: "proj-sage", updated: "2026-06-05T09:00:00.000Z" },
      ])}\n`,
    });

    const result = await writeBatchToRelayfile(client, [], slackJob("SlackChannel"));

    assert.deepEqual(result, { written: 0, deleted: 0, errors: 0 });
    const rows = JSON.parse(
      client.files.get("/discovery/slack/channels/_index.json") ?? "[]",
    ) as Array<{
      id: string;
      name: string;
      title: string;
      canonicalPath: string;
      path: string;
      messagesPath: string;
    }>;
    assert.deepEqual(rows, [
      {
        id: "C0AD7UU0J1G",
        name: "proj-cloud",
        title: "proj-cloud",
        canonicalPath: "/slack/channels/C0AD7UU0J1G__proj-cloud/meta.json",
        path: "/slack/channels/C0AD7UU0J1G",
        messagesPath: "/slack/channels/C0AD7UU0J1G/messages",
      },
      {
        id: "C0AD7SAGE",
        name: "proj-sage",
        title: "proj-sage",
        canonicalPath: "/slack/channels/C0AD7SAGE/meta.json",
        path: "/slack/channels/C0AD7SAGE",
        messagesPath: "/slack/channels/C0AD7SAGE/messages",
      },
    ]);
  });

  it("mirrors Slack user discovery index during a zero-record refresh", async () => {
    const client = makeMutableReadingClient({
      "/slack/users/_index.json": `${JSON.stringify([
        { id: "U0B2596R7EZ", name: "agent-relay", title: "Agent Relay", updated: "2026-06-05T10:00:00.000Z", is_bot: true },
      ])}\n`,
    });

    const result = await writeBatchToRelayfile(client, [], slackJob("SlackUser"));

    assert.deepEqual(result, { written: 0, deleted: 0, errors: 0 });
    const rows = JSON.parse(
      client.files.get("/discovery/slack/users/_index.json") ?? "[]",
    ) as Array<{
      id: string;
      name: string;
      title: string;
      canonicalPath: string;
      path: string;
      messagesPath: string;
      is_bot: boolean;
    }>;
    assert.deepEqual(rows, [{
      id: "U0B2596R7EZ",
      name: "agent-relay",
      title: "Agent Relay",
      canonicalPath: "/slack/users/U0B2596R7EZ/meta.json",
      path: "/slack/users/U0B2596R7EZ",
      messagesPath: "/slack/users/U0B2596R7EZ/messages",
      is_bot: true,
    }]);
  });

  it("can skip provider contract materialization for live Slack message writes", async () => {
    const client = makeMutableReadingClient();
    const originalWarn = console.warn;
    const warnings: Array<Parameters<typeof console.warn>> = [];
    console.warn = (...args: Parameters<typeof console.warn>) => {
      warnings.push(args);
    };
    let result: Awaited<ReturnType<typeof writeBatchToRelayfile>> | null = null;
    try {
      result = await writeBatchToRelayfile(
        client,
        [{
          channel: "C0AD7UU0J1G",
          ts: "1780689956.223549",
          text: "live webhook message",
          user: "U0B2596R7EZ",
        }],
        {
          ...slackJob("SlackMessage"),
          syncName: "fetch-channel-history",
        },
        { materializeContract: false, materializeAuxiliaryFiles: false },
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(result, { written: 1, deleted: 0, errors: 0 });
    assert.ok(
      client.writes.some((write) =>
        write.path === "/slack/channels/C0AD7UU0J1G/messages/1780689956_223549/meta.json"
      ),
    );
    assert.deepEqual(warnings, [[
      "[record-writer] Slack channel message missing channelName; writing bare path",
      {
        provider: "slack",
        model: "SlackMessage",
        channelId: "C0AD7UU0J1G",
        ts: "1780689956.223549",
        threadTs: undefined,
        path: "/slack/channels/C0AD7UU0J1G/messages/1780689956_223549/meta.json",
      },
    ]]);
    assert.equal(client.writes.some((write) => write.path.startsWith("/discovery/slack/")), false);
  });

  it("writes live Slack channel messages under resolved suffixed channel paths", async () => {
    const client = makeMutableReadingClient();
    const result = await writeBatchToRelayfile(
      client,
      [{
        channel: "C0B8ZL2L9GC",
        channelName: "pear-pty-investigation",
        ts: "1780921813.531539",
        thread_ts: "1780871788.370329",
        text: "live thread reply",
        user: "U0ADJH4P83T",
      }],
      {
        ...slackJob("SlackMessage"),
        syncName: "fetch-channel-history",
      },
      { materializeContract: false, materializeAuxiliaryFiles: false },
    );

    assert.deepEqual(result, { written: 1, deleted: 0, errors: 0 });
    assert.ok(
      client.writes.some((write) =>
        write.path === "/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/threads/1780871788_370329/replies/1780921813_531539/meta.json"
      ),
    );
    assert.equal(
      client.writes.some((write) => write.path.startsWith("/slack/channels/C0B8ZL2L9GC/")),
      false,
    );
  });

  it("deletes live Slack channel messages under resolved suffixed channel paths", async () => {
    const path =
      "/slack/channels/C0B8ZL2L9GC__pear-pty-investigation/threads/1780871788_370329/replies/1780921813_531539/meta.json";
    const client = makeMutableReadingClient({
      [path]: "{}",
    });
    const result = await writeBatchToRelayfile(
      client,
      [{
        id: "C0B8ZL2L9GC:1780921813.531539",
        channel: "C0B8ZL2L9GC",
        channelName: "pear-pty-investigation",
        ts: "1780921813.531539",
        thread_ts: "1780871788.370329",
        _nango_metadata: { last_action: "deleted" },
      }],
      {
        ...slackJob("SlackMessage"),
        syncName: "fetch-channel-history",
      },
      { materializeContract: false, materializeAuxiliaryFiles: false },
    );

    assert.deepEqual(result, { written: 0, deleted: 1, errors: 0 });
    assert.ok(client.deletes.includes(path));
    assert.equal(
      client.deletes.some((deletePath) => deletePath.startsWith("/slack/channels/C0B8ZL2L9GC/")),
      false,
    );
  });

  it("writes resolved live Slack IM messages to canonical user-message paths without changing the flat record", async () => {
    const client = makeMutableReadingClient();
    const result = await writeBatchToRelayfile(
      client,
      [{
        channel: "D0B2MHP6E3T",
        channel_type: "im",
        dm_user_id: "U0DMRECIPIENT",
        source_channel_id: "D0B2MHP6E3T",
        ts: "1780893132.131989",
        text: "live dm webhook message",
        user: "U0AUTHOR",
      }],
      {
        ...slackJob("SlackMessage"),
        syncName: "fetch-channel-history",
      },
      { materializeContract: false, materializeAuxiliaryFiles: false },
    );

    assert.deepEqual(result, { written: 1, deleted: 0, errors: 0 });
    const write = client.writes.find((candidate) =>
      candidate.path === "/slack/users/U0DMRECIPIENT/messages/1780893132_131989/meta.json"
    );
    assert.ok(write);
    assert.deepEqual(JSON.parse(write.content), {
      channel: "D0B2MHP6E3T",
      channel_type: "im",
      dm_user_id: "U0DMRECIPIENT",
      source_channel_id: "D0B2MHP6E3T",
      ts: "1780893132.131989",
      text: "live dm webhook message",
      user: "U0AUTHOR",
    });
    assert.equal(client.writes.some((candidate) => candidate.path.startsWith("/slack/channels/D0B2MHP6E3T/")), false);
    assert.equal(client.writes.some((candidate) => candidate.path.startsWith("/discovery/slack/")), false);
  });

  it("writes resolved live Slack IM thread replies under the user-message reply tree", async () => {
    const client = makeMutableReadingClient();
    const result = await writeBatchToRelayfile(
      client,
      [{
        channel: "D0B2MHP6E3T",
        channel_type: "im",
        dm_user_id: "W0DMRECIPIENT",
        source_channel_id: "D0B2MHP6E3T",
        ts: "1780893132.131989",
        thread_ts: "1780893000.000100",
        text: "live dm reply",
        user: "U0AUTHOR",
      }],
      {
        ...slackJob("SlackMessage"),
        syncName: "fetch-channel-history",
      },
      { materializeContract: false, materializeAuxiliaryFiles: false },
    );

    assert.deepEqual(result, { written: 1, deleted: 0, errors: 0 });
    assert.ok(
      client.writes.some((write) =>
        write.path === "/slack/users/W0DMRECIPIENT/messages/1780893000_000100/replies/1780893132_131989/meta.json"
      ),
    );
    assert.equal(client.writes.some((write) => write.path.startsWith("/slack/channels/D0B2MHP6E3T/")), false);
  });

  it("clears Slack discovery index when the canonical index is empty", async () => {
    const client = makeMutableReadingClient({
      "/slack/channels/_index.json": "[]\n",
      "/discovery/slack/channels/_index.json": `${JSON.stringify([
        {
          id: "C0AD7UU0J1G",
          name: "proj-cloud",
          title: "proj-cloud",
          path: "/slack/channels/C0AD7UU0J1G",
          messagesPath: "/slack/channels/C0AD7UU0J1G/messages",
        },
      ])}\n`,
    });

    const result = await writeBatchToRelayfile(client, [], slackJob("SlackChannel"));

    assert.deepEqual(result, { written: 0, deleted: 0, errors: 0 });
    assert.equal(client.files.get("/discovery/slack/channels/_index.json"), "[]\n");
  });

  it("mirrors Slack channel discovery index after applied channel records", async () => {
    const client = makeMutableReadingClient();

    const result = await writeBatchToRelayfile(
      client,
      [{ id: "C0AD7UU0J1G", name: "proj-cloud", updated: "2026-06-05T10:00:00.000Z" }],
      slackJob("SlackChannel"),
    );

    assert.equal(result.errors, 0);
    assert.equal(result.written, 1);
    const rows = JSON.parse(
      client.files.get("/discovery/slack/channels/_index.json") ?? "[]",
    ) as Array<{
      id: string;
      name: string;
      title: string;
      canonicalPath: string;
      path: string;
      messagesPath: string;
    }>;
    assert.deepEqual(rows, [{
      id: "C0AD7UU0J1G",
      name: "proj-cloud",
      title: "proj-cloud",
      canonicalPath: "/slack/channels/C0AD7UU0J1G/meta.json",
      path: "/slack/channels/C0AD7UU0J1G",
      messagesPath: "/slack/channels/C0AD7UU0J1G/messages",
    }]);
  });

  it("clears stale Slack discovery index when the canonical channel index is empty", async () => {
    const client = makeMutableReadingClient({
      "/slack/channels/_index.json": "[]\n",
      "/discovery/slack/channels/_index.json": `${JSON.stringify([
        { id: "C0STALE", name: "stale", path: "/slack/channels/C0STALE" },
      ])}\n`,
    });

    const result = await writeBatchToRelayfile(client, [], slackJob("SlackChannel"));

    assert.deepEqual(result, { written: 0, deleted: 0, errors: 0 });
    assert.equal(client.files.get("/discovery/slack/channels/_index.json"), "[]\n");
  });

  it("reports Slack discovery mirror read failures without clearing existing discovery", async () => {
    const client = makeMutableReadingClient({
      "/discovery/slack/channels/_index.json": `${JSON.stringify([
        { id: "C0KEEP", name: "keep", path: "/slack/channels/C0KEEP" },
      ])}\n`,
    });
    client.readFile = async (_workspaceId, path) => {
      if (path === "/slack/channels/_index.json") {
        const error = new Error("temporary Slack index read failure") as Error & { status: number };
        error.status = 503;
        throw error;
      }
      if (client.files.has(path)) {
        return { content: client.files.get(path), revision: `rev:${path}` };
      }
      const error = new Error("not found") as Error & { status: number };
      error.status = 404;
      throw error;
    };

    const result = await writeBatchToRelayfile(client, [], slackJob("SlackChannel"));

    assert.deepEqual(result, { written: 0, deleted: 0, errors: 1 });
    assert.match(
      client.files.get("/discovery/slack/channels/_index.json") ?? "",
      /C0KEEP/,
    );
  });

  it("github webhook repository batch preserves existing repo index rows", async () => {
    const client = makeMutableReadingClient({
      "/github/repos/_index.json": `${JSON.stringify([
        { id: "acme/api", title: "acme/api", updated: "2026-04-01T00:00:00.000Z" },
        { id: "acme/web", title: "acme/web", updated: "2026-04-02T00:00:00.000Z" },
      ])}\n`,
    });

    const result = await writeBatchToRelayfile(
      client,
      [githubRepositoryRecord("acme", "hooks")],
      githubWebhookRepoJob(),
    );

    assert.equal(result.errors, 0);
    const rows = JSON.parse(client.files.get("/github/repos/_index.json") ?? "[]") as Array<{ id: string }>;
    assert.deepEqual(rows.map((row) => row.id).sort(), [
      "acme/api",
      "acme/hooks",
      "acme/web",
    ]);
  });

  it("github webhook repository batch refuses to overwrite repo index after non-404 read failure", async () => {
    const indexPath = "/github/repos/_index.json";
    const existingIndex = `${JSON.stringify([
      { id: "acme/api", title: "acme/api", updated: "2026-04-01T00:00:00.000Z" },
      { id: "acme/web", title: "acme/web", updated: "2026-04-02T00:00:00.000Z" },
    ])}\n`;
    const client = makeMutableReadingClient({ [indexPath]: existingIndex });
    const baseReadFile = client.readFile?.bind(client);
    client.readFile = async (workspaceId, path) => {
      if (path === indexPath) {
        throw errorWithStatus(500);
      }
      return baseReadFile!(workspaceId, path);
    };

    const result = await writeBatchToRelayfile(
      client,
      [githubRepositoryRecord("acme", "hooks")],
      githubWebhookRepoJob(),
    );

    assert.ok(result.errors > 0);
    assert.equal(client.files.get(indexPath), existingIndex);
    assert.equal(client.writes.some((write) => write.path === indexPath), false);
  });

  it("github webhook repository batch treats a missing repo index as empty baseline", async () => {
    const client = makeMutableReadingClient();

    const result = await writeBatchToRelayfile(
      client,
      [githubRepositoryRecord("acme", "hooks")],
      githubWebhookRepoJob(),
    );

    assert.equal(result.errors, 0);
    const rows = JSON.parse(
      client.files.get("/github/repos/_index.json") ?? "[]",
    ) as Array<{ id: string }>;
    assert.deepEqual(rows.map((row) => row.id), ["acme/hooks"]);
  });

  it("github webhook repository batch treats response-wrapped 404 as missing repo index", async () => {
    const client = makeMutableReadingClient();
    const baseReadFile = client.readFile?.bind(client);
    client.readFile = async (workspaceId, path, correlationId, signal) => {
      if (path === "/github/repos/_index.json") {
        throw errorWithResponseStatus(404);
      }
      return baseReadFile!(workspaceId, path, correlationId, signal);
    };

    const result = await writeBatchToRelayfile(
      client,
      [githubRepositoryRecord("acme", "hooks")],
      githubWebhookRepoJob(),
    );

    assert.equal(result.errors, 0);
    const rows = JSON.parse(client.files.get("/github/repos/_index.json") ?? "[]") as Array<{ id: string }>;
    assert.deepEqual(rows.map((row) => row.id), ["acme/hooks"]);
  });

  it("github webhook repository batch treats a null repo index read as empty baseline", async () => {
    const client = makeMutableReadingClient();
    const baseReadFile = client.readFile?.bind(client);
    client.readFile = async (workspaceId, path, correlationId, signal) => {
      if (path === "/github/repos/_index.json") {
        return null as never;
      }
      return baseReadFile!(workspaceId, path, correlationId, signal);
    };

    const result = await writeBatchToRelayfile(
      client,
      [githubRepositoryRecord("acme", "hooks")],
      githubWebhookRepoJob(),
    );

    assert.equal(result.errors, 0);
    const rows = JSON.parse(client.files.get("/github/repos/_index.json") ?? "[]") as Array<{ id: string }>;
    assert.deepEqual(rows.map((row) => row.id), ["acme/hooks"]);
  });

  it("google-mail emits by-label/by-sender/by-thread digests and reconciles updates/deletes", async () => {
    const client = makeMutableReadingClient();
    const job = googleMailJob("GoogleMailMessage", "google-mail-relay");

    await writeBatchToRelayfile(
      client,
      [
        {
          id: "m-1",
          threadId: "t-1",
          labelIds: ["INBOX", "CATEGORY_UPDATES"],
          snippet: "hello world",
          historyId: "h1",
          internalDate: "1715600000000",
          payload: {
            headers: [
              { name: "Subject", value: "Digest Alpha" },
              { name: "From", value: "Alice Example <alice@example.com>" },
              { name: "To", value: "Bob Example <bob@example.com>" },
            ],
          },
        },
      ],
      job,
    );

    const main1 = JSON.parse(
      client.files.get("/google-mail/messages/_index.json") ?? "[]",
    ) as Array<Record<string, unknown>>;
    assert.equal(main1.length, 1);
    assert.equal(main1[0]?.id, "m-1");
    assert.equal(main1[0]?.senderEmail, "alice@example.com");
    assert.equal(
      main1[0]?.canonicalPath,
      "/google-mail/messages/m-1.json",
    );
    assert.ok(
      client.files.has("/google-mail/messages/by-label/INBOX/_index.json"),
    );
    assert.ok(
      client.files.has(
        "/google-mail/messages/by-sender/alice%40example.com/_index.json",
      ),
    );
    assert.ok(
      client.files.has("/google-mail/messages/by-thread/t-1/_index.json"),
    );
    assert.ok(client.files.has("/google-mail/messages/by-id/m-1.json"));
    const byIdAlias = JSON.parse(
      client.files.get("/google-mail/messages/by-id/m-1.json") ?? "{}",
    ) as Record<string, unknown>;
    assert.equal(byIdAlias.canonicalPath, "/google-mail/messages/m-1.json");
    assert.equal("payload" in byIdAlias, false);

    await writeBatchToRelayfile(
      client,
      [
        {
          id: "m-1",
          threadId: "t-1",
          labelIds: ["SENT"],
          snippet: "updated",
          historyId: "h2",
          internalDate: "1715686400000",
          payload: {
            headers: [
              { name: "Subject", value: "Digest Beta" },
              { name: "From", value: "Carol Example <carol@example.com>" },
              { name: "To", value: "Bob Example <bob@example.com>" },
            ],
          },
        },
      ],
      job,
    );

    const inboxRows = JSON.parse(
      client.files.get("/google-mail/messages/by-label/INBOX/_index.json") ?? "[]",
    ) as Array<Record<string, unknown>>;
    const sentRows = JSON.parse(
      client.files.get("/google-mail/messages/by-label/SENT/_index.json") ?? "[]",
    ) as Array<Record<string, unknown>>;
    const aliceRows = JSON.parse(
      client.files.get(
        "/google-mail/messages/by-sender/alice%40example.com/_index.json",
      ) ?? "[]",
    ) as Array<Record<string, unknown>>;
    const carolRows = JSON.parse(
      client.files.get(
        "/google-mail/messages/by-sender/carol%40example.com/_index.json",
      ) ?? "[]",
    ) as Array<Record<string, unknown>>;

    assert.equal(inboxRows.length, 0, "stale label digest row should be removed");
    assert.equal(sentRows.length, 1);
    assert.equal(aliceRows.length, 0, "stale sender digest row should be removed");
    assert.equal(carolRows.length, 1);

    await writeBatchToRelayfile(client, [buildDeletionRecord("m-1")], job);

    const mainAfterDelete = JSON.parse(
      client.files.get("/google-mail/messages/_index.json") ?? "[]",
    ) as Array<Record<string, unknown>>;
    const sentAfterDelete = JSON.parse(
      client.files.get("/google-mail/messages/by-label/SENT/_index.json") ?? "[]",
    ) as Array<Record<string, unknown>>;
    assert.equal(mainAfterDelete.length, 0);
    assert.equal(sentAfterDelete.length, 0);
    assert.equal(
      client.files.has("/google-mail/messages/by-id/m-1.json"),
      false,
      "message by-id alias should be removed on delete",
    );
  });

  it("google-mail unchanged replay does not rewrite canonical or auxiliary files", async () => {
    const client = makeMutableReadingClient();
    const job = googleMailJob("GoogleMailMessage", "google-mail-relay");
    const message = {
      id: "19e5de8cebaf9250",
      threadId: "thread-dedup",
      labelIds: ["INBOX"],
      snippet: "Repeated Gmail notification",
      historyId: "105",
      internalDate: "1715600000000",
      payload: {
        headers: [
          { name: "Subject", value: "Repeated" },
          { name: "From", value: "Alice Example <alice@example.com>" },
          { name: "To", value: "Bob Example <bob@example.com>" },
        ],
      },
    };

    const first = await writeBatchToRelayfile(client, [message], job);
    assert.equal(first.written, 1);
    const writesAfterFirst = client.writes.length;

    const second = await writeBatchToRelayfile(client, [message], job);
    assert.deepEqual(second, { written: 0, deleted: 0, errors: 0 });
    assert.equal(client.writes.length, writesAfterFirst);
    assert.equal(
      client.writes.filter((write) => write.path === "/google-mail/messages/19e5de8cebaf9250.json").length,
      1,
    );
  });

  it("google-mail message replay skips canonical and auxiliary writes when only historyId changes", async () => {
    const client = makeMutableReadingClient();
    const job = googleMailJob("GoogleMailMessage", "google-mail-relay");
    const message = {
      id: "m-stable",
      threadId: "thread-stable",
      labelIds: ["CATEGORY_UPDATES", "INBOX"],
      snippet: "Stable Gmail notification",
      historyId: "105",
      internalDate: "1715600000000",
      payload: {
        headers: [
          { name: "Subject", value: "Stable" },
          { name: "From", value: "Alice Example <alice@example.com>" },
          { name: "To", value: "Bob Example <bob@example.com>" },
        ],
        parts: [
          {
            partId: "1",
            mimeType: "application/pdf",
            filename: "invoice.pdf",
            body: { attachmentId: "att-1", size: 42 },
          },
          {
            partId: "0",
            mimeType: "text/plain",
            body: {
              data: Buffer.from("Stable body", "utf8").toString("base64url"),
              size: 11,
            },
          },
        ],
      },
    };

    const first = await writeBatchToRelayfile(client, [message], job);
    assert.equal(first.written, 1);
    const writesAfterFirst = client.writes.length;
    const existingCanonical = client.files.get("/google-mail/messages/m-stable.json");

    const second = await writeBatchToRelayfile(
      client,
      [{
        ...message,
        labelIds: ["INBOX", "CATEGORY_UPDATES"],
        historyId: "106",
        payload: {
          ...message.payload,
          parts: [...message.payload.parts].reverse(),
        },
      }],
      job,
    );

    assert.deepEqual(second, { written: 0, deleted: 0, errors: 0 });
    assert.equal(client.writes.length, writesAfterFirst);
    assert.equal(client.files.get("/google-mail/messages/m-stable.json"), existingCanonical);
  });

  it("google-mail message replay writes when a semantic field changes", async () => {
    const client = makeMutableReadingClient();
    const job = googleMailJob("GoogleMailMessage", "google-mail-relay");
    const message = {
      id: "m-label-change",
      threadId: "thread-label-change",
      labelIds: ["INBOX"],
      snippet: "Label before",
      historyId: "105",
      internalDate: "1715600000000",
      subject: "Label Change",
      from: "Alice Example <alice@example.com>",
      to: "Bob Example <bob@example.com>",
      body_text: "body",
      body_html: null,
      attachments: [],
    };

    await writeBatchToRelayfile(client, [message], job);
    const writesAfterFirst = client.writes.length;

    const second = await writeBatchToRelayfile(
      client,
      [{
        ...message,
        labelIds: ["INBOX", "STARRED"],
        historyId: "106",
      }],
      job,
    );

    assert.equal(second.written, 1);
    assert.ok(client.writes.length > writesAfterFirst);
    const starredRows = JSON.parse(
      client.files.get("/google-mail/messages/by-label/STARRED/_index.json") ?? "[]",
    ) as Array<Record<string, unknown>>;
    assert.equal(starredRows.length, 1);
  });

  it("google-mail thread replay skips when only thread and nested message historyIds change", async () => {
    const client = makeMutableReadingClient();
    const job = googleMailJob("GoogleMailThread", "google-mail-relay");
    const thread = {
      id: "t-stable",
      historyId: "h1",
      snippet: "thread snippet",
      messages: [
        {
          id: "m-2",
          threadId: "t-stable",
          labelIds: ["SENT"],
          snippet: "second",
          historyId: "m-h2",
          internalDate: "1715600001000",
          subject: "Thread Subject 2",
          from: "Carol Example <carol@example.com>",
          to: "Bob Example <bob@example.com>",
          date: "Wed, 20 May 2026 10:38:00 +0000",
        },
        {
          id: "m-1",
          threadId: "t-stable",
          labelIds: ["INBOX"],
          snippet: "first",
          historyId: "m-h1",
          internalDate: "1715600000000",
          subject: "Thread Subject",
          from: "Alice Example <alice@example.com>",
          to: "Bob Example <bob@example.com>",
          date: "Wed, 20 May 2026 10:37:00 +0000",
        },
      ],
    };

    await writeBatchToRelayfile(client, [thread], job);
    const writesAfterFirst = client.writes.length;
    const existingCanonical = client.files.get("/google-mail/threads/t-stable.json");

    const second = await writeBatchToRelayfile(
      client,
      [{
        ...thread,
        historyId: "h2",
        messages: [...thread.messages].reverse().map((message, index) => ({
          ...message,
          historyId: `m-h-next-${index}`,
        })),
      }],
      job,
    );

    assert.deepEqual(second, { written: 0, deleted: 0, errors: 0 });
    assert.equal(client.writes.length, writesAfterFirst);
    assert.equal(client.files.get("/google-mail/threads/t-stable.json"), existingCanonical);
  });

  it("google-mail stable dedup can be disabled by environment flag", async () => {
    const previous = process.env.GOOGLE_MAIL_STABLE_DEDUP_ENABLED;
    process.env.GOOGLE_MAIL_STABLE_DEDUP_ENABLED = "false";
    try {
      const client = makeMutableReadingClient();
      const job = googleMailJob("GoogleMailMessage", "google-mail-relay");
      const message = {
        id: "m-rollback",
        threadId: "thread-rollback",
        labelIds: ["INBOX"],
        snippet: "Rollback",
        historyId: "105",
        internalDate: "1715600000000",
        subject: "Rollback",
        from: "Alice Example <alice@example.com>",
        to: "Bob Example <bob@example.com>",
        body_text: "body",
        body_html: null,
        attachments: [],
      };

      await writeBatchToRelayfile(client, [message], job);
      const second = await writeBatchToRelayfile(
        client,
        [{ ...message, historyId: "106" }],
        job,
      );

      assert.equal(second.written, 1);
    } finally {
      if (previous === undefined) {
        delete process.env.GOOGLE_MAIL_STABLE_DEDUP_ENABLED;
      } else {
        process.env.GOOGLE_MAIL_STABLE_DEDUP_ENABLED = previous;
      }
    }
  });

  it("google-mail thread records store compact message refs instead of embedded message bodies", async () => {
    const client = makeMutableReadingClient();
    const job = googleMailJob("GoogleMailThread", "google-mail-relay");

    await writeBatchToRelayfile(
      client,
      [
        {
          id: "t-1",
          historyId: "h1",
          snippet: "thread snippet",
          messages: [
            {
              id: "m-1",
              threadId: "t-1",
              labelIds: ["INBOX"],
              snippet: "Plain body",
              historyId: "h1",
              internalDate: "1715600000000",
              payload: {
                headers: [
                  { name: "Subject", value: "Thread Subject" },
                  { name: "From", value: "Alice Example <alice@example.com>" },
                  { name: "To", value: "Bob Example <bob@example.com>" },
                ],
                parts: [
                  {
                    partId: "0",
                    mimeType: "text/plain",
                    body: {
                      size: 10,
                      data: Buffer.from("Plain body", "utf8").toString("base64url"),
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      job,
    );

    const thread = JSON.parse(
      client.files.get("/google-mail/threads/t-1.json") ?? "{}",
    ) as Record<string, unknown>;
    assert.deepEqual(thread.messageIds, ["m-1"]);
    assert.equal(thread.messageCount, 1);
    assert.equal("raw_json" in thread, false);
    const messages = thread.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.id, "m-1");
    assert.equal(messages[0]?.subject, "Thread Subject");
    assert.equal("payload" in (messages[0] ?? {}), false);
    assert.equal("body_text" in (messages[0] ?? {}), false);
    assert.equal("raw_json" in (messages[0] ?? {}), false);

    const alias = JSON.parse(
      client.files.get("/google-mail/threads/by-id/t-1.json") ?? "{}",
    ) as Record<string, unknown>;
    assert.equal(alias.canonicalPath, "/google-mail/threads/t-1.json");
    assert.equal("payload" in alias, false);
  });

  it("google-calendar events emit organizer/day/calendar digests and reconcile deletes", async () => {
    const client = makeMutableReadingClient();
    const job = googleCalendarJob("GoogleCalendarEvent");

    await writeBatchToRelayfile(
      client,
      [
        {
          id: "primary:evt-1",
          calendarId: "primary",
          eventId: "evt-1",
          status: "confirmed",
          summary: "Design Review",
          lastEditedTime: "2026-05-19T10:00:00.000Z",
          start: { dateTime: "2026-05-21T09:00:00Z" },
          end: { dateTime: "2026-05-21T10:00:00Z" },
          organizer: { email: "alice@example.com" },
          attendees: [{ email: "bob@example.com" }, { email: "carol@example.com" }],
        },
      ],
      job,
    );

    const eventMain = JSON.parse(
      client.files.get("/google-calendar/events/_index.json") ?? "[]",
    ) as Array<Record<string, unknown>>;
    assert.equal(eventMain.length, 1);
    assert.equal(eventMain[0]?.id, "primary:evt-1");
    assert.equal(eventMain[0]?.updated, "2026-05-19T10:00:00.000Z");
    assert.ok(
      client.files.has("/google-calendar/events/by-calendar/primary/_index.json"),
    );
    assert.ok(
      client.files.has(
        "/google-calendar/events/by-organizer/alice%40example.com/_index.json",
      ),
    );
    assert.ok(
      client.files.has("/google-calendar/events/by-day/2026-05-21/_index.json"),
    );
    assert.ok(
      client.files.has("/google-calendar/events/by-id/primary%3Aevt-1.json"),
    );

    await writeBatchToRelayfile(client, [buildDeletionRecord("primary:evt-1")], job);

    const eventMainAfterDelete = JSON.parse(
      client.files.get("/google-calendar/events/_index.json") ?? "[]",
    ) as Array<Record<string, unknown>>;
    const calendarFacetAfterDelete = JSON.parse(
      client.files.get("/google-calendar/events/by-calendar/primary/_index.json") ?? "[]",
    ) as Array<Record<string, unknown>>;
    assert.equal(eventMainAfterDelete.length, 0);
    assert.equal(calendarFacetAfterDelete.length, 0);
    assert.equal(
      client.files.has("/google-calendar/events/by-id/primary%3Aevt-1.json"),
      false,
      "event by-id alias should be removed on delete",
    );
  });

  it("google-mail materializes indexes, by-id aliases, and non-empty discovery for every writable resource", async () => {
    const client = makeMutableReadingClient();
    const cases: Array<{
      model: string;
      record: Record<string, unknown>;
      indexPath: string;
      aliasId: string;
      schemaPath: string;
      examplePath: string;
    }> = [
      {
        model: "GoogleMailLabel",
        record: {
          id: "Label_10",
          name: "Cornell/Syracuse Bus",
          type: "user",
          messageListVisibility: "show",
          labelListVisibility: "labelShowIfUnread",
        },
        indexPath: "/google-mail/labels/_index.json",
        aliasId: "Label_10",
        schemaPath: "/discovery/google-mail/labels/.schema.json",
        examplePath: "/discovery/google-mail/labels/.create.example.json",
      },
      {
        model: "GoogleMailFilter",
        record: {
          id: "filter-1",
          criteria: { from: "alice@example.com" },
          action: { addLabelIds: ["Label_10"] },
        },
        indexPath: "/google-mail/filters/_index.json",
        aliasId: "filter-1",
        schemaPath: "/discovery/google-mail/filters/.schema.json",
        examplePath: "/discovery/google-mail/filters/.create.example.json",
      },
      {
        model: "GoogleMailSendAsAlias",
        record: {
          id: "me@example.com",
          sendAsEmail: "me@example.com",
          displayName: "Me",
          isPrimary: true,
        },
        indexPath: "/google-mail/send-as/_index.json",
        aliasId: "me@example.com",
        schemaPath: "/discovery/google-mail/send-as/.schema.json",
        examplePath: "/discovery/google-mail/send-as/.create.example.json",
      },
      {
        model: "GoogleMailMessage",
        record: {
          id: "m-1",
          threadId: "t-1",
          labelIds: ["INBOX"],
          snippet: "hello world",
          historyId: "h1",
          internalDate: "1715600000000",
          payload: {
            headers: [
              { name: "Subject", value: "Digest Alpha" },
              { name: "From", value: "Alice Example <alice@example.com>" },
            ],
          },
        },
        indexPath: "/google-mail/messages/_index.json",
        aliasId: "m-1",
        schemaPath: "/discovery/google-mail/messages/.schema.json",
        examplePath: "/discovery/google-mail/messages/.create.example.json",
      },
      {
        model: "GoogleMailThread",
        record: {
          id: "t-1",
          snippet: "thread snippet",
          messages: [
            {
              id: "m-1",
              labelIds: ["INBOX"],
              internalDate: "1715600000000",
              payload: {
                headers: [
                  { name: "Subject", value: "Digest Alpha" },
                  { name: "From", value: "Alice Example <alice@example.com>" },
                ],
              },
            },
          ],
        },
        indexPath: "/google-mail/threads/_index.json",
        aliasId: "t-1",
        schemaPath: "/discovery/google-mail/threads/.schema.json",
        examplePath: "/discovery/google-mail/threads/.create.example.json",
      },
      {
        model: "GoogleMailWatchRenewal",
        record: {
          id: "watch-1",
          historyId: "101",
          expiration: "2026-05-21T00:00:00.000Z",
          topicName: "projects/acme/topics/gmail",
        },
        indexPath: "/google-mail/watch-renewals/_index.json",
        aliasId: "watch-1",
        schemaPath: "/discovery/google-mail/watch-renewals/.schema.json",
        examplePath: "/discovery/google-mail/watch-renewals/.create.example.json",
      },
    ];

    for (const testCase of cases) {
      const result = await writeBatchToRelayfile(
        client,
        [testCase.record],
        googleMailJob(testCase.model),
      );
      assert.equal(result.errors, 0, `${testCase.model} should not error`);

      const rows = JSON.parse(client.files.get(testCase.indexPath) ?? "[]") as Array<
        Record<string, unknown>
      >;
      assert.ok(rows.some((row) => row.id === testCase.aliasId));
      assert.ok(
        client.files.has(
          testCase.indexPath.replace(
            "/_index.json",
            `/by-id/${encodeURIComponent(testCase.aliasId)}.json`,
          ),
        ),
        `${testCase.model} by-id alias missing`,
      );
      assert.ok(
        schemaPropertyCount(client, testCase.schemaPath) > 0,
        `${testCase.schemaPath} should infer fields`,
      );
      assert.ok(
        createExamplePropertyCount(client, testCase.examplePath) > 0,
        `${testCase.examplePath} should not be {}`,
      );
    }

    for (const path of [...client.files.keys()]) {
      if (path.startsWith("/discovery/google-mail/")) {
        client.files.delete(path);
      }
    }

    const report = await ensureProviderDiscoveryContractReport(
      client,
      "google-mail",
      "rw_test",
    );
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, cases.length);
    for (const testCase of cases) {
      assert.ok(
        schemaPropertyCount(client, testCase.schemaPath) > 0,
        `${testCase.schemaPath} should recover from existing indexes`,
      );
    }
    const messageSchemaProperties = schemaProperties(
      client,
      "/discovery/google-mail/messages/.schema.json",
    );
    assert.ok(
      messageSchemaProperties.threadId,
      "message schema should infer message-level threadId from the raw record",
    );
    assert.ok(
      messageSchemaProperties.labelIds,
      "message schema should infer message-level labelIds from the raw record",
    );
    assert.ok(
      messageSchemaProperties.subject,
      "message schema should infer flattened Gmail headers from the compact canonical record",
    );
    assert.equal(
      messageSchemaProperties.payload,
      undefined,
      "message schema should not advertise the dropped raw Gmail payload",
    );
  });

  // Regression guard for cloud#801: rw_fc7b534b had 970 canonical message
  // files on disk but ZERO `/google-mail/.../_index.json` files anywhere.
  // The root cause was that `writeGoogleMailAuxiliaryFiles` wrapped its
  // per-record loop AND the trailing `flushIndexCache` in a single
  // try/catch — so a throw during ANY record's `applyPrimaryAndFacets`
  // / `writeByIdRecordAlias` aborted the loop and skipped the flush,
  // leaving the populated in-memory cache un-persisted. The fix moves
  // `flushIndexCache` out of the try/catch so it always runs even when a
  // mid-batch record throws.
  it("google-mail: a mid-batch writeByIdRecordAlias throw must not abort flushIndexCache (cloud#801)", async () => {
    const client = makeMutableReadingClient();

    // Sabotage the FIRST writeFile on a per-record by-id alias path so the
    // loop's iteration #2 throws — but iteration #1 has already populated
    // the in-memory `_index.json` cache. The fix ensures flushIndexCache
    // still runs and persists what we have.
    const originalWriteFile = client.writeFile.bind(client);
    let sabotaged = false;
    client.writeFile = async (input: Parameters<typeof originalWriteFile>[0]) => {
      if (
        !sabotaged &&
        input.path === "/google-mail/messages/by-id/m-2.json"
      ) {
        sabotaged = true;
        const err = new Error("simulated transient writeFile failure for m-2");
        throw err;
      }
      return originalWriteFile(input);
    };

    const job = googleMailJob("GoogleMailMessage");
    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "m-1",
          threadId: "t-1",
          labelIds: ["INBOX"],
          historyId: "h1",
          internalDate: "1715600000000",
          snippet: "first",
          payload: { headers: [{ name: "Subject", value: "First" }] },
        },
        {
          id: "m-2",
          threadId: "t-2",
          labelIds: ["INBOX"],
          historyId: "h2",
          internalDate: "1715600001000",
          snippet: "second",
          payload: { headers: [{ name: "Subject", value: "Second" }] },
        },
        {
          id: "m-3",
          threadId: "t-3",
          labelIds: ["INBOX"],
          historyId: "h3",
          internalDate: "1715600002000",
          snippet: "third",
          payload: { headers: [{ name: "Subject", value: "Third" }] },
        },
      ],
      job,
    );

    // The sabotaged record contributes one error; canonical records still
    // succeed (their writeFile path is different from the by-id alias).
    assert.ok(result.errors > 0, "expected at least one error to be reported");
    assert.ok(sabotaged, "sabotage hook should have fired for m-2");

    // The critical assertion: _index.json was written despite the mid-batch
    // throw. Pre-fix, this file would be absent because flushIndexCache
    // never ran. Post-fix, it exists (possibly with a partial row set, but
    // never empty).
    const indexPath = "/google-mail/messages/_index.json";
    assert.ok(
      client.files.has(indexPath),
      `${indexPath} must be written even when a mid-batch record throws`,
    );
    const rows = JSON.parse(client.files.get(indexPath)!) as Array<{ id: string }>;
    assert.ok(
      rows.some((row) => row.id === "m-1") || rows.some((row) => row.id === "m-3"),
      "at least one non-sabotaged record's row should land in _index.json",
    );
  });

  // Follow-on regression guard for cloud#801: the always-run flush from PR
  // #825 only helps if at least one record's body completed an upsert before
  // another threw. If the FIRST record's by-id alias write throws, the
  // outer try/catch in #825 still aborted the for-loop BEFORE any
  // upsertIndexRow ran — leaving the cache empty so the (now always-run)
  // flush wrote nothing. This PR adds per-record try/catch so records #2
  // and #3 still land even when record #1 throws.
  it("google-mail: a throw on FIRST record must not block subsequent records' upserts from reaching _index.json (cloud#801 follow-up)", async () => {
    const client = makeMutableReadingClient();

    const originalWriteFile = client.writeFile.bind(client);
    let sabotaged = false;
    client.writeFile = async (input: Parameters<typeof originalWriteFile>[0]) => {
      if (
        !sabotaged &&
        input.path === "/google-mail/messages/by-id/m-1.json"
      ) {
        sabotaged = true;
        throw new Error("simulated transient writeFile failure for m-1");
      }
      return originalWriteFile(input);
    };

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "m-1",
          threadId: "t-1",
          labelIds: ["INBOX"],
          historyId: "h1",
          internalDate: "1715600000000",
          snippet: "first (will throw)",
          payload: { headers: [{ name: "Subject", value: "First" }] },
        },
        {
          id: "m-2",
          threadId: "t-2",
          labelIds: ["INBOX"],
          historyId: "h2",
          internalDate: "1715600001000",
          snippet: "second",
          payload: { headers: [{ name: "Subject", value: "Second" }] },
        },
        {
          id: "m-3",
          threadId: "t-3",
          labelIds: ["INBOX"],
          historyId: "h3",
          internalDate: "1715600002000",
          snippet: "third",
          payload: { headers: [{ name: "Subject", value: "Third" }] },
        },
      ],
      googleMailJob("GoogleMailMessage"),
    );

    assert.ok(result.errors > 0, "expected the m-1 failure to be reported");
    assert.ok(sabotaged, "sabotage hook should have fired for m-1");

    const indexPath = "/google-mail/messages/_index.json";
    assert.ok(
      client.files.has(indexPath),
      `${indexPath} must be written even when record #1 throws`,
    );
    const rows = JSON.parse(client.files.get(indexPath)!) as Array<{ id: string }>;
    assert.ok(
      rows.some((row) => row.id === "m-2"),
      "m-2 must reach _index.json even though m-1 threw",
    );
    assert.ok(
      rows.some((row) => row.id === "m-3"),
      "m-3 must reach _index.json even though m-1 threw",
    );
  });

  it("google-mail: a failed aux index read must not shrink an existing _index.json", async () => {
    const indexPath = "/google-mail/messages/_index.json";
    const existingIndex = JSON.stringify([
      {
        id: "m-old",
        path: "/google-mail/messages/m-old.json",
        title: "Existing message",
      },
    ]);
    const client = makeMutableReadingClient({
      [indexPath]: existingIndex,
    });

    const originalReadFile = client.readFile!.bind(client);
    client.readFile = async (workspaceId, path, correlationId, signal) => {
      if (path === indexPath) {
        const err = new Error("simulated transient index read failure") as Error & {
          status: number;
        };
        err.status = 503;
        throw err;
      }
      return originalReadFile(workspaceId, path, correlationId, signal);
    };

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "m-new",
          threadId: "t-new",
          labelIds: ["INBOX"],
          historyId: "h-new",
          internalDate: "1715600003000",
          snippet: "new message",
          payload: { headers: [{ name: "Subject", value: "New" }] },
        },
      ],
      googleMailJob("GoogleMailMessage"),
    );

    assert.ok(
      result.errors > 0,
      "the refused aux index write should be surfaced as a sync error",
    );
    assert.equal(
      client.files.get(indexPath),
      existingIndex,
      "existing index must not be replaced by a partial baseline after a read failure",
    );
  });

  it("google-calendar materializes indexes, by-id aliases, and non-empty discovery for every writable resource", async () => {
    const client = makeMutableReadingClient();
    const cases: Array<{
      model: string;
      record: Record<string, unknown>;
      indexPath: string;
      aliasId: string;
      schemaPath: string;
      examplePath: string;
    }> = [
      {
        model: "GoogleCalendar",
        record: {
          id: "primary",
          summary: "Primary",
          timeZone: "UTC",
          accessRole: "owner",
        },
        indexPath: "/google-calendar/calendars/_index.json",
        aliasId: "primary",
        schemaPath: "/discovery/google-calendar/calendars/.schema.json",
        examplePath: "/discovery/google-calendar/calendars/.create.example.json",
      },
      {
        model: "GoogleCalendarSetting",
        record: { id: "timezone", value: "UTC" },
        indexPath: "/google-calendar/settings/_index.json",
        aliasId: "timezone",
        schemaPath: "/discovery/google-calendar/settings/.schema.json",
        examplePath: "/discovery/google-calendar/settings/.create.example.json",
      },
      {
        model: "GoogleCalendarColor",
        record: {
          id: "event:1",
          colorType: "event",
          colorId: "1",
          background: "#ffffff",
          foreground: "#000000",
        },
        indexPath: "/google-calendar/colors/_index.json",
        aliasId: "event:1",
        schemaPath: "/discovery/google-calendar/colors/{colorType}/.schema.json",
        examplePath:
          "/discovery/google-calendar/colors/{colorType}/.create.example.json",
      },
      {
        model: "GoogleCalendarEvent",
        record: {
          id: "primary:evt-1",
          calendarId: "primary",
          eventId: "evt-1",
          status: "confirmed",
          summary: "Design Review",
          start: { dateTime: "2026-05-21T09:00:00Z" },
          end: { dateTime: "2026-05-21T10:00:00Z" },
          organizer: { email: "alice@example.com" },
          attendees: [{ email: "bob@example.com" }],
        },
        indexPath: "/google-calendar/events/_index.json",
        aliasId: "primary:evt-1",
        schemaPath:
          "/discovery/google-calendar/calendars/{calendarId}/events/.schema.json",
        examplePath:
          "/discovery/google-calendar/calendars/{calendarId}/events/.create.example.json",
      },
      {
        model: "GoogleCalendarAcl",
        record: {
          id: "primary:rule-1",
          calendarId: "primary",
          ruleId: "rule-1",
          role: "reader",
          scope: { type: "user", value: "alice@example.com" },
        },
        indexPath: "/google-calendar/acls/_index.json",
        aliasId: "primary:rule-1",
        schemaPath:
          "/discovery/google-calendar/calendars/{calendarId}/acls/.schema.json",
        examplePath:
          "/discovery/google-calendar/calendars/{calendarId}/acls/.create.example.json",
      },
      {
        model: "GoogleCalendarWatchRenewal",
        record: {
          id: "watch-1",
          resourceType: "calendar",
          expiration: "2026-05-21T00:00:00.000Z",
          webhookUrl: "https://example.com/google-calendar/watch",
        },
        indexPath: "/google-calendar/watch-renewals/_index.json",
        aliasId: "watch-1",
        schemaPath: "/discovery/google-calendar/watch-renewals/.schema.json",
        examplePath:
          "/discovery/google-calendar/watch-renewals/.create.example.json",
      },
    ];

    for (const testCase of cases) {
      const result = await writeBatchToRelayfile(
        client,
        [testCase.record],
        googleCalendarJob(testCase.model),
      );
      assert.equal(result.errors, 0, `${testCase.model} should not error`);

      const rows = JSON.parse(client.files.get(testCase.indexPath) ?? "[]") as Array<
        Record<string, unknown>
      >;
      assert.ok(rows.some((row) => row.id === testCase.aliasId));
      assert.ok(
        client.files.has(
          testCase.indexPath.replace(
            "/_index.json",
            `/by-id/${encodeURIComponent(testCase.aliasId)}.json`,
          ),
        ),
        `${testCase.model} by-id alias missing`,
      );
      assert.ok(
        schemaPropertyCount(client, testCase.schemaPath) > 0,
        `${testCase.schemaPath} should infer fields`,
      );
      assert.ok(
        createExamplePropertyCount(client, testCase.examplePath) > 0,
        `${testCase.examplePath} should not be {}`,
      );
    }

    for (const path of [...client.files.keys()]) {
      if (path.startsWith("/discovery/google-calendar/")) {
        client.files.delete(path);
      }
    }

    const report = await ensureProviderDiscoveryContractReport(
      client,
      "google-calendar",
      "rw_test",
    );
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, cases.length);
    for (const testCase of cases) {
      assert.ok(
        schemaPropertyCount(client, testCase.schemaPath) > 0,
        `${testCase.schemaPath} should recover from existing indexes`,
      );
    }
  });

  it("granola materializes indexes, by-id aliases, and non-empty discovery for notes and folders", async () => {
    const client = makeMutableReadingClient();
    const cases: Array<{
      model: string;
      record: Record<string, unknown>;
      indexPath: string;
      aliasId: string;
      schemaPath: string;
      examplePath: string;
    }> = [
      {
        model: "GranolaNote",
        record: {
          id: "not_1d3tmYTlCICgjy",
          object: "note",
          title: "Quarterly yoghurt budget review",
          owner: {
            name: "Oat Benson",
            email: "oat@granola.ai",
          },
          created_at: "2026-01-27T15:30:00Z",
          updated_at: "2026-01-27T16:45:00Z",
          web_url: "https://notes.granola.ai/d/f3e45e0f-24cc-480b-9a6c-8b1f5e3d7a2c",
          calendar_event: null,
          attendees: [],
          folder_membership: [
            {
              id: "fol_4y6LduVdwSKC27",
              object: "folder",
              name: "Top secret recipes",
              parent_folder_id: null,
            },
          ],
          summary_text: "Summary",
          summary_markdown: null,
          transcript: null,
        },
        indexPath: "/granola/notes/_index.json",
        aliasId: "not_1d3tmYTlCICgjy",
        schemaPath: "/discovery/granola/notes/.schema.json",
        examplePath: "/discovery/granola/notes/.create.example.json",
      },
      {
        model: "GranolaFolder",
        record: {
          id: "fol_4y6LduVdwSKC27",
          object: "folder",
          name: "Top secret recipes",
          parent_folder_id: null,
        },
        indexPath: "/granola/folders/_index.json",
        aliasId: "fol_4y6LduVdwSKC27",
        schemaPath: "/discovery/granola/folders/.schema.json",
        examplePath: "/discovery/granola/folders/.create.example.json",
      },
    ];

    for (const testCase of cases) {
      const result = await writeBatchToRelayfile(
        client,
        [testCase.record],
        granolaJob(testCase.model),
      );
      assert.equal(result.errors, 0, `${testCase.model} should not error`);

      const rows = JSON.parse(client.files.get(testCase.indexPath) ?? "[]") as Array<
        Record<string, unknown>
      >;
      assert.ok(rows.some((row) => row.id === testCase.aliasId));
      assert.ok(
        client.files.has(
          testCase.indexPath.replace(
            "/_index.json",
            `/by-id/${encodeURIComponent(testCase.aliasId)}.json`,
          ),
        ),
        `${testCase.model} by-id alias missing`,
      );
      assert.ok(
        schemaPropertyCount(client, testCase.schemaPath) > 0,
        `${testCase.schemaPath} should infer fields`,
      );
      assert.ok(
        createExamplePropertyCount(client, testCase.examplePath) > 0,
        `${testCase.examplePath} should not be {}`,
      );
    }

    for (const path of [...client.files.keys()]) {
      if (path.startsWith("/discovery/granola/")) {
        client.files.delete(path);
      }
    }

    const report = await ensureProviderDiscoveryContractReport(
      client,
      "granola",
      "rw_test",
    );
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, cases.length);
    for (const testCase of cases) {
      assert.ok(
        schemaPropertyCount(client, testCase.schemaPath) > 0,
        `${testCase.schemaPath} should recover from existing indexes`,
      );
    }
  });

  it("recall materializes recordings and transcripts to the shared recording path with discovery", async () => {
    const client = makeMutableReadingClient();
    const recording = {
      id: "rec_123",
      title: "Planning",
      status: { code: "done" },
      created_at: "2026-06-01T10:00:00.000Z",
      updated_at: "2026-06-01T10:30:00.000Z",
      transcript_text: "Initial transcript",
    };
    const transcript = {
      id: "tr_123",
      recording_id: "rec_123",
      transcript_text: "Updated transcript",
      created_at: "2026-06-01T10:31:00.000Z",
    };

    const recordingResult = await writeBatchToRelayfile(
      client,
      [recording],
      recallJob("RecallRecording"),
    );
    assert.equal(recordingResult.errors, 0);
    assert.ok(client.files.has("/recall/recordings/rec_123.json"));
    assert.ok(
      schemaPropertyCount(client, "/discovery/recall/recordings/.schema.json") > 0,
      "recall recording schema should infer fields",
    );
    assert.ok(
      createExamplePropertyCount(
        client,
        "/discovery/recall/recordings/.create.example.json",
      ) > 0,
      "recall recording create example should not be empty",
    );

    const transcriptResult = await writeBatchToRelayfile(
      client,
      [transcript],
      recallJob("RecallTranscript"),
    );
    assert.equal(transcriptResult.errors, 0);
    assert.equal(
      JSON.parse(client.files.get("/recall/recordings/rec_123.json") ?? "{}").transcript_text,
      "Updated transcript",
    );

    const report = await ensureProviderDiscoveryContractReport(client, "recall", "rw_test");
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, 1);
  });

  it("fathom materializes canonical records, indexes, and by-id aliases for meetings, recordings, teams, and members", async () => {
    const client = makeMutableReadingClient();
    const now = "2026-05-25T12:00:00.000Z";
    const cases: Array<{
      model: string;
      record: Record<string, unknown>;
      canonicalPath: string;
      indexPath: string;
      aliasPath: string;
    }> = [
      {
        model: "FathomMeeting",
        record: {
          id: "123456789",
          recording_id: 123456789,
          title: "Quarterly Business Review",
          meeting_title: "QBR 2025 Q1",
          url: "https://fathom.video/xyz123",
          share_url: "https://fathom.video/share/xyz123",
          created_at: now,
          scheduled_start_time: now,
          scheduled_end_time: now,
          recording_start_time: now,
          recording_end_time: now,
          calendar_invitees_domains_type: "one_or_more_external",
          transcript_language: "en",
          calendar_invitees: [],
          recorded_by: {
            name: "Alice Johnson",
            email: "alice.johnson@acme.com",
            email_domain: "acme.com",
            team: "Sales",
          },
        },
        canonicalPath: "/fathom/meetings/123456789.json",
        indexPath: "/fathom/meetings/_index.json",
        aliasPath: "/fathom/meetings/by-id/123456789.json",
      },
      {
        model: "FathomRecordingSummary",
        record: {
          id: "123456789",
          recording_id: 123456789,
          created_at: now,
          summary: {
            template_name: "general",
            markdown_formatted: "## Summary\nDemo\n",
          },
          fetched_at: now,
        },
        canonicalPath: "/fathom/recordings/123456789/summary.json",
        indexPath: "/fathom/recording-summaries/_index.json",
        aliasPath: "/fathom/recording-summaries/by-id/123456789.json",
      },
      {
        model: "FathomRecordingTranscript",
        record: {
          id: "123456789",
          recording_id: 123456789,
          created_at: now,
          transcript: [],
          fetched_at: now,
        },
        canonicalPath: "/fathom/recordings/123456789/transcript.json",
        indexPath: "/fathom/recording-transcripts/_index.json",
        aliasPath: "/fathom/recording-transcripts/by-id/123456789.json",
      },
      {
        model: "FathomTeam",
        record: {
          id: "Sales",
          name: "Sales",
          created_at: now,
        },
        canonicalPath: "/fathom/teams/Sales.json",
        indexPath: "/fathom/teams/_index.json",
        aliasPath: "/fathom/teams/by-id/Sales.json",
      },
      {
        model: "FathomTeamMember",
        record: {
          id: "alice.johnson@acme.com",
          name: "Alice Johnson",
          email: "alice.johnson@acme.com",
          created_at: now,
          team_name: "Sales",
        },
        canonicalPath: "/fathom/team-members/alice.johnson%40acme.com.json",
        indexPath: "/fathom/team-members/_index.json",
        aliasPath: "/fathom/team-members/by-id/alice.johnson%40acme.com.json",
      },
    ];

    for (const testCase of cases) {
      const result = await writeBatchToRelayfile(
        client,
        [testCase.record],
        fathomJob(testCase.model),
      );
      assert.equal(result.errors, 0, `${testCase.model} should not error`);
      assert.ok(client.files.has(testCase.canonicalPath), `${testCase.canonicalPath} missing`);
      assert.ok(client.files.has(testCase.aliasPath), `${testCase.aliasPath} missing`);

      const rows = JSON.parse(client.files.get(testCase.indexPath) ?? "[]") as Array<
        Record<string, unknown>
      >;
      assert.ok(rows.some((row) => row.id === testCase.record.id));
      if (testCase.model === "FathomMeeting") {
        const meetingRow = rows.find((row) => row.id === testCase.record.id) ?? {};
        assert.equal(meetingRow.day, "2026-05-25");
        assert.equal(meetingRow.team, "Sales");
        assert.equal(meetingRow.recordedBy, "alice.johnson@acme.com");
        assert.deepEqual(meetingRow.tags, [
          "day:2026-05-25",
          "recorded-by:alice.johnson@acme.com",
          "team:Sales",
        ]);
        assert.ok(
          client.files.has("/fathom/meetings/by-day/2026-05-25/_index.json"),
          "meeting by-day index missing",
        );
        assert.ok(
          client.files.has("/fathom/meetings/by-recorded-by/alice.johnson%40acme.com/_index.json"),
          "meeting by-recorded-by index missing",
        );
        assert.ok(
          client.files.has("/fathom/meetings/by-team/Sales/_index.json"),
          "meeting by-team index missing",
        );
      }
    }

    const report = await ensureProviderDiscoveryContractReport(client, "fathom", "rw_test");
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, 0);
  });

  it("docker-hub materializes canonical records, indexes, by-id aliases, and discovery", async () => {
    const client = makeMutableReadingClient();
    const cases: Array<{
      model: string;
      record: Record<string, unknown>;
      canonicalPath: string;
      indexPath: string;
      aliasPath: string;
      schemaPath: string;
      examplePath: string;
    }> = [
      {
        model: "DockerHubRepository",
        record: {
          id: "khaliqgant/cloud",
          namespace: "khaliqgant",
          name: "cloud",
          repository_type: "image",
          status: 1,
          is_private: true,
          star_count: 7,
          pull_count: 42,
          last_updated: "2026-05-22T18:00:00.000Z",
          html_url: "https://hub.docker.com/r/khaliqgant/cloud",
        },
        canonicalPath: "/docker-hub/repositories/khaliqgant/cloud.json",
        indexPath: "/docker-hub/repositories/_index.json",
        aliasPath: "/docker-hub/repositories/by-id/khaliqgant__cloud.json",
        schemaPath: "/discovery/docker-hub/repositories/.schema.json",
        examplePath: "/discovery/docker-hub/repositories/.create.example.json",
      },
      {
        model: "DockerHubTag",
        record: {
          id: "khaliqgant/cloud/latest",
          namespace: "khaliqgant",
          repository: "cloud",
          name: "latest",
          digest: "sha256:abc123",
          last_updated: "2026-05-22T19:00:00.000Z",
          html_url: "https://hub.docker.com/r/khaliqgant/cloud/tags?name=latest",
        },
        canonicalPath: "/docker-hub/repositories/khaliqgant/cloud/tags/latest.json",
        indexPath: "/docker-hub/tags/_index.json",
        aliasPath: "/docker-hub/tags/by-id/khaliqgant__cloud__latest.json",
        schemaPath:
          "/discovery/docker-hub/repositories/{namespace}/{repository}/tags/.schema.json",
        examplePath:
          "/discovery/docker-hub/repositories/{namespace}/{repository}/tags/.create.example.json",
      },
      {
        model: "DockerHubWebhook",
        record: {
          id: "khaliqgant/cloud/hook-1",
          webhook_id: "hook-1",
          namespace: "khaliqgant",
          repository: "cloud",
          name: "Release webhook",
          active: true,
          last_called: "2026-05-22T20:00:00.000Z",
        },
        canonicalPath: "/docker-hub/repositories/khaliqgant/cloud/webhooks/hook-1.json",
        indexPath: "/docker-hub/webhooks/_index.json",
        aliasPath: "/docker-hub/webhooks/by-id/hook-1.json",
        schemaPath:
          "/discovery/docker-hub/repositories/{namespace}/{repository}/webhooks/.schema.json",
        examplePath:
          "/discovery/docker-hub/repositories/{namespace}/{repository}/webhooks/.create.example.json",
      },
    ];

    for (const testCase of cases) {
      const result = await writeBatchToRelayfile(
        client,
        [testCase.record],
        dockerHubJob(testCase.model),
      );
      assert.equal(result.errors, 0, `${testCase.model} should not error`);
      assert.ok(client.files.has(testCase.canonicalPath), `${testCase.canonicalPath} missing`);
      assert.ok(client.files.has(testCase.aliasPath), `${testCase.aliasPath} missing`);
      const rows = JSON.parse(client.files.get(testCase.indexPath) ?? "[]") as Array<
        Record<string, unknown>
      >;
      assert.ok(rows.some((row) => row.id === testCase.record.id));
      assert.ok(
        schemaPropertyCount(client, testCase.schemaPath) > 0,
        `${testCase.schemaPath} should infer fields`,
      );
      assert.ok(
        createExamplePropertyCount(client, testCase.examplePath) > 0,
        `${testCase.examplePath} should not be {}`,
      );
    }

    for (const path of [...client.files.keys()]) {
      if (path.startsWith("/discovery/docker-hub/")) {
        client.files.delete(path);
      }
    }
    const report = await ensureProviderDiscoveryContractReport(
      client,
      "docker-hub",
      "rw_test",
    );
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, cases.length);
  });

  it("dropbox materializes metadata records, aliases, discovery contracts, and digest visibility", async () => {
    const client = makeMutableReadingClient();

    const cases = [
      {
        model: "DropboxFile",
        records: [
          {
            id: "/engineering/q2-plan.md",
            dropbox_id: "id:abc123",
            name: "q2-plan.md",
            path_lower: "/engineering/q2-plan.md",
            path_display: "/Engineering/Q2-Plan.md",
            rev: "a1c10ce0dd78",
            size: 1024,
            server_modified: "2026-05-25T08:00:00.000Z",
            client_modified: "2026-05-25T07:58:00.000Z",
          },
        ],
        canonicalPath: "/dropbox/files/q2-plan-md__%2Fengineering%2Fq2-plan.md.json",
        indexPath: "/dropbox/files/_index.json",
        aliasPath: "/dropbox/files/by-id/id%3Aabc123.json",
        schemaPath: "/discovery/dropbox/files/.schema.json",
        examplePath: "/discovery/dropbox/files/.create.example.json",
      },
      {
        model: "DropboxFolder",
        records: [
          {
            id: "/engineering",
            dropbox_id: "id:folder123",
            name: "Engineering",
            path_lower: "/engineering",
            path_display: "/Engineering",
          },
        ],
        canonicalPath: "/dropbox/folders/engineering__%2Fengineering.json",
        indexPath: "/dropbox/folders/_index.json",
        aliasPath: "/dropbox/folders/by-id/id%3Afolder123.json",
        schemaPath: "/discovery/dropbox/folders/.schema.json",
        examplePath: "/discovery/dropbox/folders/.create.example.json",
      },
      {
        model: "DropboxSharedFolder",
        records: [
          {
            id: "845281924",
            shared_folder_id: "845281924",
            shared_folder_name: "Finance Shared",
          },
        ],
        canonicalPath: "/dropbox/shared-folders/finance-shared__845281924.json",
        indexPath: "/dropbox/shared-folders/_index.json",
        aliasPath: "/dropbox/shared-folders/by-id/845281924.json",
        schemaPath: "/discovery/dropbox/shared-folders/.schema.json",
        examplePath: "/discovery/dropbox/shared-folders/.create.example.json",
      },
      {
        model: "DropboxSharedLink",
        records: [
          {
            id: "sl:ZXhhbXBsZS1saW5r",
            name: "Q2 Plan Link",
            url: "https://www.dropbox.com/scl/fi/example/q2-plan.md",
          },
        ],
        canonicalPath: "/dropbox/shared-links/q2-plan-link__sl%3AZXhhbXBsZS1saW5r.json",
        indexPath: "/dropbox/shared-links/_index.json",
        aliasPath: "/dropbox/shared-links/by-id/sl%3AZXhhbXBsZS1saW5r.json",
        schemaPath: "/discovery/dropbox/shared-links/.schema.json",
        examplePath: "/discovery/dropbox/shared-links/.create.example.json",
      },
    ] as const;

    for (const testCase of cases) {
      await writeBatchToRelayfile(
        client,
        testCase.records,
        {
          type: "nango_sync",
          workspaceId: "rw_test",
          provider: "dropbox",
          providerConfigKey: "dropbox-relay",
          connectionId: "conn_test",
          syncName: `fetch-${testCase.model.toLowerCase()}`,
          model: testCase.model,
          cursor: null,
          modifiedAfter: "1970-01-01T00:00:00.000Z",
        },
      );

      assert.ok(client.files.has(testCase.canonicalPath));
      assert.ok(client.files.has(testCase.indexPath));
      assert.ok(client.files.has(testCase.aliasPath));
      assert.ok(client.files.has(testCase.schemaPath));
      assert.ok(client.files.has(testCase.examplePath));
      assert.ok(
        schemaPropertyCount(client, testCase.schemaPath) > 0,
        `expected non-empty schema properties for ${testCase.schemaPath}`,
      );
      assert.ok(
        createExamplePropertyCount(client, testCase.examplePath) > 0,
        `expected non-empty create example for ${testCase.examplePath}`,
      );
    }

    for (const path of [...client.files.keys()]) {
      if (path.startsWith("/discovery/dropbox/")) {
        client.files.delete(path);
      }
    }
    const report = await ensureProviderDiscoveryContractReport(
      client,
      "dropbox",
      "rw_test",
    );
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, cases.length);
  });

  it("gcp materializes canonical records, indexes, discovery contracts, terminal-state updates, and digest visibility", async () => {
    const client = makeMutableReadingClient();

    const cloudRunRecord = {
      id: "nightcto-production-api",
      serviceName: "nightcto-production-api",
      region: "us-central1",
      latestRevision: "nightcto-production-api-00019-x2z",
      ready: false,
      url: "https://nightcto-production-api-uc.a.run.app",
      lastModified: "2026-06-17T08:57:19.754424Z",
    };
    const firingAlert = {
      id: "17163008471956214188",
      policyId: "17163008471956214188",
      displayName: "nightcto-production-relay-entrypoint-errors",
      enabled: true,
      conditionsSummary: "relay-entrypoint ERROR logs",
      firing: true,
      lastIncidentTs: "2026-06-17T07:26:24Z",
      state: "open",
    };
    const resolvedAlert = {
      ...firingAlert,
      firing: false,
      state: "closed",
      lastIncidentTs: "2026-06-17T08:02:10Z",
    };
    const billingRecord = {
      id: "billingAccounts/01A2B3-4C5D6E-7F8090",
      billingAccountId: "01A2B3-4C5D6E-7F8090",
      open: true,
      currency: "USD",
      amount: 137.42,
      capturedAt: "2026-06-17T09:20:00.000Z",
    };
    const errorGroupRecord = {
      id: "group-123",
      groupId: "group-123",
      resolutionStatus: "OPEN",
      count: 4,
      affectedUsersCount: 2,
      service: "nightcto-production-api",
      exceptionType: "TypeError",
      exceptionMessage: "undefined is not a function",
      lastSeenTime: "2026-06-17T09:25:00.000Z",
    };

    await writeBatchToRelayfile(client, [cloudRunRecord], gcpJob("GcpCloudRunService"));
    await writeBatchToRelayfile(client, [firingAlert], gcpJob("GcpMonitoringAlert"));
    await writeBatchToRelayfile(client, [billingRecord], gcpJob("GcpBilling"));
    await writeBatchToRelayfile(client, [errorGroupRecord], gcpJob("GcpErrorGroup"));
    await writeBatchToRelayfile(client, [resolvedAlert], gcpJob("GcpMonitoringAlert"));

    const cloudRunCanonical = "/gcp/run/services/nightcto-production-api.json";
    const cloudRunIndex = "/gcp/run/services/_index.json";
    const cloudRunAlias = "/gcp/run/services/by-id/nightcto-production-api.json";
    const alertCanonical = "/gcp/monitoring/alerts/17163008471956214188.json";
    const alertIndex = "/gcp/monitoring/alerts/_index.json";
    const alertAlias = "/gcp/monitoring/alerts/by-id/17163008471956214188.json";
    const billingCanonical = "/gcp/billing/current.json";
    const billingIndex = "/gcp/billing/_index.json";
    const errorGroupCanonical = "/gcp/error-reporting/groups/group-123.json";
    const errorGroupIndex = "/gcp/error-reporting/groups/_index.json";
    const errorGroupAlias = "/gcp/error-reporting/groups/by-id/group-123.json";

    for (const path of [
      cloudRunCanonical,
      cloudRunIndex,
      cloudRunAlias,
      alertCanonical,
      alertIndex,
      alertAlias,
      billingCanonical,
      billingIndex,
      errorGroupCanonical,
      errorGroupIndex,
      errorGroupAlias,
      "/discovery/gcp/cloud-run-services/.schema.json",
      "/discovery/gcp/cloud-run-services/.create.example.json",
      "/discovery/gcp/monitoring-alerts/.schema.json",
      "/discovery/gcp/monitoring-alerts/.create.example.json",
      "/discovery/gcp/billing/.schema.json",
      "/discovery/gcp/billing/.create.example.json",
      "/discovery/gcp/error-reporting-groups/.schema.json",
      "/discovery/gcp/error-reporting-groups/.create.example.json",
    ]) {
      assert.ok(client.files.has(path), `${path} missing`);
    }

    assert.ok(
      schemaPropertyCount(client, "/discovery/gcp/cloud-run-services/.schema.json") > 0,
    );
    assert.ok(
      schemaPropertyCount(client, "/discovery/gcp/monitoring-alerts/.schema.json") > 0,
    );
    assert.ok(
      schemaPropertyCount(client, "/discovery/gcp/billing/.schema.json") > 0,
    );
    assert.ok(
      schemaPropertyCount(client, "/discovery/gcp/error-reporting-groups/.schema.json") > 0,
    );

    const alertEnvelope = readJsonFile(client, alertCanonical);
    const alertPayload =
      (alertEnvelope.payload as Record<string, unknown> | undefined) ??
      alertEnvelope;
    assert.equal(alertPayload.firing, false);
    assert.equal(alertPayload.state, "closed");

    await assertTodayDigestIncludes(
      "gcp",
      alertCanonical,
      client.files.get(alertCanonical)!,
    );

    for (const path of [...client.files.keys()]) {
      if (path.startsWith("/discovery/gcp/")) {
        client.files.delete(path);
      }
    }
    const report = await ensureProviderDiscoveryContractReport(client, "gcp", "rw_test");
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, 4);
  });

  it("cloudflare materializes canonical records, indexes, aliases, discovery contracts, and terminal-state notification updates", async () => {
    const client = makeMutableReadingClient();

    const workerScriptRecord = {
      id: "relayfile",
      source: "cloudflare",
      kind: "inventory",
      occurred_at: "2026-06-18T08:00:00.000Z",
      severity: "low",
      title: "Cloudflare Worker relayfile",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/relayfile",
      account_id: "account-1",
      script_name: "relayfile",
      modified_on: "2026-06-18T08:00:00.000Z",
    };
    const workerUsageRecord = {
      id: "relayfile",
      source: "cloudflare",
      kind: "runtime",
      occurred_at: "2026-06-18T09:00:00.000Z",
      severity: "medium",
      title: "Cloudflare Worker relayfile traffic window",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/relayfile",
      account_id: "account-1",
      script_name: "relayfile",
      window_start: "2026-06-17T09:00:00.000Z",
      window_end: "2026-06-18T09:00:00.000Z",
      requests: 120000,
      errors: 0,
      subrequests: 420,
      cpu_time_p99: 720,
      captured_at: "2026-06-18T09:00:00.000Z",
    };
    const pagesProjectRecord = {
      id: "relayfile-pages",
      source: "cloudflare",
      kind: "inventory",
      occurred_at: "2026-06-18T08:10:00.000Z",
      severity: "low",
      title: "Cloudflare Pages project relayfile-pages",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/relayfile-pages",
      account_id: "account-1",
      name: "relayfile-pages",
      subdomain: "relayfile-pages.pages.dev",
      created_on: "2026-06-10T00:00:00.000Z",
    };
    const d1Record = {
      id: "d1-main",
      source: "cloudflare",
      kind: "inventory",
      occurred_at: "2026-06-18T08:12:00.000Z",
      severity: "low",
      title: "Cloudflare D1 database d1-main",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/d1-main",
      account_id: "account-1",
      name: "d1-main",
      created_at: "2026-06-10T00:00:00.000Z",
      modified_at: "2026-06-18T08:12:00.000Z",
    };
    const kvRecord = {
      id: "kv-cache",
      source: "cloudflare",
      kind: "inventory",
      occurred_at: "2026-06-18T08:15:00.000Z",
      severity: "low",
      title: "Cloudflare KV namespace relayfile-cache",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/storage/kv/namespaces/kv-cache",
      account_id: "account-1",
      namespace_title: "relayfile-cache",
    };
    const r2Record = {
      id: "relayfile-r2",
      source: "cloudflare",
      kind: "inventory",
      occurred_at: "2026-06-18T08:16:00.000Z",
      severity: "low",
      title: "Cloudflare R2 bucket relayfile-r2",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/r2/buckets/relayfile-r2",
      account_id: "account-1",
      name: "relayfile-r2",
      creation_date: "2026-06-10T00:00:00.000Z",
    };
    const queueRecord = {
      id: "relayfile-jobs",
      source: "cloudflare",
      kind: "runtime",
      occurred_at: "2026-06-18T08:18:00.000Z",
      severity: "medium",
      title: "Cloudflare Queue relayfile-jobs",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/queues/relayfile-jobs",
      account_id: "account-1",
      name: "relayfile-jobs",
      producers: 2,
      consumers: 1,
      modified_on: "2026-06-18T08:18:00.000Z",
    };
    const tunnelRecord = {
      id: "relayfile-tunnel",
      source: "cloudflare",
      kind: "runtime",
      occurred_at: "2026-06-18T08:20:00.000Z",
      severity: "low",
      title: "Cloudflare Tunnel relayfile-tunnel healthy",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/cfd_tunnel/relayfile-tunnel",
      account_id: "account-1",
      name: "relayfile-tunnel",
      status: "healthy",
      created_at: "2026-06-10T00:00:00.000Z",
    };
    const zoneRecord = {
      id: "zone-1",
      source: "cloudflare",
      kind: "inventory",
      occurred_at: "2026-06-18T08:22:00.000Z",
      severity: "low",
      title: "Cloudflare zone relayfile.dev",
      url: "https://api.cloudflare.com/client/v4/zones/zone-1",
      account_id: "account-1",
      account_name: "Agent Workforce",
      name: "relayfile.dev",
      status: "active",
      modified_on: "2026-06-18T08:22:00.000Z",
    };
    const dnsRecord = {
      id: "dns-1",
      source: "cloudflare",
      kind: "inventory",
      occurred_at: "2026-06-18T08:23:00.000Z",
      severity: "low",
      title: "Cloudflare DNS CNAME api.relayfile.dev",
      url: "https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/dns-1",
      zone_id: "zone-1",
      zone_name: "relayfile.dev",
      name: "api.relayfile.dev",
      type: "CNAME",
      content: "relayfile.pages.dev",
      modified_on: "2026-06-18T08:23:00.000Z",
    };
    const notificationWebhook = {
      id: "nightcto-webhook",
      source: "cloudflare",
      kind: "inventory",
      occurred_at: "2026-06-18T08:24:00.000Z",
      severity: "low",
      title: "Cloudflare notification webhook nightcto-webhook",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/alerting/v3/destinations/webhooks/nightcto-webhook",
      account_id: "account-1",
      name: "nightcto-webhook",
      last_success: "2026-06-18T08:24:00.000Z",
    };
    const notificationPolicy = {
      id: "workers-alerts",
      source: "cloudflare",
      kind: "advisory",
      occurred_at: "2026-06-18T08:25:00.000Z",
      severity: "low",
      title: "Cloudflare alert policy Workers alerts",
      url: "https://api.cloudflare.com/client/v4/accounts/account-1/alerting/v3/policies/workers-alerts",
      account_id: "account-1",
      name: "Workers alerts",
      alert_type: "workers_alert",
      enabled: true,
      modified: "2026-06-18T08:25:00.000Z",
    };
    const activeNotificationEvent = {
      id: "corr-1",
      source: "cloudflare",
      kind: "runtime",
      occurred_at: "2026-06-18T08:30:00.000Z",
      severity: "high",
      title: "Cloudflare workers_alert active",
      url: "https://developers.cloudflare.com/notifications/",
      account_id: "account-1",
      policy_id: "workers-alerts",
      policy_name: "Workers alerts",
      alert_type: "workers_alert",
      alert_event: "WORKERS_ANOMALY_DETECTED_START",
      correlation_id: "corr-1",
      state: "active",
      text: "relayfile request anomalies detected",
      timestamp: "2026-06-18T08:30:00.000Z",
      data: { zone_tag: "zone-1", zone_name: "relayfile.dev" },
    };
    const resolvedNotificationEvent = {
      ...activeNotificationEvent,
      occurred_at: "2026-06-18T08:42:00.000Z",
      severity: "low",
      title: "Cloudflare workers_alert resolved",
      alert_event: "WORKERS_ANOMALY_DETECTED_END",
      state: "resolved",
      timestamp: "2026-06-18T08:42:00.000Z",
    };

    await writeBatchToRelayfile(client, [workerScriptRecord], cloudflareJob("CloudflareWorkerScript"));
    await writeBatchToRelayfile(client, [workerUsageRecord], cloudflareJob("CloudflareWorkerUsage"));
    await writeBatchToRelayfile(client, [pagesProjectRecord], cloudflareJob("CloudflarePagesProject"));
    await writeBatchToRelayfile(client, [d1Record], cloudflareJob("CloudflareD1Database"));
    await writeBatchToRelayfile(client, [kvRecord], cloudflareJob("CloudflareKvNamespace"));
    await writeBatchToRelayfile(client, [r2Record], cloudflareJob("CloudflareR2Bucket"));
    await writeBatchToRelayfile(client, [queueRecord], cloudflareJob("CloudflareQueue"));
    await writeBatchToRelayfile(client, [tunnelRecord], cloudflareJob("CloudflareTunnel"));
    await writeBatchToRelayfile(client, [zoneRecord], cloudflareJob("CloudflareZone"));
    await writeBatchToRelayfile(client, [dnsRecord], cloudflareJob("CloudflareDnsRecord"));
    await writeBatchToRelayfile(client, [notificationWebhook], cloudflareJob("CloudflareNotificationWebhook"));
    await writeBatchToRelayfile(client, [notificationPolicy], cloudflareJob("CloudflareNotificationPolicy"));
    await writeBatchToRelayfile(client, [activeNotificationEvent], cloudflareJob("CloudflareNotificationEvent"));
    await writeBatchToRelayfile(client, [resolvedNotificationEvent], cloudflareJob("CloudflareNotificationEvent"));

    const notificationCanonical = "/cloudflare/notifications/events/corr-1.json";
    for (const path of [
      "/cloudflare/workers/scripts/relayfile.json",
      "/cloudflare/workers/scripts/_index.json",
      "/cloudflare/workers/scripts/by-id/relayfile.json",
      "/cloudflare/analytics/workers/scripts/relayfile.json",
      "/cloudflare/analytics/workers/scripts/_index.json",
      "/cloudflare/analytics/workers/scripts/by-id/relayfile.json",
      "/cloudflare/pages/projects/relayfile-pages.json",
      "/cloudflare/pages/projects/_index.json",
      "/cloudflare/pages/projects/by-id/relayfile-pages.json",
      "/cloudflare/d1/databases/d1-main.json",
      "/cloudflare/d1/databases/_index.json",
      "/cloudflare/d1/databases/by-id/d1-main.json",
      "/cloudflare/kv/namespaces/kv-cache.json",
      "/cloudflare/kv/namespaces/_index.json",
      "/cloudflare/kv/namespaces/by-id/kv-cache.json",
      "/cloudflare/r2/buckets/relayfile-r2.json",
      "/cloudflare/r2/buckets/_index.json",
      "/cloudflare/r2/buckets/by-id/relayfile-r2.json",
      "/cloudflare/queues/relayfile-jobs.json",
      "/cloudflare/queues/_index.json",
      "/cloudflare/queues/by-id/relayfile-jobs.json",
      "/cloudflare/tunnels/relayfile-tunnel.json",
      "/cloudflare/tunnels/_index.json",
      "/cloudflare/tunnels/by-id/relayfile-tunnel.json",
      "/cloudflare/zones/zone-1.json",
      "/cloudflare/zones/_index.json",
      "/cloudflare/zones/by-id/zone-1.json",
      "/cloudflare/zones/zone-1/dns-records/dns-1.json",
      "/cloudflare/zones/zone-1/dns-records/_index.json",
      "/cloudflare/zones/zone-1/dns-records/by-id/dns-1.json",
      "/cloudflare/notifications/webhooks/nightcto-webhook.json",
      "/cloudflare/notifications/webhooks/_index.json",
      "/cloudflare/notifications/webhooks/by-id/nightcto-webhook.json",
      "/cloudflare/notifications/policies/workers-alerts.json",
      "/cloudflare/notifications/policies/_index.json",
      "/cloudflare/notifications/policies/by-id/workers-alerts.json",
      notificationCanonical,
      "/cloudflare/notifications/events/_index.json",
      "/cloudflare/notifications/events/by-id/corr-1.json",
      "/discovery/cloudflare/workers-scripts/.schema.json",
      "/discovery/cloudflare/worker-usage/.schema.json",
      "/discovery/cloudflare/pages-projects/.schema.json",
      "/discovery/cloudflare/d1-databases/.schema.json",
      "/discovery/cloudflare/kv-namespaces/.schema.json",
      "/discovery/cloudflare/r2-buckets/.schema.json",
      "/discovery/cloudflare/queues/.schema.json",
      "/discovery/cloudflare/tunnels/.schema.json",
      "/discovery/cloudflare/zones/.schema.json",
      "/discovery/cloudflare/dns-records/.schema.json",
      "/discovery/cloudflare/notification-webhooks/.schema.json",
      "/discovery/cloudflare/notification-policies/.schema.json",
      "/discovery/cloudflare/notification-events/.schema.json",
    ]) {
      assert.ok(client.files.has(path), `${path} missing`);
    }

    for (const path of [
      "/discovery/cloudflare/workers-scripts/.schema.json",
      "/discovery/cloudflare/worker-usage/.schema.json",
      "/discovery/cloudflare/pages-projects/.schema.json",
      "/discovery/cloudflare/d1-databases/.schema.json",
      "/discovery/cloudflare/kv-namespaces/.schema.json",
      "/discovery/cloudflare/r2-buckets/.schema.json",
      "/discovery/cloudflare/queues/.schema.json",
      "/discovery/cloudflare/tunnels/.schema.json",
      "/discovery/cloudflare/zones/.schema.json",
      "/discovery/cloudflare/dns-records/.schema.json",
      "/discovery/cloudflare/notification-webhooks/.schema.json",
      "/discovery/cloudflare/notification-policies/.schema.json",
      "/discovery/cloudflare/notification-events/.schema.json",
    ]) {
      assert.ok(schemaPropertyCount(client, path) > 0, `${path} should infer fields`);
    }

    const notificationEnvelope = readJsonFile(client, notificationCanonical);
    const notificationPayload =
      (notificationEnvelope.payload as Record<string, unknown> | undefined) ??
      notificationEnvelope;
    assert.equal(notificationPayload.state, "resolved");
    assert.equal(notificationPayload._deleted, undefined);

    await assertTodayDigestIncludes(
      "cloudflare",
      notificationCanonical,
      client.files.get(notificationCanonical)!,
    );

    for (const path of [...client.files.keys()]) {
      if (path.startsWith("/discovery/cloudflare/")) {
        client.files.delete(path);
      }
    }
    const report = await ensureProviderDiscoveryContractReport(client, "cloudflare", "rw_test");
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, 13);
  });

  it("neon materializes canonical records, indexes, discovery contracts, terminal-state updates, and digest visibility", async () => {
    const client = makeMutableReadingClient();

    const organizationRecord = {
      id: "org-nightcto",
      source: "neon",
      kind: "inventory",
      occurred_at: "2026-06-17T08:00:00.000Z",
      severity: "info",
      title: "Neon organization NightCTO",
      url: "https://console.neon.tech/api/v2/users/me/organizations",
      name: "NightCTO",
      handle: "nightcto",
      plan: "scale",
      managed_by: "console",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-06-17T08:00:00.000Z",
    };
    const projectRecord = {
      id: "prj-nightcto",
      source: "neon",
      kind: "inventory",
      occurred_at: "2026-06-17T08:30:00.000Z",
      severity: "info",
      title: "Neon project nightcto-prod",
      url: "https://console.neon.tech/api/v2/projects/prj-nightcto",
      name: "nightcto-prod",
      org_id: "org-nightcto",
      org_name: "NightCTO",
      region_id: "aws-eu-central-1",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-06-17T08:30:00.000Z",
    };
    const branchRecord = {
      id: "br-nightcto-main",
      source: "neon",
      kind: "inventory",
      occurred_at: "2026-06-17T08:35:00.000Z",
      severity: "low",
      title: "Neon branch main",
      url: "https://console.neon.tech/api/v2/projects/prj-nightcto/branches/br-nightcto-main",
      project_id: "prj-nightcto",
      name: "main",
      current_state: "ready",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-06-17T08:35:00.000Z",
      default: true,
    };
    const endpointRecord = {
      id: "ep-nightcto-prod",
      source: "neon",
      kind: "runtime",
      occurred_at: "2026-06-17T08:40:00.000Z",
      severity: "high",
      title: "Neon endpoint ep-nightcto-prod suspended",
      url: "https://console.neon.tech/api/v2/projects/prj-nightcto/endpoints/ep-nightcto-prod",
      project_id: "prj-nightcto",
      branch_id: "br-nightcto-main",
      host: "ep-nightcto-prod.eu-central-1.aws.neon.tech",
      type: "read_write",
      current_state: "suspended",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-06-17T08:40:00.000Z",
    };
    const failedOperation = {
      id: "op-nightcto-1",
      source: "neon",
      kind: "runtime",
      occurred_at: "2026-06-17T08:45:00.000Z",
      severity: "critical",
      title: "Neon start_compute failed",
      url: "https://console.neon.tech/api/v2/projects/prj-nightcto/operations/op-nightcto-1",
      project_id: "prj-nightcto",
      branch_id: "br-nightcto-main",
      endpoint_id: "ep-nightcto-prod",
      action: "start_compute",
      status: "failed",
      error: "capacity unavailable",
      failures_count: 1,
      created_at: "2026-06-17T08:44:00.000Z",
      updated_at: "2026-06-17T08:45:00.000Z",
      total_duration_ms: 4200,
    };
    const cancelledOperation = {
      ...failedOperation,
      severity: "high",
      title: "Neon start_compute cancelled",
      status: "cancelled",
      updated_at: "2026-06-17T08:46:00.000Z",
      occurred_at: "2026-06-17T08:46:00.000Z",
    };
    const projectConsumptionRecord = {
      id: "prj-nightcto__compute_unit_seconds__2026-06-17T00:00:00Z",
      source: "neon",
      kind: "cost",
      occurred_at: "2026-06-17T23:59:59.000Z",
      severity: "high",
      title: "nightcto-prod compute_unit_seconds",
      url: "https://console.neon.tech/api/v2/consumption_history/v2/projects",
      org_id: "org-nightcto",
      project_id: "prj-nightcto",
      project_name: "nightcto-prod",
      metric: "compute_unit_seconds",
      value: 64000,
      granularity: "daily",
      period_id: "period-1",
      period_plan: "scale",
      period_start: "2026-06-01T00:00:00.000Z",
      period_end: "2026-07-01T00:00:00.000Z",
      timeframe_start: "2026-06-17T00:00:00.000Z",
      timeframe_end: "2026-06-18T00:00:00.000Z",
    };
    const branchConsumptionRecord = {
      id: "br-nightcto-main__compute_unit_seconds__2026-06-17T00:00:00Z",
      source: "neon",
      kind: "cost",
      occurred_at: "2026-06-17T23:59:59.000Z",
      severity: "medium",
      title: "main compute_unit_seconds",
      url: "https://console.neon.tech/api/v2/consumption_history/v2/branches",
      org_id: "org-nightcto",
      project_id: "prj-nightcto",
      branch_id: "br-nightcto-main",
      branch_name: "main",
      metric: "compute_unit_seconds",
      value: 12000,
      granularity: "daily",
      period_id: "period-1",
      period_plan: "scale",
      period_start: "2026-06-01T00:00:00.000Z",
      period_end: "2026-07-01T00:00:00.000Z",
      timeframe_start: "2026-06-17T00:00:00.000Z",
      timeframe_end: "2026-06-18T00:00:00.000Z",
    };
    const spendingLimitRecord = {
      id: "org-nightcto",
      source: "neon",
      kind: "cost",
      occurred_at: "2026-06-17T09:00:00.000Z",
      severity: "medium",
      title: "No Neon spending limit configured for NightCTO",
      url: "https://console.neon.tech/api/v2/organizations/org-nightcto/billing/spending_limit",
      org_id: "org-nightcto",
      org_name: "NightCTO",
      spending_limit_cents: null,
      fetch_status: "ok",
      captured_at: "2026-06-17T09:00:00.000Z",
    };
    const advisorIssueRecord = {
      id: "prj-nightcto__default__cache-1",
      source: "neon",
      kind: "advisory",
      occurred_at: "2026-06-17T09:10:00.000Z",
      severity: "critical",
      title: "RLS Disabled in Public",
      url: "https://neon.com/docs/data-api/database-advisor",
      project_id: "prj-nightcto",
      issue_name: "rls_disabled_in_public",
      level: "ERROR",
      facing: "EXTERNAL",
      categories: ["SECURITY"],
      description: "RLS is disabled.",
      detail: "Table public.users is exposed.",
      remediation: "https://neon.com/docs/data-api/database-advisor",
      cache_key: "cache-1",
      captured_at: "2026-06-17T09:10:00.000Z",
      metadata: {},
    };

    await writeBatchToRelayfile(client, [organizationRecord], neonJob("NeonOrganization"));
    await writeBatchToRelayfile(client, [projectRecord], neonJob("NeonProject"));
    await writeBatchToRelayfile(client, [branchRecord], neonJob("NeonBranch"));
    await writeBatchToRelayfile(client, [endpointRecord], neonJob("NeonEndpoint"));
    await writeBatchToRelayfile(client, [failedOperation], neonJob("NeonOperation"));
    await writeBatchToRelayfile(client, [projectConsumptionRecord], neonJob("NeonProjectConsumption"));
    await writeBatchToRelayfile(client, [branchConsumptionRecord], neonJob("NeonBranchConsumption"));
    await writeBatchToRelayfile(client, [spendingLimitRecord], neonJob("NeonSpendingLimit"));
    await writeBatchToRelayfile(client, [advisorIssueRecord], neonJob("NeonAdvisorIssue"));
    await writeBatchToRelayfile(client, [cancelledOperation], neonJob("NeonOperation"));

    const operationCanonical = "/neon/operations/op-nightcto-1.json";
    const operationIndex = "/neon/operations/_index.json";
    const operationAlias = "/neon/operations/by-id/op-nightcto-1.json";
    const projectCanonical = "/neon/projects/prj-nightcto.json";
    const branchCanonical = "/neon/branches/br-nightcto-main.json";
    const endpointCanonical = "/neon/endpoints/ep-nightcto-prod.json";
    const projectConsumptionCanonical =
      "/neon/consumption/projects/prj-nightcto__compute_unit_seconds__2026-06-17T00%3A00%3A00Z.json";
    const branchConsumptionCanonical =
      "/neon/consumption/branches/br-nightcto-main__compute_unit_seconds__2026-06-17T00%3A00%3A00Z.json";
    const spendingLimitCanonical = "/neon/spending-limits/org-nightcto.json";
    const advisorCanonical = "/neon/advisors/prj-nightcto__default__cache-1.json";

    for (const path of [
      "/neon/_index.json",
      "/neon/organizations/_index.json",
      projectCanonical,
      branchCanonical,
      endpointCanonical,
      operationCanonical,
      operationIndex,
      operationAlias,
      projectConsumptionCanonical,
      branchConsumptionCanonical,
      spendingLimitCanonical,
      advisorCanonical,
      "/discovery/neon/organizations/.schema.json",
      "/discovery/neon/projects/.schema.json",
      "/discovery/neon/branches/.schema.json",
      "/discovery/neon/endpoints/.schema.json",
      "/discovery/neon/operations/.schema.json",
      "/discovery/neon/project-consumption/.schema.json",
      "/discovery/neon/branch-consumption/.schema.json",
      "/discovery/neon/spending-limits/.schema.json",
      "/discovery/neon/advisor-issues/.schema.json",
    ]) {
      assert.ok(client.files.has(path), `${path} missing`);
    }

    for (const path of [
      "/discovery/neon/organizations/.schema.json",
      "/discovery/neon/projects/.schema.json",
      "/discovery/neon/branches/.schema.json",
      "/discovery/neon/endpoints/.schema.json",
      "/discovery/neon/operations/.schema.json",
      "/discovery/neon/project-consumption/.schema.json",
      "/discovery/neon/branch-consumption/.schema.json",
      "/discovery/neon/spending-limits/.schema.json",
      "/discovery/neon/advisor-issues/.schema.json",
    ]) {
      assert.ok(schemaPropertyCount(client, path) > 0, `${path} should infer fields`);
    }

    const operationEnvelope = readJsonFile(client, operationCanonical);
    const operationPayload =
      (operationEnvelope.payload as Record<string, unknown> | undefined) ??
      operationEnvelope;
    assert.equal(operationPayload.status, "cancelled");
    assert.equal(operationPayload._deleted, undefined);

    await assertTodayDigestIncludes(
      "neon",
      operationCanonical,
      client.files.get(operationCanonical)!,
    );

    for (const path of [...client.files.keys()]) {
      if (path.startsWith("/discovery/neon/")) {
        client.files.delete(path);
      }
    }
    const report = await ensureProviderDiscoveryContractReport(client, "neon", "rw_test");
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, 9);
  });

  it("reddit materializes canonical records, indexes, aliases, discovery contracts, and terminal-state visibility", async () => {
    const client = makeMutableReadingClient();

    const subredditRecord = {
      id: "agentrelay",
      name: "agentrelay",
      title: "Agent Relay",
      subscribers: 4200,
      tracked: true,
    };
    const activePost = {
      id: "agentrelay/abc123",
      post_id: "abc123",
      subreddit: "agentrelay",
      title: "Launch week recap",
      created_utc: 1770000000,
      status: "active",
    };
    const archivedPost = {
      ...activePost,
      status: "archived",
      archived: true,
    };

    await writeBatchToRelayfile(client, [subredditRecord], redditJob("RedditTrackedSubreddit"));
    await writeBatchToRelayfile(client, [activePost], redditJob("RedditPost"));
    await writeBatchToRelayfile(client, [archivedPost], redditJob("RedditPost"));

    const subredditCanonical = "/reddit/subreddits/agentrelay.json";
    const subredditAlias = "/reddit/subreddits/by-id/agentrelay.json";
    const subredditIndex = "/reddit/subreddits/_index.json";
    const postCanonical = "/reddit/subreddits/agentrelay/posts/launch-week-recap__abc123.json";
    const postAlias = "/reddit/posts/by-id/agentrelay__abc123.json";
    const postStatusAlias = "/reddit/posts/by-status/archived/agentrelay__abc123.json";
    const staleActiveAlias = "/reddit/posts/by-status/active/agentrelay__abc123.json";

    assert.ok(client.files.has(subredditCanonical));
    assert.ok(client.files.has(subredditAlias));
    assert.ok(client.files.has(subredditIndex));
    assert.ok(client.files.has(postCanonical));
    assert.ok(client.files.has(postAlias));
    assert.ok(client.files.has(postStatusAlias));
    assert.ok(!client.files.has(staleActiveAlias), "active status alias should be reconciled away");
    assert.ok(client.deletes.includes(staleActiveAlias));

    assert.ok(client.files.has("/discovery/reddit/subreddits/.schema.json"));
    assert.ok(client.files.has("/discovery/reddit/subreddits/.create.example.json"));
    assert.ok(client.files.has("/discovery/reddit/subreddits/{subreddit}/posts/.schema.json"));
    assert.ok(client.files.has("/discovery/reddit/subreddits/{subreddit}/posts/.create.example.json"));
    assert.ok(
      schemaPropertyCount(client, "/discovery/reddit/subreddits/.schema.json") > 0,
      "subreddit discovery schema should infer fields",
    );
    assert.ok(
      schemaPropertyCount(client, "/discovery/reddit/subreddits/{subreddit}/posts/.schema.json") > 0,
      "post discovery schema should infer fields",
    );
    assert.ok(
      createExamplePropertyCount(client, "/discovery/reddit/subreddits/.create.example.json") > 0,
      "subreddit create example should not be empty",
    );
    assert.ok(
      createExamplePropertyCount(client, "/discovery/reddit/subreddits/{subreddit}/posts/.create.example.json") > 0,
      "post create example should not be empty",
    );

    const canonicalEnvelope = readJsonFile(client, postCanonical);
    const payload = canonicalEnvelope.payload as Record<string, unknown>;
    assert.ok(payload && typeof payload === "object");
    assert.equal(payload.status, "archived");
    assert.equal(payload.archived, true);

    for (const path of [...client.files.keys()]) {
      if (path.startsWith("/discovery/reddit/")) {
        client.files.delete(path);
      }
    }
    const report = await ensureProviderDiscoveryContractReport(client, "reddit", "rw_test");
    assert.equal(report.status, "complete");
    assert.equal(report.sampledResources, 2);
  });
});

// ===========================================================================
// Canonical adapter registry — single add-point + structural drift prevention
// ===========================================================================

describe("resolveAdapter", () => {
  it("resolves every known provider id to its adapter", () => {
    const expected: Record<string, string> = {
      github: "github",
      gitlab: "gitlab",
      linear: "linear",
      notion: "notion",
      confluence: "confluence",
      jira: "jira",
      slack: "slack",
      telegram: "telegram",
      "telegram-relay": "telegram",
      "google-mail": "google-mail",
      "google-mail-relay": "google-mail",
      "google-calendar": "google-calendar",
      "google-calendar-relay": "google-calendar",
      granola: "granola",
      "granola-relay": "granola",
      fathom: "fathom",
      "fathom-relay": "fathom",
      "docker-hub": "docker-hub",
      "docker_hub-composio-relay": "docker-hub",
      "docker-hub-composio-relay": "docker-hub",
      reddit: "reddit",
      "reddit-composio-relay": "reddit",
      dropbox: "dropbox",
      "dropbox-relay": "dropbox",
      daytona: "daytona",
      gcp: "gcp",
      "gcp-relay": "gcp",
      neon: "neon",
      "neon-relay": "neon",
      "neon-composio-relay": "neon",
      x: "x",
      twitter: "x",
    };
    for (const [provider, id] of Object.entries(expected)) {
      assert.equal(
        resolveAdapter(provider)?.id,
        id,
        `resolveAdapter(${provider}) should be ${id}`,
      );
    }
  });

  it("maps any slack-* connection key to the slack adapter (prefix rule)", () => {
    assert.equal(resolveAdapter("slack-foo")?.id, "slack");
    assert.equal(resolveAdapter("slack-acme-prod")?.id, "slack");
    assert.equal(resolveAdapter("slack-")?.id, "slack");
  });

  it("returns undefined for unknown providers (old resourcesForProvider [] semantics)", () => {
    assert.equal(resolveAdapter("unknown"), undefined);
    assert.equal(resolveAdapter(""), undefined);
  });

  it("x adapter advertises no discovery contract and ships no resources", () => {
    const x = resolveAdapter("x");
    assert.ok(x);
    assert.equal(x?.resources.length, 0);
    const layout = x?.layoutPromptFile();
    assert.ok(layout);
    // Pre-refactor `resourcesForProvider("x")` returned [] => discovery
    // producer early-returned. Empty resources here preserves that.
    assert.doesNotMatch(
      layout?.content ?? "",
      /discovery\/[^\s`)]+\.schema\.json/,
    );
  });
});

describe("registry structural discovery-drift prevention", () => {
  it("every adapter registry entry owns sync-ingest bucketing", () => {
    for (const adapter of ADAPTERS) {
      assert.equal(
        typeof adapter.recordBucketing.bucketRecords,
        "function",
        `${adapter.id} must declare recordBucketing in ADAPTERS`,
      );
    }
  });

  it("every entry advertising discovery in LAYOUT exposes non-empty resources", () => {
    for (const adapter of ADAPTERS) {
      const layout = adapter.layoutPromptFile();
      const advertisesDiscovery = /discovery\/[^\s`)]+\.schema\.json/.test(
        layout.content,
      );
      const hasResources = adapter.resources.length > 0;

      // The core structural invariant: LAYOUT advertising and resources
      // cannot diverge because they come from the SAME registry entry.
      if (advertisesDiscovery) {
        assert.ok(
          hasResources,
          `${adapter.id} LAYOUT advertises discovery/...schema.json but exposes no resources`,
        );
      }
      // belt-and-braces: the kept consistency assert agrees on every entry.
      assert.equal(
        assertLayoutDiscoveryConsistency(
          adapter.id,
          layout.content,
          adapter.resources,
        ),
        true,
        `assertLayoutDiscoveryConsistency failed for ${adapter.id}`,
      );
    }
  });

  it("every entry exposing resources advertises them in its LAYOUT (except known resources-without-LAYOUT adapters)", () => {
    // slack, gitlab, docker-hub, and daytona ship resources without advertising the
    // discovery contract in LAYOUT (assertLayoutDiscoveryConsistency only
    // WARNs for these — discovery files are still produced). Encode that
    // known set so a regression in any OTHER adapter is caught.
    const knownResourcesWithoutLayout = new Set(["slack", "gitlab", "docker-hub", "daytona"]);
    for (const adapter of ADAPTERS) {
      if (adapter.resources.length === 0) continue;
      const advertises = /discovery\/[^\s`)]+\.schema\.json/.test(
        adapter.layoutPromptFile().content,
      );
      if (!advertises) {
        assert.ok(
          knownResourcesWithoutLayout.has(adapter.id),
          `${adapter.id} exposes resources but its LAYOUT does not advertise discovery and it is not a known exception`,
        );
      }
    }
  });
});

describe("new adapter added to ADAPTERS gets layout+discovery+aux with zero other edits", () => {
  it("simulates registering a fake adapter and asserts all three surfaces emit", async () => {
    const fakeResources = [
      {
        name: "widgets",
        schema: "discovery/fakeprov/widgets/.schema.json",
        createExample: "discovery/fakeprov/widgets/.create.example.json",
      },
    ] as unknown as RegisteredAdapter["resources"];

    let emitCalled = false;
    const fake: RegisteredAdapter = {
      id: "fakeprov",
      matches: (p) => p === "fakeprov",
      layoutPromptFile: () => ({
        path: "/fakeprov/LAYOUT.md",
        content:
          "# fakeprov\nRead `discovery/fakeprov/widgets/.schema.json` before writing.\n",
        contentType: "text/markdown; charset=utf-8",
      }),
      resources: fakeResources,
      recordBucketing: {
        bucketRecords: (records) => ({ widgets: [...records] }),
      },
      emitAuxiliaryFiles: async () => {
        emitCalled = true;
        return [];
      },
    };

    // Simulate the SINGLE add-point edit by pushing onto the registry.
    // A non-mutating injection would require adding an optional adapter-list
    // param to production `resolveAdapter`/`writeBatchToRelayfile` purely for
    // this test (they only ever read the module-level `ADAPTERS`), so we
    // mutate-and-restore instead. Safe because node:test runs tests
    // sequentially within a file (no concurrent reader sees the fake) and the
    // `finally` splice below always restores the registry.
    const mutable = ADAPTERS as RegisteredAdapter[];
    mutable.push(fake);
    try {
      const resolved = resolveAdapter("fakeprov");
      assert.equal(resolved?.id, "fakeprov");

      const client = makeReadingClient();
      const job: NangoSyncJob = {
        type: "nango_sync",
        workspaceId: "rw_test",
        provider: "fakeprov",
        providerConfigKey: "fakeprov-relay",
        connectionId: "conn_test",
        syncName: "fetch-widgets",
        model: "widgets",
        cursor: null,
        modifiedAfter: "1970-01-01T00:00:00.000Z",
      };

      await writeBatchToRelayfile(client, [{ id: "w1", name: "Widget" }], job);

      // 1. Layout surface emitted (provider LAYOUT.md from registry entry).
      assert.ok(
        client.writes.some((w) => w.path === "/fakeprov/LAYOUT.md"),
        "fake adapter LAYOUT.md not written",
      );
      // 2. Discovery surface emitted (driven off entry.resources).
      assert.ok(
        client.writes.some((w) =>
          w.path.startsWith("/discovery/fakeprov/widgets/"),
        ),
        "fake adapter discovery files not written",
      );
      // 3. Aux surface wired generically: the SAME resolved entry the
      //    aux dispatcher (`writeProviderAuxiliaryFiles`) uses exposes the
      //    closure; invoking it the way the dispatcher does proves the
      //    generic aux path reaches a newly-registered adapter with zero
      //    other edits. (The full batch gates aux behind applied canonical
      //    records — fakeprov has no canonical mapper — so the aux surface
      //    is asserted via the registry entry the dispatcher resolves.)
      await resolved!.emitAuxiliaryFiles(
        client,
        [{ id: "w1", name: "Widget" }],
        job,
      );
      assert.equal(emitCalled, true, "fake adapter emitAuxiliaryFiles not called");
    } finally {
      const idx = mutable.indexOf(fake);
      if (idx >= 0) mutable.splice(idx, 1);
    }
  });
});

describe("behavior identity: registry path == pre-refactor per-provider dispatch", () => {
  // Representative multi-provider batch. The per-provider loop below is a
  // cheap COUNT-LEVEL guard: it asserts only that the total number of writes
  // via the generic registry path matches the pre-refactor baseline (it does
  // NOT compare paths, ops, or order). The dedicated gitlab test below adds
  // an ORDERED path/op identity assertion (full deepEqual against a frozen
  // golden) for the bucketing/tombstone/tag-reconcile outlier where a
  // count-preserving order regression would otherwise pass silently.
  function job(
    provider: string,
    model: string,
    syncName: string,
  ): NangoSyncJob {
    return {
      type: "nango_sync",
      workspaceId: "rw_test",
      provider,
      providerConfigKey: `${provider}-relay`,
      connectionId: "conn_test",
      syncName,
      model,
      cursor: null,
      modifiedAfter: "1970-01-01T00:00:00.000Z",
    };
  }

  const batches: Array<[NangoSyncJob, Record<string, unknown>[], number]> = [
    // adapter-github 0.3.16 adds additional issue writeback discovery contract
    // files, increasing this frozen count by 2.
    [job("github", "GithubIssue", "fetch-issues"), [
      {
        id: "1",
        number: 1,
        title: "Bug",
        state: "open",
        repository: { full_name: "o/r" },
        html_url: "https://x",
        body: "b",
      },
    ], 13],
    [job("gitlab", "GitLabIssue", "fetch-issues"), [
      { id: 1, iid: 1, title: "GL bug", project_path: "g/p", state: "opened", web_url: "https://gl" },
    ], 16],
    // adapter-linear 0.3.16 adds project directory records plus by-state and
    // by-team project aliases; 0.3.17 adds the labels resource contract.
    [job("linear", "LinearIssue", "fetch-issues"), [
      { id: "L1", identifier: "ENG-1", title: "Linear issue", state: { name: "Todo" }, team: { key: "ENG" } },
    ], 25],
    [job("notion", "NotionPage", "fetch-pages"), [
      { id: "n1", title: "Page", parent_type: "workspace", url: "https://n" },
    ], 27],
    [job("confluence", "ConfluencePage", "fetch-pages"), [
      { id: "c1", title: "Conf page", spaceKey: "SP", _links: { webui: "/x" } },
    ], 13],
    [job("jira", "JiraIssue", "fetch-issues"), [
      { id: "j1", key: "PROJ-1", fields: { summary: "Jira", project: { key: "PROJ" } } },
    ], 20],
    [job("slack", "SlackMessage", "fetch-messages"), [
      { ts: "1.1", channel: "C1", text: "hi", user: "U1" },
    ], 14],
    [job("telegram", "TelegramMessage", "fetch-updates"), [
      { id: "8587455921:42", chatId: "8587455921", messageId: "42", chatTitle: "Agent Relay Bot Test", text: "hi" },
    ], 19],
    [job("x", "XPost", "fetch-posts"), [
      { id: "x1", text: "tweet", author_id: "a1" },
    ], 9],
  ];

  // Ordered op log: writes AND deletes/tombstones in the exact order they
  // occur (the split writes[]/deletes[] arrays on makeReadingClient lose
  // their relative interleave). Used by the gitlab ordered-identity guard.
  function makeOrderedLogClient(): RelayfileWriteClient & {
    ops: Array<{ path: string; op: "write" | "delete" }>;
  } {
    const ops: Array<{ path: string; op: "write" | "delete" }> = [];
    return {
      ops,
      async writeFile(input) {
        ops.push({ path: input.path, op: "write" });
      },
      async deleteFile(input) {
        ops.push({ path: input.path, op: "delete" });
      },
      async readFile() {
        const err = new Error("not found") as Error & { status: number };
        err.status = 404;
        throw err;
      },
    };
  }

  // Captured pre-refactor-equivalent baseline: the REAL ordered output of the
  // gitlab batch below on the current (correct, byte-identical) branch HEAD,
  // before any further refactor. Frozen here so a future regression that
  // flips write/delete ORDER, the gitlab bucketing emit order, the
  // tombstone-delete sequence, the tag-reconcile order, or the multi-source
  // error-array concatenation order is caught even when the COUNT is
  // unchanged (which the per-provider count loop below cannot detect).
  const GITLAB_ORDERED_GOLDEN: ReadonlyArray<{
    path: string;
    op: "write" | "delete";
  }> = [
    { path: "/gitlab/projects/g/p/issues/1__gl-bug/meta.json", op: "write" },
    { path: "/LAYOUT.md", op: "write" },
    { path: "/gitlab/LAYOUT.md", op: "write" },
    {
      path: "/discovery/gitlab/projects/{projectPath}/merge_requests/{mergeRequestIid}__{slug}/discussions/.schema.json",
      op: "write",
    },
    {
      path: "/discovery/gitlab/projects/{projectPath}/merge_requests/{mergeRequestIid}__{slug}/discussions/.create.example.json",
      op: "write",
    },
    {
      path: "/discovery/gitlab/projects/{projectPath}/issues/{issueIid}__{slug}/comments/.schema.json",
      op: "write",
    },
    {
      path: "/discovery/gitlab/projects/{projectPath}/issues/{issueIid}__{slug}/comments/.create.example.json",
      op: "write",
    },
    { path: "/discovery/gitlab/.adapter.md", op: "write" },
    { path: "/gitlab/_index.json", op: "write" },
    { path: "/gitlab/LAYOUT.md", op: "write" },
    { path: "/gitlab/projects/g/p/issues/1__gl-bug/meta.json", op: "write" },
    { path: "/gitlab/projects/g/p/issues/by-id/1.json", op: "write" },
    {
      path: "/gitlab/projects/g/p/issues/by-title/gl-bug__1.json",
      op: "write",
    },
    {
      path: "/gitlab/projects/g/p/issues/by-state/opened/1.json",
      op: "write",
    },
    { path: "/gitlab/projects/_index.json", op: "write" },
    { path: "/gitlab/projects/g/p/issues/_index.json", op: "write" },
  ];

  it("gitlab registry path emits identical write paths, ops, and order vs pre-refactor baseline", async () => {
    const j = job("gitlab", "GitLabIssue", "fetch-issues");
    const records = [
      {
        id: 1,
        iid: 1,
        title: "GL bug",
        project_path: "g/p",
        state: "opened",
        web_url: "https://gl",
      },
    ];
    const client = makeOrderedLogClient();
    await writeBatchToRelayfile(client, records, j);
    assert.deepEqual(client.ops, GITLAB_ORDERED_GOLDEN);
  });

  for (const [j, records, expectedWriteCount] of batches) {
    it(`${j.provider} produces the same write count via the generic registry path`, async () => {
      const client = makeReadingClient();
      await writeBatchToRelayfile(client, records, j);
      assert.equal(
        client.writes.length,
        expectedWriteCount,
        `${j.provider} write count drifted from pre-refactor baseline`,
      );
      // Slack maps via the prefix rule; assert slack-foo behaves identically.
      if (j.provider === "slack") {
        const prefixed = makeReadingClient();
        await writeBatchToRelayfile(prefixed, records, {
          ...j,
          provider: "slack-foo",
          providerConfigKey: "slack-foo-relay",
        });
        assert.equal(
          prefixed.writes.length,
          expectedWriteCount,
          "slack-foo did not resolve to slack adapter behaviour",
        );
      }
    });
  }
});

describe("writeBatchToRelayfile error.cause surfacing (B4-OBS)", () => {
  it("surfaces drizzle wrapper + PG `code` end-to-end on a failed per-record write (#743 regression guard)", async () => {
    // Simulate the exact #743 shape that hid the real root cause: drizzle
    // wraps a pg error with a generic "Failed query" message, and the pg
    // error in `cause` carries the actionable `code`. Pre-fix, the
    // per-record `console.error("Nango record write failed", ...)` logged
    // `error.message` alone — "Failed query" — making the actionable PG
    // code invisible.
    const pgError = new Error('relation "x" does not exist');
    Object.assign(pgError, {
      name: "PostgresError",
      code: "42P01",
      table: "nango_sync_dedup",
      severity: "ERROR",
    });
    const drizzleErr = new Error("Failed query: insert into nango_sync_dedup", {
      cause: pgError,
    });

    const failingClient: RelayfileWriteClient = {
      async writeFile() {
        throw drizzleErr;
      },
      async deleteFile() {
        // unused for this test
      },
    };

    const errorCalls: Array<unknown[]> = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      errorCalls.push(args);
    }) as Console["error"];

    try {
      const result = await writeBatchToRelayfile(
        failingClient,
        [{ id: "ABC-1", summary: "x" }],
        // confluence is a parity-enabled provider so the planner doesn't
        // reject before the write attempt.
        {
          type: "nango_sync",
          workspaceId: "rw_test",
          provider: "confluence",
          providerConfigKey: "confluence-relay",
          connectionId: "conn_test",
          syncName: "fetch-spaces",
          model: "ConfluenceSpace",
          cursor: null,
          modifiedAfter: "1970-01-01T00:00:00.000Z",
        },
      );

      // The batch counts the failed record as an error and keeps going.
      assert.equal(result.errors >= 1, true);

      // Find the per-record write-failed log emission.
      const recordLogs = errorCalls.filter((args) => {
        const label = args[0];
        return typeof label === "string" && label === "Nango record write failed";
      });
      assert.ok(recordLogs.length >= 1, "expected one record-write error log");

      const payload = recordLogs[0][1] as Record<string, unknown>;
      // Non-vacuous F0-rigor: the surfaced fields MUST include a non-empty
      // PG code drawn from the deeper `cause`, NOT just the wrapper message.
      assert.equal(payload.errorCode, "42P01");
      assert.equal(typeof payload.errorCode === "string", true);
      assert.ok(
        (payload.errorCode as string).length > 0,
        "errorCode must be a non-empty string at the per-record error log",
      );
      assert.equal(payload.errorMessage, "Failed query: insert into nango_sync_dedup");
      const chain = payload.errorCauseChain as Array<Record<string, unknown>>;
      assert.equal(chain.length, 2);
      assert.equal(chain[1].code, "42P01");
      assert.equal(chain[1].table, "nango_sync_dedup");
      assert.equal(chain[1].severity, "ERROR");
    } finally {
      console.error = original;
    }
  });
});
