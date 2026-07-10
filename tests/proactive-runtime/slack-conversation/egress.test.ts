import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as slackConversationEgressModule from "../../../packages/web/lib/integrations/slack-conversation/egress.ts";

const resolvedEgressModule = (
  "createSlackConversationEgress" in slackConversationEgressModule
    ? slackConversationEgressModule
    : (slackConversationEgressModule as {
      default: typeof slackConversationEgressModule;
    }).default
) as {
  createSlackConversationEgress: typeof slackConversationEgressModule.createSlackConversationEgress;
};

const { createSlackConversationEgress } = resolvedEgressModule;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return {
    promise,
    resolve: resolve!,
  };
}

function parseJsonBody(init?: RequestInit): Record<string, unknown> {
  assert.equal(typeof init?.body, "string");
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("slack conversation egress", () => {
  it("posts a threaded start message, appends updates, and stops with the final text", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: input.toString(), init });
      return jsonResponse({
        ok: true,
        ...(calls.length === 1 ? { ts: "1710000000.000100" } : {}),
      });
    };

    const egress = createSlackConversationEgress({
      fetchImpl,
      resolveBotToken: async (workspaceId) => {
        assert.equal(workspaceId, "workspace-1");
        return "xoxb-test-token";
      },
    });

    const started = await egress.startStream({
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1700000000.000001",
      markdownText: "Working on it",
      identity: {
        username: "Router Bot",
        iconUrl: "https://example.com/router.png",
      },
    });
    const appended = await egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000100",
      markdownText: "Still working",
    });
    const stopped = await egress.stopStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000100",
      markdownText: "Done",
    });

    assert.deepEqual(started, { ok: true, ts: "1710000000.000100" });
    assert.deepEqual(appended, { ok: true });
    assert.deepEqual(stopped, { ok: true });
    assert.equal(calls.length, 3);

    assert.equal(calls[0]?.url, "https://slack.com/api/chat.postMessage");
    assert.equal(calls[1]?.url, "https://slack.com/api/chat.update");
    assert.equal(calls[2]?.url, "https://slack.com/api/chat.update");

    const startBody = parseJsonBody(calls[0]?.init);
    assert.equal(startBody.channel, "C123");
    assert.equal(startBody.thread_ts, "1700000000.000001");
    assert.equal(startBody.text, "Working on it");
    assert.equal(startBody.username, "Router Bot");
    assert.equal(startBody.icon_url, "https://example.com/router.png");

    const appendBody = parseJsonBody(calls[1]?.init);
    assert.equal(appendBody.channel, "C123");
    assert.equal(appendBody.ts, "1710000000.000100");
    assert.equal(appendBody.text, "Still working");

    const stopBody = parseJsonBody(calls[2]?.init);
    assert.equal(stopBody.channel, "C123");
    assert.equal(stopBody.ts, "1710000000.000100");
    assert.equal(stopBody.text, "Done");

    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), "Bearer xoxb-test-token");
      assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
    }
  });

  it("coalesces throttled append updates and flushes the latest trailing text", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: input.toString(), init });
      return jsonResponse({ ok: true });
    };

    const egress = createSlackConversationEgress({
      fetchImpl,
      resolveBotToken: async () => "xoxb-test-token",
    });

    const first = await egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000200",
      markdownText: "first",
    });
    assert.deepEqual(first, { ok: true });
    assert.equal(calls.length, 1);

    const secondPromise = egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000200",
      markdownText: "second",
    });
    const thirdPromise = egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000200",
      markdownText: "third",
    });

    assert.equal(calls.length, 1);
    await sleep(1_100);

    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    assert.deepEqual(second, { ok: true });
    assert.deepEqual(third, { ok: true });
    assert.equal(calls.length, 2);

    const trailingBody = parseJsonBody(calls[1]?.init);
    assert.equal(trailingBody.text, "third");
  });

  it("does not share throttle state across channels for the same slack ts", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: input.toString(), init });
      return jsonResponse({ ok: true });
    };

    const egress = createSlackConversationEgress({
      fetchImpl,
      resolveBotToken: async () => "xoxb-test-token",
    });

    // First append on channel A enters the throttle window for that stream.
    const first = await egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000300",
      markdownText: "channel A",
    });
    assert.deepEqual(first, { ok: true });
    assert.equal(calls.length, 1);

    // Same slack ts on a DIFFERENT channel must not be queued behind channel
    // A's throttle state — it is a distinct message stream.
    const second = await egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C999",
      ts: "1710000000.000300",
      markdownText: "channel B",
    });
    assert.deepEqual(second, { ok: true });
    assert.equal(calls.length, 2);

    const secondBody = parseJsonBody(calls[1]?.init);
    assert.equal(secondBody.channel, "C999");
    assert.equal(secondBody.text, "channel B");
  });

  it("flushes a queued append via stopStream with the final text", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: input.toString(), init });
      return jsonResponse({ ok: true });
    };

    const egress = createSlackConversationEgress({
      fetchImpl,
      resolveBotToken: async () => "xoxb-test-token",
    });

    const first = await egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000300",
      markdownText: "first",
    });
    assert.deepEqual(first, { ok: true });
    assert.equal(calls.length, 1);

    const queuedAppend = egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000300",
      markdownText: "stale trailing text",
    });
    const stopped = await egress.stopStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000300",
      markdownText: "final text",
    });

    assert.deepEqual(await queuedAppend, { ok: true });
    assert.deepEqual(stopped, { ok: true });
    assert.equal(calls.length, 2);

    const stopBody = parseJsonBody(calls[1]?.init);
    assert.equal(stopBody.text, "final text");
  });

  it("keeps a later queued append pending until its own trailing flush runs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const secondUpdateStarted = deferred<void>();
    const secondUpdateRelease = deferred<Response>();
    const thirdUpdateStarted = deferred<void>();
    let updateCount = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: input.toString(), init });
      if (input.toString() !== "https://slack.com/api/chat.update") {
        return jsonResponse({ ok: true });
      }

      updateCount += 1;
      if (updateCount === 2) {
        secondUpdateStarted.resolve();
        return secondUpdateRelease.promise;
      }
      if (updateCount === 3) {
        thirdUpdateStarted.resolve();
      }
      return jsonResponse({ ok: true });
    };

    const egress = createSlackConversationEgress({
      fetchImpl,
      resolveBotToken: async () => "xoxb-test-token",
    });

    await egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000301",
      markdownText: "first",
    });
    assert.equal(calls.length, 1);

    const secondPromise = egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000301",
      markdownText: "second",
    });
    await secondUpdateStarted.promise;

    let thirdSettled = false;
    const thirdPromise = egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000301",
      markdownText: "third",
    }).then((result) => {
      thirdSettled = true;
      return result;
    });

    await sleep(25);
    assert.equal(thirdSettled, false);

    secondUpdateRelease.resolve(jsonResponse({ ok: true }));
    assert.deepEqual(await secondPromise, { ok: true });
    assert.equal(thirdSettled, false);
    assert.equal(calls.length, 2);

    await thirdUpdateStarted.promise;
    assert.equal(calls.length, 3);
    assert.deepEqual(await thirdPromise, { ok: true });

    const trailingBody = parseJsonBody(calls[2]?.init);
    assert.equal(trailingBody.text, "third");
  });

  it("returns a structured missing_bot_token error when resolveBotToken returns null", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not be called");
    };

    const egress = createSlackConversationEgress({
      fetchImpl,
      resolveBotToken: async () => null,
    });

    const result = await egress.startStream({
      workspaceId: "workspace-no-token",
      channel: "C123",
      markdownText: "hello",
    });

    assert.deepEqual(result, {
      ok: false,
      error: "Slack bot token was not available for workspace 'workspace-no-token'.",
      errorDetail: {
        code: "missing_bot_token",
        message: "Slack bot token was not available for workspace 'workspace-no-token'.",
      },
    });
  });

  it("returns a structured missing_bot_token error when resolveBotToken throws (does not reject)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not be called");
    };

    const egress = createSlackConversationEgress({
      fetchImpl,
      resolveBotToken: async () => {
        throw new Error("db down");
      },
    });

    // Must resolve (not reject) to a structured error — never throw into the caller.
    const result = await egress.startStream({
      workspaceId: "workspace-db-down",
      channel: "C123",
      markdownText: "hello",
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorDetail?.code, "missing_bot_token");
    assert.match(result.errorDetail?.message ?? "", /db down/);
    assert.match(result.error ?? "", /db down/);
  });

  it("returns a structured error when Slack responds with ok=false", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ ok: false, error: "channel_not_found" });

    const egress = createSlackConversationEgress({
      fetchImpl,
      resolveBotToken: async () => "xoxb-test-token",
    });

    const result = await egress.startStream({
      workspaceId: "workspace-1",
      channel: "C404",
      markdownText: "hello",
    });

    assert.deepEqual(result, {
      ok: false,
      error: "Slack /chat.postMessage rejected the request: channel_not_found",
      errorDetail: {
        code: "slack_api_error",
        message: "Slack /chat.postMessage rejected the request: channel_not_found",
        slackError: "channel_not_found",
      },
    });
  });

  it("returns a structured error when Slack responds with a non-2xx status", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("ratelimited", { status: 429 });

    const egress = createSlackConversationEgress({
      fetchImpl,
      resolveBotToken: async () => "xoxb-test-token",
    });

    const result = await egress.appendStream({
      workspaceId: "workspace-1",
      channel: "C123",
      ts: "1710000000.000400",
      markdownText: "hello",
    });

    assert.deepEqual(result, {
      ok: false,
      error: "Slack /chat.update failed with status 429.",
      errorDetail: {
        code: "slack_http_error",
        status: 429,
        message: "Slack /chat.update failed with status 429.",
      },
    });
  });
});
