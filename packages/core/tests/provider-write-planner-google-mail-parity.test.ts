import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import {
  planProviderRecordWrites,
  providerModelKey,
} from "../src/sync/provider-write-planner.js";
import {
  assertHasPath,
  assertMalformedNangoMessageAcked,
  assertTodayDigestIncludes,
  assertWriterEmitsPaths,
  planSmokeWrites,
  writeByPath,
} from "./provider-write-planner-smoke-helpers.js";

const googleMailMessage = {
  id: "m-1",
  threadId: "t-1",
  labelIds: ["INBOX", "CATEGORY_UPDATES"],
  snippet: "hello world",
  historyId: "h1",
  internalDate: "1715600000000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "Subject", value: "Digest Alpha" },
      { name: "From", value: "Alice Example <alice@example.com>" },
      { name: "To", value: "Bob Example <bob@example.com>" },
      { name: "Date", value: "Wed, 20 May 2026 10:37:00 +0000" },
    ],
    parts: [
      {
        partId: "0",
        mimeType: "text/plain",
        body: {
          data: Buffer.from("hello decoded world", "utf8").toString("base64url"),
          size: 19,
        },
      },
      {
        partId: "1",
        mimeType: "text/html",
        body: {
          data: Buffer.from("<p>hello decoded world</p>", "utf8").toString("base64url"),
          size: 26,
        },
      },
    ],
  },
};

const flattenedGoogleMailMessage = {
  id: googleMailMessage.id,
  threadId: googleMailMessage.threadId,
  labelIds: googleMailMessage.labelIds,
  snippet: googleMailMessage.snippet,
  historyId: googleMailMessage.historyId,
  internalDate: googleMailMessage.internalDate,
  subject: "Digest Alpha",
  from: "Alice Example <alice@example.com>",
  to: "Bob Example <bob@example.com>",
  cc: null,
  bcc: null,
  date: "Wed, 20 May 2026 10:37:00 +0000",
  messageId: null,
  inReplyTo: null,
  references: null,
  body_text: "hello decoded world",
  body_html: "<p>hello decoded world</p>",
  attachments: [],
};

const samples = {
  GoogleMailLabel: {
    id: "INBOX",
    name: "Inbox",
    type: "system",
    messagesTotal: 10,
    raw_json: "{\"id\":\"INBOX\",\"name\":\"Inbox\"}",
  },
  GoogleMailFilter: {
    id: "filter-1",
    from: "alice@example.com",
    addLabelIds: ["Label_1"],
  },
  GoogleMailSendAsAlias: {
    id: "alice@example.com",
    sendAsEmail: "alice@example.com",
    displayName: "Alice Example",
    isPrimary: true,
  },
  GoogleMailMessage: flattenedGoogleMailMessage,
  GoogleMailThread: {
    id: "t-1",
    historyId: "h1",
    snippet: "thread snippet",
    messageIds: ["m-1"],
    messageCount: 1,
    messages: [
      {
        id: "m-1",
        threadId: "t-1",
        labelIds: ["INBOX", "CATEGORY_UPDATES"],
        snippet: "hello world",
        historyId: "h1",
        internalDate: "1715600000000",
        subject: "Digest Alpha",
        from: "Alice Example <alice@example.com>",
        to: "Bob Example <bob@example.com>",
        date: "Wed, 20 May 2026 10:37:00 +0000",
      },
    ],
  },
  GoogleMailWatchRenewal: {
    id: "gmail-watch-1",
    topicName: "projects/demo/topics/gmail",
    labelIdsJson: "[\"INBOX\"]",
    labelFilterBehavior: "include",
    historyId: "h1",
    expiration: "1893456000000",
    renewed_at: "2026-05-20T09:00:00.000Z",
  },
};

const schemas = {
  GoogleMailLabel: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    messagesTotal: z.number().int().optional(),
    raw_json: z.string(),
  }),
  GoogleMailFilter: z.object({
    id: z.string(),
    from: z.string().optional(),
    addLabelIds: z.array(z.string()).optional(),
  }),
  GoogleMailSendAsAlias: z.object({
    id: z.string(),
    sendAsEmail: z.string(),
    displayName: z.string().optional(),
    isPrimary: z.boolean().optional(),
  }),
  GoogleMailMessage: z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
    snippet: z.string().optional(),
    historyId: z.string(),
    internalDate: z.string(),
    subject: z.string().nullable(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    cc: z.string().nullable(),
    bcc: z.string().nullable(),
    date: z.string().nullable(),
    messageId: z.string().nullable(),
    inReplyTo: z.string().nullable(),
    references: z.string().nullable(),
    body_text: z.string().nullable(),
    body_html: z.string().nullable(),
    attachments: z.array(z.object({
      filename: z.string().nullable(),
      mimeType: z.string().nullable(),
      size: z.number().nullable(),
      attachmentId: z.string().nullable(),
      partId: z.string().nullable(),
    })),
  }),
  GoogleMailThread: z.object({
    id: z.string(),
    historyId: z.string(),
    snippet: z.string().optional(),
    messageIds: z.array(z.string()),
    messageCount: z.number().int(),
    messages: z.array(z.object({
      id: z.string(),
      threadId: z.string(),
      labelIds: z.array(z.string()).optional(),
      historyId: z.string().optional(),
    }).passthrough()).optional(),
  }),
  GoogleMailWatchRenewal: z.object({
    id: z.string(),
    topicName: z.string(),
    labelIdsJson: z.string().optional(),
    labelFilterBehavior: z.enum(["include", "exclude"]).optional(),
    historyId: z.string(),
    expiration: z.string(),
    renewed_at: z.string(),
  }),
};

function googleMailJob(): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "google-mail",
    providerConfigKey: "google-mail-relay",
    connectionId: "conn_test",
    syncName: "fetch-messages",
    model: "GoogleMailMessage",
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function googleMailThreadJob(): NangoSyncJob {
  return {
    ...googleMailJob(),
    syncName: "fetch-threads",
    model: "GoogleMailThread",
  };
}

describe("google-mail-relay smoke parity", () => {
  it("sampled records satisfy the declared zod contracts", () => {
    for (const [model, schema] of Object.entries(schemas)) {
      assert.ok(
        schema.safeParse(samples[model as keyof typeof samples]).success,
        `${model} sample should satisfy schema`,
      );
    }
  });

  it("plans and writes canonical, index, and one by-* alias path", async () => {
    const expected = [
      "/google-mail/messages/m-1.json",
      "/google-mail/messages/_index.json",
      "/google-mail/messages/by-thread/t-1/_index.json",
    ];
    const writes = planSmokeWrites(googleMailJob(), googleMailMessage);
    for (const path of expected) assertHasPath(writes, path);

    await assertWriterEmitsPaths(googleMailJob(), googleMailMessage, expected);
  });

  it("plans flattened readable message content without storing raw Gmail payloads", () => {
    const writes = planSmokeWrites(googleMailJob(), googleMailMessage);
    const canonical = JSON.parse(
      writeByPath(writes, "/google-mail/messages/m-1.json").contents as string,
    ) as Record<string, unknown>;

    assert.equal(canonical.subject, "Digest Alpha");
    assert.equal(canonical.from, "Alice Example <alice@example.com>");
    assert.equal(canonical.to, "Bob Example <bob@example.com>");
    assert.equal(canonical.body_text, "hello decoded world");
    assert.equal(canonical.body_html, "<p>hello decoded world</p>");
    assert.deepEqual(canonical.attachments, []);
    assert.equal("payload" in canonical, false);
    assert.equal("raw_json" in canonical, false);
  });

  it("preserves already-flattened readable message content without payload", () => {
    const alreadyFlattened = {
      id: "m-flat",
      threadId: "t-flat",
      labelIds: ["INBOX"],
      snippet: "stored body",
      historyId: "h2",
      internalDate: "1715600000000",
      subject: "Already Flattened",
      from: "Alice Example <alice@example.com>",
      to: "Bob Example <bob@example.com>",
      cc: null,
      bcc: null,
      date: "Wed, 20 May 2026 10:40:00 +0000",
      messageId: "<flat@example.com>",
      inReplyTo: null,
      references: null,
      body_text: "stored plain body",
      body_html: "<p>stored plain body</p>",
      attachments: [],
      raw_json: "{\"id\":\"m-flat\"}",
    };
    const writes = planSmokeWrites(googleMailJob(), alreadyFlattened);
    const canonical = JSON.parse(
      writeByPath(writes, "/google-mail/messages/m-flat.json").contents as string,
    ) as Record<string, unknown>;

    assert.equal(canonical.subject, "Already Flattened");
    assert.equal(canonical.from, "Alice Example <alice@example.com>");
    assert.equal(canonical.body_text, "stored plain body");
    assert.equal(canonical.body_html, "<p>stored plain body</p>");
    assert.equal("raw_json" in canonical, false);
  });

  it("plans compact thread files with message references instead of embedded bodies", () => {
    const writes = planSmokeWrites(googleMailThreadJob(), {
      id: "t-1",
      historyId: "h1",
      snippet: "thread snippet",
      messages: [googleMailMessage],
    });
    const canonical = JSON.parse(
      writeByPath(writes, "/google-mail/threads/t-1.json").contents as string,
    ) as Record<string, unknown>;

    assert.deepEqual(canonical.messageIds, ["m-1"]);
    assert.equal(canonical.messageCount, 1);
    assert.equal("raw_json" in canonical, false);
    const messages = canonical.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.id, "m-1");
    assert.equal(messages[0]?.subject, "Digest Alpha");
    assert.equal("payload" in (messages[0] ?? {}), false);
    assert.equal("body_text" in (messages[0] ?? {}), false);
    assert.equal("raw_json" in (messages[0] ?? {}), false);
  });

  it("is enabled in the default provider parity gate for webhook deltas", () => {
    const messageJob = googleMailJob();
    assert.equal(
      providerModelKey(messageJob),
      "google-mail-relay:fetch-messages:GoogleMailMessage",
    );
    const messagePlan = planProviderRecordWrites(messageJob, [googleMailMessage]);
    assert.equal(messagePlan.written, 1);
    assertHasPath(messagePlan.writes, "/google-mail/messages/m-1.json");

    const threadJob = googleMailThreadJob();
    assert.equal(
      providerModelKey(threadJob),
      "google-mail-relay:fetch-threads:GoogleMailThread",
    );
    const threadPlan = planProviderRecordWrites(threadJob, [
      samples.GoogleMailThread,
    ]);
    assert.equal(threadPlan.written, 1);
    assertHasPath(threadPlan.writes, "/google-mail/threads/t-1.json");
  });

  it("skips planned google-mail writes when existing canonical differs only by historyId", () => {
    const messageJob = googleMailJob();
    const existing = {
      ...flattenedGoogleMailMessage,
      historyId: "previous-history",
    };
    const incoming = {
      ...flattenedGoogleMailMessage,
      historyId: "next-history",
      labelIds: [...flattenedGoogleMailMessage.labelIds].reverse(),
    };

    const plan = planProviderRecordWrites(
      messageJob,
      [incoming],
      undefined,
      {
        existingFiles: {
          "/google-mail/messages/m-1.json": JSON.stringify(existing),
        },
      },
    );

    assert.equal(plan.written, 0);
    assert.equal(plan.skipped, 1);
    assert.equal(plan.writes.some((write) => write.path.startsWith("/google-mail/messages/")), false);
  });

  it("keeps planned google-mail writes when no existing-file context is available", () => {
    const messageJob = googleMailJob();
    const plan = planProviderRecordWrites(messageJob, [googleMailMessage]);

    assert.equal(plan.written, 1);
    assertHasPath(plan.writes, "/google-mail/messages/m-1.json");
  });

  it("surfaces a Google Mail record in today's digest", async () => {
    await assertTodayDigestIncludes(
      "google-mail",
      "/google-mail/messages/m-1.json",
      JSON.stringify(googleMailMessage),
    );
  });

  it("acks malformed provider queue bodies without retrying", async () => {
    await assertMalformedNangoMessageAcked(
      "google-mail-relay",
      "fetch-messages",
      "GoogleMailMessage",
    );
  });
});
