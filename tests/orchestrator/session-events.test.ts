import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestDb } from "./helpers/pglite-db.js";
import { createDbEventClient } from "../../packages/core/src/session/events.js";
import { DaytonaStepExecutor } from "../../packages/core/src/executor/executor.js";
import { LogStreamer } from "../../packages/core/src/storage/log-streamer.js";

describe("createDbEventClient", () => {
  it("emits events with auto-incrementing sequence numbers", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const runId = randomUUID();

      await client.emit({ runId, eventType: "workflow_started" });
      await client.emit({ runId, eventType: "step_started", stepName: "build" });
      await client.emit({ runId, eventType: "step_completed", stepName: "build" });

      const events = await client.getEvents(runId);

      assert.equal(events.length, 3);
      assert.deepEqual(
        events.map((e) => e.sequence),
        [1, 2, 3],
      );
      assert.deepEqual(
        events.map((e) => e.eventType),
        ["workflow_started", "step_started", "step_completed"],
      );
    } finally {
      cleanup();
    }
  });

  it("emit returns the sequence of the event it just inserted", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const runId = randomUUID();

      const first = await client.emit({ runId, eventType: "workflow_started" });
      const second = await client.emit({ runId, eventType: "step_started", stepName: "a" });
      const third = await client.emit({ runId, eventType: "step_completed", stepName: "a" });

      // Sequences are consecutive and each emit returns its own number,
      // not the current-latest — so the POST API response can't return a
      // different event's sequence under concurrent writes.
      assert.equal(first.sequence, 1);
      assert.equal(second.sequence, 2);
      assert.equal(third.sequence, 3);

      const stored = await client.getEvents(runId);
      assert.deepEqual(
        stored.map((e) => e.sequence),
        [first.sequence, second.sequence, third.sequence],
      );
    } finally {
      cleanup();
    }
  });

  it("getEvents returns events ordered by sequence", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const runId = randomUUID();

      await client.emit({ runId, eventType: "sandbox_created", stepName: "a" });
      await client.emit({ runId, eventType: "step_started", stepName: "a" });
      await client.emit({ runId, eventType: "step_completed", stepName: "a" });

      const events = await client.getEvents(runId);

      for (let i = 1; i < events.length; i++) {
        assert.ok(
          events[i].sequence > events[i - 1].sequence,
          `sequence ${events[i].sequence} should be > ${events[i - 1].sequence}`,
        );
      }
    } finally {
      cleanup();
    }
  });

  it("getEvents with after filter returns only newer events", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const runId = randomUUID();

      for (let i = 0; i < 5; i++) {
        await client.emit({ runId, eventType: "heartbeat" });
      }

      const events = await client.getEvents(runId, { after: 3 });

      assert.equal(events.length, 2);
      assert.deepEqual(
        events.map((e) => e.sequence),
        [4, 5],
      );
    } finally {
      cleanup();
    }
  });

  it("getEvents with limit caps results", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const runId = randomUUID();

      for (let i = 0; i < 10; i++) {
        await client.emit({ runId, eventType: "heartbeat" });
      }

      const events = await client.getEvents(runId, { limit: 3 });

      assert.equal(events.length, 3);
      assert.deepEqual(
        events.map((e) => e.sequence),
        [1, 2, 3],
      );
    } finally {
      cleanup();
    }
  });

  it("getEvents supports descending sequence order", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const runId = randomUUID();

      for (let i = 0; i < 5; i++) {
        await client.emit({ runId, eventType: "heartbeat" });
      }

      const events = await client.getEvents(runId, { limit: 3, sort: "desc" });

      assert.deepEqual(
        events.map((e) => e.sequence),
        [5, 4, 3],
      );
    } finally {
      cleanup();
    }
  });

  it("getLatestSequence returns highest sequence for run", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const runId = randomUUID();

      for (let i = 0; i < 5; i++) {
        await client.emit({ runId, eventType: "heartbeat" });
      }

      const latest = await client.getLatestSequence(runId);
      assert.equal(latest, 5);
    } finally {
      cleanup();
    }
  });

  it("getLatestSequence returns 0 for unknown runId", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const latest = await client.getLatestSequence(randomUUID());
      assert.equal(latest, 0);
    } finally {
      cleanup();
    }
  });

  it("retries sequence assignment when emits race", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const runId = randomUUID();

      await Promise.all(
        Array.from({ length: 10 }, () => client.emit({ runId, eventType: "heartbeat" })),
      );

      const events = await client.getEvents(runId);

      assert.equal(events.length, 10);
      assert.deepEqual(
        events.map((e) => e.sequence),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      );
    } finally {
      cleanup();
    }
  });

  it("payload round-trips as JSON", async () => {
    const { db, schema, cleanup } = await createTestDb();
    try {
      const client = createDbEventClient({ db, schema });
      const runId = randomUUID();

      await client.emit({
        runId,
        eventType: "step_completed",
        stepName: "build",
        payload: { exitCode: 0, duration: 1234 },
      });

      const events = await client.getEvents(runId);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].payload, { exitCode: 0, duration: 1234 });
    } finally {
      cleanup();
    }
  });
});

describe("DaytonaStepExecutor with sessionEvents", () => {
  function buildMockDaytona() {
    return {
      create: async () => ({
        id: "sandbox-id",
        process: {
          executeCommand: async (command: string) => {
            // main's executor refactor added a `getMcpConfigForAgent` call
            // that runs `agent-relay mcp-args --register` and expects a
            // JSON object on stdout. Return a minimal valid shape; any
            // other command falls through to the default shell-ok stub.
            if (command.includes("mcp-args --register")) {
              return {
                result: JSON.stringify({ args: [], env: {} }),
                exitCode: 0,
              };
            }
            if (command.includes("relayfile-initial-sync-exit:")) {
              return { result: "relayfile-initial-sync-exit:0", exitCode: 0 };
            }
            return { result: "ok", exitCode: 0 };
          },
        },
        fs: {
          uploadFile: async () => undefined,
        },
        getUserHomeDir: async () => "/home/daytona",
      }),
      remove: async () => undefined,
    };
  }

  function buildExecutor(
    daytona: any,
    sessionEvents?: any,
  ): DaytonaStepExecutor {
    return new DaytonaStepExecutor({
      daytona: daytona as any,
      credentials: {
        cliCredentials: "cli",
        relayApiKey: "relay",
        relayBaseUrl: "https://relay.test",
        runId: "run-1",
        userId: "user-1",
        workspaceId: "rw_abcd1234",
        daytonaApiKey: "day",
        s3CodeKey: "code.tar.gz",
        s3Credentials: {
          accessKeyId: "akid",
          secretAccessKey: "skey",
          sessionToken: "stoken",
          bucket: "bucket",
          prefix: "prefix",
        },
      },
      s3: {
        putObject: async () => undefined,
      } as any,
      relayfileUrl: "http://localhost:9090",
      relayfileToken: "test-token",
      sessionEvents,
    });
  }

  it("emits lifecycle events during successful step execution", async () => {
    const originalStart = (LogStreamer.prototype as any).start;
    const originalFinish = (LogStreamer.prototype as any).finish;
    const originalWrite = (LogStreamer.prototype as any).write;

    (LogStreamer.prototype as any).start = async function () {};
    (LogStreamer.prototype as any).finish = async function () {};
    (LogStreamer.prototype as any).write = async function () {};

    try {
      const emitted: any[] = [];
      const mockClient = {
        emit: async (opts: any) => {
          emitted.push(opts);
        },
        getEvents: async () => [],
        getLatestSequence: async () => 0,
      };

      const daytona = buildMockDaytona();
      const executor = buildExecutor(daytona, mockClient);

      (executor as any).runCommand = async () => ({
        output: "ok",
        exitCode: 0,
      });

      await executor.executeAgentStep(
        { name: "agent-step", agent: "worker", cli: "claude" } as any,
        { name: "worker", cli: "claude", preset: "default" } as any,
        "do the work",
      );

      const types = emitted.map((e) => e.eventType);
      assert.ok(types.includes("sandbox_created"), "should emit sandbox_created");
      assert.ok(types.includes("step_started"), "should emit step_started");
      assert.ok(types.includes("step_completed"), "should emit step_completed");
      assert.ok(types.includes("sandbox_disposed"), "should emit sandbox_disposed");

      for (const event of emitted) {
        assert.equal(event.runId, "run-1");
        assert.equal(event.stepName, "agent-step");
      }
    } finally {
      (LogStreamer.prototype as any).start = originalStart;
      (LogStreamer.prototype as any).finish = originalFinish;
      (LogStreamer.prototype as any).write = originalWrite;
    }
  });

  it("emits step_failed when step throws", async () => {
    const originalStart = (LogStreamer.prototype as any).start;
    const originalFinish = (LogStreamer.prototype as any).finish;
    const originalWrite = (LogStreamer.prototype as any).write;

    (LogStreamer.prototype as any).start = async function () {};
    (LogStreamer.prototype as any).finish = async function () {};
    (LogStreamer.prototype as any).write = async function () {};

    try {
      const emitted: any[] = [];
      const mockClient = {
        emit: async (opts: any) => {
          emitted.push(opts);
        },
        getEvents: async () => [],
        getLatestSequence: async () => 0,
      };

      const daytona = buildMockDaytona();
      const executor = buildExecutor(daytona, mockClient);

      (executor as any).runCommand = async () => ({
        output: "error output",
        exitCode: 7,
      });

      await assert.rejects(
        async () =>
          executor.executeAgentStep(
            { name: "agent-step", agent: "worker", cli: "claude" } as any,
            { name: "worker", cli: "claude", preset: "default" } as any,
            "do the work",
          ),
        { message: /exited with code 7/ },
      );

      const types = emitted.map((e) => e.eventType);
      assert.ok(types.includes("step_failed"), "should emit step_failed");
      assert.ok(types.includes("sandbox_disposed"), "should emit sandbox_disposed");

      const failedEvent = emitted.find((e) => e.eventType === "step_failed");
      assert.ok(failedEvent.payload?.error, "step_failed should have error in payload");
    } finally {
      (LogStreamer.prototype as any).start = originalStart;
      (LogStreamer.prototype as any).finish = originalFinish;
      (LogStreamer.prototype as any).write = originalWrite;
    }
  });

  it("works without sessionEvents client (opt-in)", async () => {
    const originalStart = (LogStreamer.prototype as any).start;
    const originalFinish = (LogStreamer.prototype as any).finish;
    const originalWrite = (LogStreamer.prototype as any).write;

    (LogStreamer.prototype as any).start = async function () {};
    (LogStreamer.prototype as any).finish = async function () {};
    (LogStreamer.prototype as any).write = async function () {};

    try {
      const daytona = buildMockDaytona();
      const executor = buildExecutor(daytona); // no sessionEvents

      (executor as any).runCommand = async () => ({
        output: "ok",
        exitCode: 0,
      });

      const result = await executor.executeAgentStep(
        { name: "agent-step", agent: "worker", cli: "claude" } as any,
        { name: "worker", cli: "claude", preset: "default" } as any,
        "do the work",
      );

      assert.equal(result, "ok");
    } finally {
      (LogStreamer.prototype as any).start = originalStart;
      (LogStreamer.prototype as any).finish = originalFinish;
      (LogStreamer.prototype as any).write = originalWrite;
    }
  });
});
