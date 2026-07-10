import assert from "node:assert/strict";
import { test } from "vitest";

import { buildSummary as buildLinearSummary } from "@relayfile/adapter-linear";

import { buildRelayfileChangedEnvelope } from "../src/envelope-builder.js";
import { buildResourceSummary } from "../src/summary-builder.js";
import { WorkspaceWatchSubscriber } from "../src/watch-subscriber.js";

test("WorkspaceWatchSubscriber forwards matching relayfile changes into relayfile.changed envelopes", async () => {
  let subscription:
    | {
        onEvent: (event: unknown) => void;
        onError?: (error: unknown) => void;
      }
    | undefined;
  const forwarded: Awaited<ReturnType<typeof buildRelayfileChangedEnvelope>>[] = [];

  const relayfile = {
    subscribe(input: {
      workspace: string;
      globs: string[];
      onEvent: (event: unknown) => void;
      onError?: (error: unknown) => void;
    }) {
      assert.equal(input.workspace, "support");
      assert.deepEqual(input.globs, ["/linear/issues/**"]);
      subscription = input;
      return {
        close() {
          subscription = undefined;
        },
      };
    },
  };

  const subscriber = new WorkspaceWatchSubscriber(
    relayfile as never,
    "support",
    async (event) => {
      forwarded.push(
        await buildRelayfileChangedEnvelope({
          workspace: "support",
          path: event.path,
          provider: event.provider,
          occurredAt: event.timestamp,
          eventId: event.eventId,
          revision: event.revision,
          contentHash: event.contentHash,
          type: event.type,
          watch: "/linear/issues/**",
        }),
      );
    },
    async (error) => {
      assert.fail(String(error));
    },
  );

  await subscriber.update(["linear/issues/**"]);
  subscription?.onEvent({
    eventId: "evt_linear_1",
    type: "file.updated",
    path: "/linear/issues/ENG-412.json",
    provider: "linear",
    revision: "rev_2",
    timestamp: "2026-05-12T01:00:00.000Z",
  });
  subscription?.onEvent({
    eventId: "evt_ignored",
    type: "file.updated",
    path: "/github/prs/42.json",
    provider: "github",
    revision: "rev_1",
    timestamp: "2026-05-12T01:00:01.000Z",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.type, "relayfile.changed");
  assert.equal(forwarded[0]?.resource.path, "/linear/issues/ENG-412.json");
  assert.equal(forwarded[0]?.resource.provider, "linear");
  assert.equal(forwarded[0]?.action, "updated");
  assert.deepEqual(forwarded[0]?.summary, {
    title: "ENG-412.json",
    status: "updated",
    tags: ["linear"],
  });

  await subscriber.close();
});

test("WorkspaceWatchSubscriber forwards adapter-derived resource summaries into relayfile.changed envelopes", async () => {
  let subscription:
    | {
        onEvent: (event: unknown) => void;
        onError?: (error: unknown) => void;
      }
    | undefined;
  const forwarded: Awaited<ReturnType<typeof buildRelayfileChangedEnvelope>>[] = [];
  const linearIssue = {
    title: "Customer escalation follow-up",
    state: { name: "In Progress" },
    actionBy: {
      id: "usr_linear_1",
      name: "Ada Lovelace",
    },
    labels: [{ name: "ops" }],
    previousData: {
      title: "Old title",
    },
  };
  const adapterSummary = buildLinearSummary(linearIssue);
  const expectedGatewaySummary = {
    ...adapterSummary,
  };
  const expectedForwardedSummary = {
    ...adapterSummary,
    tags: ["linear", ...(adapterSummary.tags ?? [])],
  };

  const relayfile = {
    subscribe(input: {
      workspace: string;
      globs: string[];
      onEvent: (event: unknown) => void;
      onError?: (error: unknown) => void;
    }) {
      assert.equal(input.workspace, "support");
      assert.deepEqual(input.globs, ["/linear/issues/**"]);
      subscription = input;
      return {
        close() {
          subscription = undefined;
        },
      };
    },
  };

  const subscriber = new WorkspaceWatchSubscriber(
    relayfile as never,
    "support",
    async (event) => {
      const summary = buildResourceSummary("linear", {
        path: event.path,
        data: linearIssue,
      });
      assert.deepEqual(summary, expectedGatewaySummary);
      forwarded.push(
        await buildRelayfileChangedEnvelope({
          workspace: "support",
          path: event.path,
          provider: event.provider,
          occurredAt: event.timestamp,
          eventId: event.eventId,
          revision: event.revision,
          type: event.type,
          watch: "/linear/issues/**",
          summary,
        }),
      );
    },
    async (error) => {
      assert.fail(String(error));
    },
  );

  await subscriber.update(["/linear/issues/**"]);
  subscription?.onEvent({
    eventId: "evt_linear_summary_1",
    type: "file.updated",
    path: "/linear/issues/ENG-412.json",
    provider: "linear",
    revision: "rev_2",
    timestamp: "2026-05-12T01:00:00.000Z",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0]?.summary, expectedForwardedSummary);

  await subscriber.close();
});

test("WorkspaceWatchSubscriber fans in multiple watch globs without forwarding non-matching changes", async () => {
  let subscription:
    | {
        onEvent: (event: unknown) => void;
        onError?: (error: unknown) => void;
      }
    | undefined;
  const forwarded: string[] = [];

  const relayfile = {
    subscribe(input: {
      workspace: string;
      globs: string[];
      onEvent: (event: unknown) => void;
      onError?: (error: unknown) => void;
    }) {
      assert.equal(input.workspace, "support");
      assert.deepEqual(input.globs, ["/linear/issues/**", "/github/prs/**"]);
      subscription = input;
      return {
        close() {
          subscription = undefined;
        },
      };
    },
  };

  const subscriber = new WorkspaceWatchSubscriber(
    relayfile as never,
    "support",
    async (event) => {
      forwarded.push(event.path);
    },
    async (error) => {
      assert.fail(String(error));
    },
  );

  await subscriber.update(["/linear/issues/**", "/github/prs/**"]);
  subscription?.onEvent({
    eventId: "evt_linear_1",
    type: "file.updated",
    path: "/linear/issues/ENG-412.json",
    provider: "linear",
    revision: "rev_1",
    timestamp: "2026-05-12T01:00:00.000Z",
  });
  subscription?.onEvent({
    eventId: "evt_github_1",
    type: "file.updated",
    path: "/github/prs/42.json",
    provider: "github",
    revision: "rev_2",
    timestamp: "2026-05-12T01:00:01.000Z",
  });
  subscription?.onEvent({
    eventId: "evt_ignored",
    type: "file.updated",
    path: "/slack/channels/C123/messages/1.json",
    provider: "slack",
    revision: "rev_3",
    timestamp: "2026-05-12T01:00:02.000Z",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(forwarded, [
    "/linear/issues/ENG-412.json",
    "/github/prs/42.json",
  ]);

  await subscriber.close();
});

test("WorkspaceWatchSubscriber accepts proactive relayfile ChangeEvent payloads", async () => {
  let subscription:
    | {
        onEvent: (event: unknown) => void;
        onError?: (error: unknown) => void;
      }
    | undefined;
  const forwarded: Array<{
    eventId: string;
    path: string;
    provider?: string;
    digest?: string;
    summary?: Record<string, unknown>;
  }> = [];

  const relayfile = {
    subscribe(input: {
      workspace: string;
      globs: string[];
      onEvent: (event: unknown) => void;
      onError?: (error: unknown) => void;
    }) {
      assert.equal(input.workspace, "support");
      subscription = input;
      return {
        close() {
          subscription = undefined;
        },
      };
    },
  };

  const subscriber = new WorkspaceWatchSubscriber(
    relayfile as never,
    "support",
    async (event) => {
      forwarded.push({
        eventId: event.eventId,
        path: event.path,
        provider: event.provider,
        digest: event.digest,
        summary: event.summary as Record<string, unknown> | undefined,
      });
    },
    async (error) => {
      assert.fail(String(error));
    },
  );

  await subscriber.update(["/linear/issues/**"]);
  subscription?.onEvent({
    id: "evt_linear_change_1",
    workspace: "support",
    type: "relayfile.changed",
    occurredAt: "2026-05-12T01:00:00.000Z",
    resource: {
      path: "/linear/issues/ENG-500.json",
      kind: "linear.issue",
      id: "ENG-500",
      provider: "linear",
    },
    summary: {
      title: "ENG-500",
      status: "In Progress",
      tags: ["linear"],
    },
    digest: "sha256:eng-500",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(forwarded, [
    {
      eventId: "evt_linear_change_1",
      path: "/linear/issues/ENG-500.json",
      provider: "linear",
      digest: "sha256:eng-500",
      summary: {
        title: "ENG-500",
        status: "In Progress",
        tags: ["linear"],
      },
    },
  ]);

  await subscriber.close();
});
