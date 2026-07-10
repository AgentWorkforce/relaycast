import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as dbModule from "../../../packages/web/lib/db/index.ts";
import * as loggerModule from "../../../packages/web/lib/logger.ts";
import * as terminalReplyModule from "../../../packages/web/lib/proactive-runtime/slack-conversation-terminal-reply.ts";

const resolvedTerminalReplyModule =
  "postSlackConversationTerminalReply" in terminalReplyModule
    ? terminalReplyModule
    : (terminalReplyModule as {
      default: typeof terminalReplyModule;
    }).default;
const resolvedLoggerModule =
  "logger" in loggerModule
    ? loggerModule
    : (loggerModule as {
      default: typeof loggerModule;
    }).default;
const resolvedDbModule =
  "setDbForTesting" in dbModule
    ? dbModule
    : (dbModule as {
      default: typeof dbModule;
    }).default;

const { postSlackConversationTerminalReply } = resolvedTerminalReplyModule as {
  postSlackConversationTerminalReply: typeof terminalReplyModule.postSlackConversationTerminalReply;
};
const { setDbForTesting } = resolvedDbModule as {
  setDbForTesting: typeof dbModule.setDbForTesting;
};
const { logger } = resolvedLoggerModule as {
  logger: typeof loggerModule.logger;
};

let pg: PGlite | null = null;

async function createDeliveriesTable() {
  await pg!.exec(`
    CREATE TABLE integration_watch_deliveries (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agent_id text NOT NULL,
      delivery_id text NOT NULL,
      payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      slack_terminal_reply_status text,
      slack_terminal_reply_posted_at timestamptz,
      slack_terminal_reply_error text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

describe("postSlackConversationTerminalReply", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await createDeliveriesTable();
    setDbForTesting(drizzle(pg) as never);
  });

  afterEach(async () => {
    mock.restoreAll();
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("does nothing while the routing flag is off", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          ackTs: "1710000000.000001",
        },
      },
      outcome: { kind: "completed", output: "done" },
      deps: {
        egress: { startStream },
        routingEnabled: () => false,
      },
    });

    assert.equal(startStream.mock.callCount(), 0);
  });

  it("silently no-ops when the payload has no usable slack conversation marker", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: { slackConversation: { channel: "C123" } },
      outcome: { kind: "completed", output: "done" },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: { slackConversation: "bad-marker" },
      outcome: { kind: "failed", reason: "error" },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    assert.equal(startStream.mock.callCount(), 0);
  });

  it("posts completed output into the thread using ackTs fallback and truncates on line boundaries", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));
    const output = [
      "a".repeat(1000),
      "b".repeat(1000),
      "c".repeat(1000),
      "d".repeat(1000),
    ].join("\n");

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          ackTs: "1710000000.000222",
        },
      },
      outcome: { kind: "completed", output },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    assert.equal(startStream.mock.callCount(), 1);
    assert.deepEqual(startStream.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000222",
      markdownText: [
        "a".repeat(1000),
        "b".repeat(1000),
        "c".repeat(1000),
      ].join("\n") + "... (truncated)",
    });
  });

  it("normalizes suffixed Relayfile channel segments before Slack egress", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123__support",
          threadTs: "1710000000.000250",
        },
      },
      outcome: { kind: "completed", output: "done" },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    assert.equal(startStream.mock.callCount(), 1);
    assert.deepEqual(startStream.mock.calls[0]?.arguments[0], {
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000250",
      markdownText: "done",
    });
  });

  it("claims the integration-watch delivery row before posting so a later retry does not duplicate the terminal reply", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status
      ) VALUES (
        'delivery-row-1',
        'workspace-1',
        'agent-1',
        'delivery-1',
        '{"slackConversation":{"channel":"C123","threadTs":"1710000000.000250"}}'::jsonb,
        'running'
      );
    `);

    const input = {
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000250",
        },
      },
      outcome: { kind: "completed" as const, output: "done" },
      delivery: { agentId: "agent-1", deliveryId: "delivery-1" },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    };

    await postSlackConversationTerminalReply(input);
    await postSlackConversationTerminalReply(input);

    assert.equal(startStream.mock.callCount(), 1);
    const rows = await pg!.query<{
      slack_terminal_reply_status: string | null;
      slack_terminal_reply_error: string | null;
    }>(`
      SELECT slack_terminal_reply_status, slack_terminal_reply_error
      FROM integration_watch_deliveries
      WHERE delivery_id = 'delivery-1'
    `);
    assert.deepEqual(rows.rows, [
      {
        slack_terminal_reply_status: "posted",
        slack_terminal_reply_error: null,
      },
    ]);
  });

  it("can claim a delivery row that is already terminal before the reply is posted", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status
      ) VALUES (
        'delivery-row-terminal',
        'workspace-1',
        'agent-1',
        'delivery-terminal',
        '{"slackConversation":{"channel":"C123","threadTs":"1710000000.000251"}}'::jsonb,
        'delivered'
      );
    `);

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000251",
        },
      },
      outcome: { kind: "completed", output: "done" },
      delivery: { agentId: "agent-1", deliveryId: "delivery-terminal" },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    assert.equal(startStream.mock.callCount(), 1);
    const rows = await pg!.query<{ slack_terminal_reply_status: string | null }>(`
      SELECT slack_terminal_reply_status
      FROM integration_watch_deliveries
      WHERE delivery_id = 'delivery-terminal'
    `);
    assert.deepEqual(rows.rows, [{ slack_terminal_reply_status: "posted" }]);
  });

  it("posts a short notice when a completed run has no output", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000333",
        },
      },
      outcome: { kind: "completed", output: "  \n\n  " },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    assert.equal(startStream.mock.calls[0]?.arguments[0]?.markdownText, "Run completed with no output.");
  });

  it("preserves a non-BMP payload exactly at the 3900-character boundary", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));
    const output = "🙂".repeat(3900);

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000334",
        },
      },
      outcome: { kind: "completed", output },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    assert.equal(startStream.mock.calls[0]?.arguments[0]?.markdownText, output);
  });

  it("truncates long single-line astral output on a code-point boundary", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));
    const output = "🙂".repeat(3901);

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000335",
        },
      },
      outcome: { kind: "completed", output },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    assert.equal(
      startStream.mock.calls[0]?.arguments[0]?.markdownText,
      `${"🙂".repeat(3885)}... (truncated)`,
    );
  });

  it("retries a delivery row after a transient terminal reply failure", async () => {
    const warn = mock.method(logger, "warn", async () => undefined);
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status
      ) VALUES (
        'delivery-row-retry',
        'workspace-1',
        'agent-1',
        'delivery-retry',
        '{"slackConversation":{"channel":"C123","threadTs":"1710000000.000252"}}'::jsonb,
        'running'
      );
    `);

    let attempts = 0;
    const startStream = mock.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false as const,
          errorDetail: {
            code: "slack_api_error",
            message: "temporary Slack failure",
          },
        };
      }
      return { ok: true as const, ts: "1710000000.000100" };
    });
    const input = {
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000252",
        },
      },
      outcome: { kind: "completed" as const, output: "done" },
      delivery: { agentId: "agent-1", deliveryId: "delivery-retry" },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
        // Inject the warn sink so the spy observes the call regardless of how
        // the source module resolves @/lib/logger (module-instance duality).
        logWarn: (message: string, fields: Record<string, unknown>) => logger.warn(message, fields),
      },
    };

    await postSlackConversationTerminalReply(input);
    await postSlackConversationTerminalReply(input);

    assert.equal(startStream.mock.callCount(), 2);
    assert.equal(warn.mock.callCount(), 1);
    const rows = await pg!.query<{
      slack_terminal_reply_status: string | null;
      slack_terminal_reply_error: string | null;
    }>(`
      SELECT slack_terminal_reply_status, slack_terminal_reply_error
      FROM integration_watch_deliveries
      WHERE delivery_id = 'delivery-retry'
    `);
    assert.deepEqual(rows.rows, [
      {
        slack_terminal_reply_status: "posted",
        slack_terminal_reply_error: null,
      },
    ]);
  });

  it("retries a delivery row after a thrown terminal reply failure", async () => {
    const warn = mock.method(logger, "warn", async () => undefined);
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status
      ) VALUES (
        'delivery-row-throw-retry',
        'workspace-1',
        'agent-1',
        'delivery-throw-retry',
        '{"slackConversation":{"channel":"C123","threadTs":"1710000000.000253"}}'::jsonb,
        'running'
      );
    `);

    let attempts = 0;
    const startStream = mock.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary Slack outage");
      }
      return { ok: true as const, ts: "1710000000.000100" };
    });
    const input = {
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000253",
        },
      },
      outcome: { kind: "completed" as const, output: "done" },
      delivery: { agentId: "agent-1", deliveryId: "delivery-throw-retry" },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
        logWarn: (message: string, fields: Record<string, unknown>) => logger.warn(message, fields),
      },
    };

    await postSlackConversationTerminalReply(input);
    await postSlackConversationTerminalReply(input);

    assert.equal(startStream.mock.callCount(), 2);
    assert.equal(warn.mock.callCount(), 1);
    const rows = await pg!.query<{
      slack_terminal_reply_status: string | null;
      slack_terminal_reply_error: string | null;
    }>(`
      SELECT slack_terminal_reply_status, slack_terminal_reply_error
      FROM integration_watch_deliveries
      WHERE delivery_id = 'delivery-throw-retry'
    `);
    assert.deepEqual(rows.rows, [
      {
        slack_terminal_reply_status: "posted",
        slack_terminal_reply_error: null,
      },
    ]);
  });

  it("reclaims a stale posting row after a crashed terminal reply attempt", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status,
        slack_terminal_reply_status,
        updated_at
      ) VALUES (
        'delivery-row-stale-posting',
        'workspace-1',
        'agent-1',
        'delivery-stale-posting',
        '{"slackConversation":{"channel":"C123","threadTs":"1710000000.000254"}}'::jsonb,
        'running',
        'posting',
        NOW() - INTERVAL '11 minutes'
      );
    `);

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000254",
        },
      },
      outcome: { kind: "completed", output: "done" },
      delivery: { agentId: "agent-1", deliveryId: "delivery-stale-posting" },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    assert.equal(startStream.mock.callCount(), 1);
    const rows = await pg!.query<{ slack_terminal_reply_status: string | null }>(`
      SELECT slack_terminal_reply_status
      FROM integration_watch_deliveries
      WHERE delivery_id = 'delivery-stale-posting'
    `);
    assert.deepEqual(rows.rows, [{ slack_terminal_reply_status: "posted" }]);
  });

  it("posts a one-line failure notice with only the reason category", async () => {
    const startStream = mock.fn(async () => ({ ok: true as const, ts: "1710000000.000100" }));

    await postSlackConversationTerminalReply({
      workspaceId: "workspace-1",
      payload: {
        slackConversation: {
          channel: "C123",
          threadTs: "1710000000.000444",
        },
      },
      outcome: { kind: "failed", reason: "sandbox_terminal" },
      deps: {
        egress: { startStream },
        routingEnabled: () => true,
      },
    });

    assert.equal(startStream.mock.calls[0]?.arguments[0]?.markdownText, "Run failed (sandbox terminal).");
  });

  it("logs and swallows thrown egress failures", async () => {
    const warn = mock.method(logger, "warn", async () => undefined);

    await assert.doesNotReject(async () => {
      await postSlackConversationTerminalReply({
        workspaceId: "workspace-1",
        payload: {
          slackConversation: {
            channel: "C123",
            threadTs: "1710000000.000555",
          },
        },
        outcome: { kind: "completed", output: "done" },
        deps: {
          egress: {
            startStream: async () => {
              throw new Error("slack offline");
            },
          },
          routingEnabled: () => true,
          logWarn: (message, fields) => logger.warn(message, fields),
        },
      });
    });

    assert.equal(warn.mock.callCount(), 1);
    assert.equal(warn.mock.calls[0]?.arguments[0], "Slack conversation terminal reply failed");
    assert.deepEqual(warn.mock.calls[0]?.arguments[1], {
      area: "integration-watch-dispatch",
      diag: "slack-conversation-terminal-reply-failed",
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000555",
      error: "slack offline",
    });
  });

  it("logs and swallows a routingEnabled() dep that throws without propagating to the caller", async () => {
    const warn = mock.method(logger, "warn", async () => undefined);

    await assert.doesNotReject(async () => {
      await postSlackConversationTerminalReply({
        workspaceId: "workspace-1",
        payload: {
          slackConversation: {
            channel: "C123",
            threadTs: "1710000000.000777",
          },
        },
        outcome: { kind: "completed", output: "done" },
        deps: {
          routingEnabled: () => { throw new Error("flag helper exploded"); },
          logWarn: (message, fields) => logger.warn(message, fields),
        },
      });
    });

    assert.equal(warn.mock.callCount(), 1);
    assert.equal(warn.mock.calls[0]?.arguments[0], "Slack conversation terminal reply failed");
    const logArgs = warn.mock.calls[0]?.arguments[1] as Record<string, unknown>;
    assert.equal(logArgs?.area, "integration-watch-dispatch");
    assert.equal(logArgs?.diag, "slack-conversation-terminal-reply-failed");
    assert.equal(logArgs?.workspaceId, "workspace-1");
    assert.equal(logArgs?.channel, "C123");
    assert.equal(logArgs?.threadTs, "1710000000.000777");
    assert.equal(logArgs?.error, "flag helper exploded");
  });

  it("logs non-throwing egress failures without surfacing them", async () => {
    const warn = mock.method(logger, "warn", async () => undefined);

    await assert.doesNotReject(async () => {
      await postSlackConversationTerminalReply({
        workspaceId: "workspace-1",
        payload: {
          slackConversation: {
            channel: "C123",
            threadTs: "1710000000.000666",
          },
        },
        outcome: { kind: "failed", reason: "timeout" },
        deps: {
          egress: {
            startStream: async () => ({
              ok: false,
              error: "chat.postMessage denied",
              errorDetail: {
                code: "slack_api_error",
                message: "Slack /chat.postMessage rejected the request: restricted_action",
              },
            }),
          },
          routingEnabled: () => true,
          logWarn: (message, fields) => logger.warn(message, fields),
        },
      });
    });

    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls[0]?.arguments[1], {
      area: "integration-watch-dispatch",
      diag: "slack-conversation-terminal-reply-failed",
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000666",
      error: "Slack /chat.postMessage rejected the request: restricted_action",
      errorCode: "slack_api_error",
    });
  });
});
