import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  attachPoolErrorListener,
  attachPoolLifecycleTelemetry,
  getWorkerNeonPoolConfigForTesting,
} from "../src/db/worker-neon.js";

describe("worker-neon pool error listener", () => {
  it("configures Worker Neon pools to bound stale socket waits", () => {
    assert.deepEqual(getWorkerNeonPoolConfigForTesting(), {
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 1,
      max: 1,
      maxUses: 1,
    });
  });

  it("swallows pool connection errors instead of throwing EventEmitter unhandled errors", () => {
    const pool = new EventEmitter();
    const warn = mock.method(console, "warn", () => {});
    try {
      attachPoolErrorListener(pool);

      // Without a listener, EventEmitter#emit("error") throws
      // `Unhandled error. (Uncaught Error: Network connection lost.)` —
      // the exact log line observed on the prod Worker when workerd severs
      // the pool's idle Neon WebSockets at request-context teardown.
      assert.doesNotThrow(() => {
        pool.emit("error", new Error("Network connection lost."));
      });

      assert.equal(warn.mock.callCount(), 1);
      const [message, detail] = warn.mock.calls[0].arguments;
      assert.match(String(message), /neon pool connection error/);
      assert.equal((detail as { name?: string }).name, "Error");
      assert.equal((detail as { message?: string }).message, "Network connection lost.");
    } finally {
      warn.mock.restore();
    }
  });

  it("logs ErrorEvent-like values without collapsing them to [object ErrorEvent]", () => {
    const pool = new EventEmitter();
    const warn = mock.method(console, "warn", () => {});
    try {
      attachPoolErrorListener(pool);
      assert.doesNotThrow(() => {
        pool.emit("error", {
          type: "error",
          error: Object.assign(new Error("WebSocket closed during request teardown"), {
            code: "WS_CLOSED",
          }),
        });
      });
      assert.equal(warn.mock.callCount(), 1);
      const detail = warn.mock.calls[0].arguments[1] as {
        message?: string;
        type?: string;
        constructorName?: string;
        error?: { message?: string; code?: string };
      };
      assert.equal(detail.message, "WebSocket closed during request teardown");
      assert.equal(detail.type, "error");
      assert.equal(detail.constructorName, "Object");
      assert.deepEqual(detail.error, {
        name: "Error",
        message: "WebSocket closed during request teardown",
        code: "WS_CLOSED",
      });
      assert.notEqual(String(detail), "[object ErrorEvent]");
    } finally {
      warn.mock.restore();
    }
  });

  it("serializes numeric codes and indirect circular nested errors defensively", () => {
    const pool = new EventEmitter();
    const warn = mock.method(console, "warn", () => {});
    try {
      attachPoolErrorListener(pool);
      const first: Record<string, unknown> = {
        type: "error",
        code: 1006,
      };
      const second: Record<string, unknown> = {
        message: "WebSocket closed abnormally",
        code: 1011,
      };
      first.error = second;
      second.error = first;

      assert.doesNotThrow(() => {
        pool.emit("error", first);
      });

      assert.equal(warn.mock.callCount(), 1);
      assert.deepEqual(warn.mock.calls[0].arguments[1], {
        name: undefined,
        message: "WebSocket closed abnormally",
        type: "error",
        code: "1006",
        constructorName: "Object",
        error: {
          name: undefined,
          message: "WebSocket closed abnormally",
          type: undefined,
          code: "1011",
          constructorName: "Object",
          error: { value: "[Circular]" },
        },
      });
    } finally {
      warn.mock.restore();
    }
  });

  it("serializes numeric Error codes defensively", () => {
    const pool = new EventEmitter();
    const warn = mock.method(console, "warn", () => {});
    try {
      attachPoolErrorListener(pool);
      const error = Object.assign(new Error("connection reset"), { code: 104 });

      assert.doesNotThrow(() => {
        pool.emit("error", error);
      });

      assert.equal(warn.mock.callCount(), 1);
      assert.deepEqual(warn.mock.calls[0].arguments[1], {
        name: "Error",
        message: "connection reset",
        code: "104",
      });
    } finally {
      warn.mock.restore();
    }
  });

  it("serializes non-Error values defensively", () => {
    const pool = new EventEmitter();
    const warn = mock.method(console, "warn", () => {});
    try {
      attachPoolErrorListener(pool);
      // EventEmitter still throws for non-listener cases only; with the
      // listener attached an arbitrary value must not crash the handler.
      assert.doesNotThrow(() => {
        pool.emit("error", "socket gone");
      });
      assert.equal(warn.mock.callCount(), 1);
      assert.deepEqual(warn.mock.calls[0].arguments[1], { value: "socket gone" });
    } finally {
      warn.mock.restore();
    }
  });

  it("logs failed pool acquisition timing", async () => {
    const pool = new EventEmitter() as EventEmitter & {
      connect: () => Promise<unknown>;
      totalCount: number;
      idleCount: number;
      waitingCount: number;
    };
    pool.totalCount = 1;
    pool.idleCount = 0;
    pool.waitingCount = 1;
    pool.connect = async () => {
      throw new Error("timeout exceeded when trying to connect");
    };
    const warn = mock.method(console, "warn", () => {});
    try {
      attachPoolLifecycleTelemetry(pool);

      await assert.rejects(() => pool.connect(), /timeout exceeded/);

      assert.equal(warn.mock.callCount(), 1);
      const [message, fields] = warn.mock.calls[0].arguments;
      assert.equal(message, "[db] neon worker pool acquire timing");
      assert.equal(typeof (fields as { durationMs?: unknown }).durationMs, "number");
      assert.deepEqual({ ...(fields as object), durationMs: 0 }, {
        durationMs: 0,
        outcome: "error",
        totalCount: 1,
        idleCount: 0,
        waitingCount: 1,
        error: "timeout exceeded when trying to connect",
      });
    } finally {
      warn.mock.restore();
    }
  });
});
