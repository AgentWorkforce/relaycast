import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRelaycronSweep } from "../../packages/relaycron/src/sweep.ts";

function createDb(results: Array<{ id: string }> = []) {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results };
        },
      };
    },
  };
}

describe("relaycron integration-watch delivery sweep", () => {
  it("asks proactive-runtime-worker to drain retryable pending deliveries and reap stopped sandboxes on every sweep", async () => {
    const proactiveRequests: Request[] = [];
    const cloudWebRequests: Request[] = [];
    const logs: unknown[][] = [];
    const originalLog = console.log;
    const waitUntilPromises: Promise<unknown>[] = [];
    const env = {
      DB: createDb(),
      SCHEDULER_DO: {
        idFromName: (name: string) => name,
        get() {
          throw new Error("no schedule pokes expected");
        },
      },
      CLOUD_WEB_WORKER: {
        async fetch(request: Request) {
          cloudWebRequests.push(request);
          const pathname = new URL(request.url).pathname;
          if (pathname.includes("cloud-agent-box/keepalive-reaper")) {
            return Response.json({
              ok: true,
              data: {
                found: 2,
                stopped: 1,
                vanished: 1,
                failed: [],
              },
            });
          }
          return Response.json({ ok: false, error: "unexpected cloud-web request" }, { status: 500 });
        },
      },
      PROACTIVE_RUNTIME_WORKER: {
        async fetch(request: Request) {
          proactiveRequests.push(request);
          const pathname = new URL(request.url).pathname;
          if (pathname.includes("deployment-tick-deliveries/sweep")) {
            return Response.json({
              ok: true,
              data: {
                attempted: 2,
                delivered: 2,
                failed: 0,
                pending: 0,
                terminal: 0,
              },
            });
          }
          if (pathname.includes("sandbox-reaper")) {
            return Response.json({
              ok: true,
              data: {
                found: 3,
                eligible: 2,
                deleted: 2,
                failed: ["sbx-failed"],
                skippedTooYoung: 1,
                skippedMissingCreatedAt: 0,
                skippedActiveLease: 1,
                leasesCleared: 2,
              },
            });
          }
          return Response.json({
            ok: true,
            data: {
              attempted: 1,
              delivered: 1,
              failed: 0,
              pending: 0,
              terminal: 0,
            },
          });
        },
      },
      RELAYCRON_API_KEY: "relaycron-key",
    };
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
    };

    console.log = (...args: unknown[]) => {
      logs.push(args);
      originalLog(...args);
    };
    try {
      await runRelaycronSweep(env as never, ctx as never);
      await Promise.all(waitUntilPromises);
    } finally {
      console.log = originalLog;
    }

    assert.equal(proactiveRequests.length, 3);
    assert.equal(cloudWebRequests.length, 1);
    assert.equal(
      new URL(proactiveRequests[0].url).pathname,
      "/cloud/api/internal/proactive-runtime/deployment-tick-deliveries/sweep",
    );
    assert.equal(proactiveRequests[0].method, "POST");
    assert.equal(
      proactiveRequests[0].headers.get("authorization"),
      "Bearer relaycron-key",
    );
    assert.deepEqual(await proactiveRequests[0].json(), { limit: 3 });
    assert.equal(
      new URL(proactiveRequests[1].url).pathname,
      "/cloud/api/internal/proactive-runtime/integration-watch-deliveries/sweep",
    );
    assert.equal(proactiveRequests[1].method, "POST");
    assert.equal(
      proactiveRequests[1].headers.get("authorization"),
      "Bearer relaycron-key",
    );
    assert.deepEqual(await proactiveRequests[1].json(), { limit: 3 });
    assert.equal(
      new URL(proactiveRequests[2].url).pathname,
      "/cloud/api/internal/proactive-runtime/sandbox-reaper",
    );
    assert.equal(proactiveRequests[2].method, "POST");
    assert.equal(
      proactiveRequests[2].headers.get("authorization"),
      "Bearer relaycron-key",
    );
    assert.deepEqual(await proactiveRequests[2].json(), {
      clearLeases: true,
      minAgeHours: 4,
    });
    assert.equal(
      new URL(cloudWebRequests[0].url).pathname,
      "/cloud/api/internal/cloud-agent-box/keepalive-reaper",
    );
    assert.equal(cloudWebRequests[0].method, "POST");
    assert.equal(
      cloudWebRequests[0].headers.get("authorization"),
      "Bearer relaycron-key",
    );
    assert.deepEqual(await cloudWebRequests[0].json(), {});
    assert.deepEqual(
      logs.find(
        ([message]) =>
          message === "[relaycron] stopped sandbox reaper completed",
      ),
      [
        "[relaycron] stopped sandbox reaper completed",
        {
          minAgeHours: 4,
          found: 3,
          eligible: 2,
          deleted: 2,
          failed: 1,
          skippedTooYoung: 1,
          skippedMissingCreatedAt: 0,
          skippedActiveLease: 1,
          leasesCleared: 2,
        },
      ],
    );
    assert.deepEqual(
      logs.find(
        ([message]) =>
          message === "[relaycron] cloud-agent box keepalive reaper completed",
      ),
      [
        "[relaycron] cloud-agent box keepalive reaper completed",
        {
          found: 2,
          stopped: 1,
          vanished: 1,
          failed: 0,
        },
      ],
    );
  });
});
