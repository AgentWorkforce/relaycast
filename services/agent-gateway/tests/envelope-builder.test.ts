import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildRelayfileChangedEnvelope,
  buildRelaycastMessageEnvelope,
} from "../src/envelope-builder.js";

test("relayfile envelope infers provider and action from the changed path", async () => {
  const event = await buildRelayfileChangedEnvelope({
    workspace: "support",
    eventId: "evt-linear-1",
    path: "/linear/issues/ENG-42.json",
    watch: "/linear/**",
    type: "file.updated",
    revision: "rev_42",
    timestamp: "2026-05-11T12:00:00.000Z",
  });

  assert.equal(event.id, "evt-linear-1");
  assert.equal(event.type, "relayfile.changed");
  assert.equal(event.resource.path, "/linear/issues/ENG-42.json");
  assert.equal(event.resource.provider, "linear");
  assert.equal(event.resource.kind, "linear.issue");
  assert.equal(event.resource.id, "ENG-42");
  assert.equal(event.watch, "/linear/**");
  assert.equal(event.action, "updated");
  assert.equal(event.digest, "rev_42");
  assert.equal(event.summary.status, "updated");
  assert.deepEqual(event.summary.tags, ["linear"]);
});

test("relaycast envelope summarizes the first 80 characters of text and actor", async () => {
  const event = await buildRelaycastMessageEnvelope({
    workspace: "support",
    channel: "ops",
    messageId: "msg-42",
    text: "Customer escalation on account A-42. Need an owner, timeline, and rollback options before 09:00 UTC.",
    threadId: "thread-1",
    from: {
      id: "usr_42",
      displayName: "Ada Lovelace",
    },
    occurredAt: "2026-05-12T01:00:00.000Z",
  });

  assert.equal(event.type, "relaycast.message");
  assert.equal(event.channel, "ops");
  assert.equal(event.messageId, "msg-42");
  assert.equal(event.threadId, "thread-1");
  assert.equal(event.resource.kind, "relaycast.message");
  assert.equal(event.resource.provider, "relaycast");
  assert.equal(event.id, "relaycast:support:ops:msg-42");
  assert.deepEqual(event.summary, {
    title: "Customer escalation on account A-42. Need an owner, timeline, and rollback optio",
    actor: {
      id: "usr_42",
      displayName: "Ada Lovelace",
    },
  });
});

test("relaycast envelope uses the SDK-provided event id when available", async () => {
  const event = await buildRelaycastMessageEnvelope({
    workspace: "support",
    eventId: "evt-9f4a",
    channel: "ops",
    messageId: "msg-42",
    text: "ping",
  });

  assert.equal(event.id, "evt-9f4a");
});
