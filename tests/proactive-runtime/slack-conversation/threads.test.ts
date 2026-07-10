import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as dbModule from "../../../packages/web/lib/db/index.ts";
import * as loggerModule from "../../../packages/web/lib/logger.ts";
import * as threadsModule from "../../../packages/web/lib/integrations/slack-conversation/threads.ts";

const resolvedLoggerModule =
  "logger" in loggerModule
    ? loggerModule
    : (loggerModule as {
      default: typeof loggerModule;
    }).default;
const { logger } = resolvedLoggerModule as {
  logger: typeof loggerModule.logger;
};
const resolvedDbModule =
  "setDbForTesting" in dbModule
    ? dbModule
    : (dbModule as {
      default: typeof dbModule;
    }).default;
const { setDbForTesting } = resolvedDbModule as {
  setDbForTesting: typeof dbModule.setDbForTesting;
};
const resolvedThreadsModule =
  "lookupSlackConversationThreadOwner" in threadsModule
    ? threadsModule
    : (threadsModule as {
      default: typeof threadsModule;
    }).default;
const {
  lookupSlackConversationThreadOwner,
  recordSlackConversationThreadOwner,
} = resolvedThreadsModule as {
  lookupSlackConversationThreadOwner: typeof threadsModule.lookupSlackConversationThreadOwner;
  recordSlackConversationThreadOwner: typeof threadsModule.recordSlackConversationThreadOwner;
};

let pg: PGlite | null = null;

async function createThreadsTable() {
  await pg!.exec(`
    CREATE TABLE slack_conversation_threads (
      workspace_id text NOT NULL,
      channel text NOT NULL,
      thread_ts text NOT NULL,
      deployed_name text NOT NULL,
      agent_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, channel, thread_ts)
    );
  `);
}

describe("slack conversation threads store", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await createThreadsTable();
    setDbForTesting(drizzle(pg) as never);
  });

  afterEach(async () => {
    mock.restoreAll();
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("returns null when no thread owner row exists", async () => {
    const result = await lookupSlackConversationThreadOwner({
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000001",
    });

    assert.equal(result, null);
  });

  it("records and updates the thread owner via upsert", async () => {
    await recordSlackConversationThreadOwner({
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000001",
      deployedName: "alpha",
      agentId: "agent-1",
    });

    assert.equal(
      await lookupSlackConversationThreadOwner({
        workspaceId: "workspace-1",
        channel: "C123",
        threadTs: "1710000000.000001",
      }),
      "alpha",
    );

    await recordSlackConversationThreadOwner({
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000001",
      deployedName: "beta",
      agentId: "agent-2",
    });

    assert.equal(
      await lookupSlackConversationThreadOwner({
        workspaceId: "workspace-1",
        channel: "C123",
        threadTs: "1710000000.000001",
      }),
      "beta",
    );

    const rows = await pg!.query<{
      deployed_name: string;
      agent_id: string;
    }>(
      "SELECT deployed_name, agent_id FROM slack_conversation_threads",
    );
    assert.deepEqual(rows.rows, [
      {
        deployed_name: "beta",
        agent_id: "agent-2",
      },
    ]);
  });

  it("normalizes Relayfile suffixed channel segments before keying thread owners", async () => {
    await recordSlackConversationThreadOwner({
      workspaceId: "workspace-1",
      channel: "C123__support",
      threadTs: "1710000000.000001",
      deployedName: "alpha",
      agentId: "agent-1",
    });

    assert.equal(
      await lookupSlackConversationThreadOwner({
        workspaceId: "workspace-1",
        channel: "C123",
        threadTs: "1710000000.000001",
      }),
      "alpha",
    );
    assert.equal(
      await lookupSlackConversationThreadOwner({
        workspaceId: "workspace-1",
        channel: "C123__support",
        threadTs: "1710000000.000001",
      }),
      "alpha",
    );

    const rows = await pg!.query<{ channel: string }>(
      "SELECT channel FROM slack_conversation_threads",
    );
    assert.deepEqual(rows.rows, [{ channel: "C123" }]);
  });

  it("fails open on lookup errors", async () => {
    const warn = mock.method(logger, "warn", async () => undefined);
    await pg?.close();
    pg = null;

    const result = await lookupSlackConversationThreadOwner({
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000001",
    }, {
      // Inject the warn sink so the spy observes the call regardless of how
      // the source module resolves @/lib/logger (module-instance duality).
      logWarn: (message, fields) => logger.warn(message, fields),
    });

    assert.equal(result, null);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(
      warn.mock.calls[0]?.arguments[1]?.diag,
      "slack-conversation-thread-owner-lookup-failed",
    );
  });

  it("fails open on record errors", async () => {
    const warn = mock.method(logger, "warn", async () => undefined);
    await pg?.close();
    pg = null;

    await recordSlackConversationThreadOwner({
      workspaceId: "workspace-1",
      channel: "C123",
      threadTs: "1710000000.000001",
      deployedName: "alpha",
      agentId: "agent-1",
    }, {
      logWarn: (message, fields) => logger.warn(message, fields),
    });

    assert.equal(warn.mock.callCount(), 1);
    assert.equal(
      warn.mock.calls[0]?.arguments[1]?.diag,
      "slack-conversation-thread-owner-record-failed",
    );
  });
});
