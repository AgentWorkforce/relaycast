import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setDbForTesting } from "../../packages/core/src/db/client.ts";
import * as storeModule from "../../packages/web/lib/ricky/run-store.ts";

const rickyRunStore = (
  (storeModule as {
    rickyRunStore?: typeof import("../../packages/web/lib/ricky/run-store.ts").rickyRunStore;
  }).rickyRunStore ??
  (storeModule as {
    default?: {
      rickyRunStore?: typeof import("../../packages/web/lib/ricky/run-store.ts").rickyRunStore;
    };
  }).default?.rickyRunStore
)!;

afterEach(() => {
  setDbForTesting(null);
});

describe("Ricky run store", () => {
  it("retries event appends when concurrent sequence allocation hits the unique index", async () => {
    let selectCalls = 0;
    let insertCalls = 0;
    const createdAt = new Date("2026-05-03T12:00:00.000Z");

    const db = {
      select() {
        return {
          from() {
            return {
              async where() {
                selectCalls += 1;
                return [{ sequence: selectCalls === 1 ? 0 : 1 }];
              },
            };
          },
        };
      },
      insert() {
        return {
          values() {
            return {
              async returning() {
                insertCalls += 1;
                if (insertCalls === 1) {
                  const error = new Error("duplicate key violates ricky_run_events_run_sequence_unique") as Error & {
                    code?: string;
                    constraint?: string;
                  };
                  error.code = "23505";
                  error.constraint = "ricky_run_events_run_sequence_unique";
                  throw error;
                }
                return [{
                  id: "event-2",
                  rickyRunId: "ricky-1",
                  sequence: 2,
                  eventType: "gate.resolved",
                  payload: { ok: true },
                  createdAt,
                }];
              },
            };
          },
        };
      },
    };

    setDbForTesting(db as never);

    const event = await rickyRunStore.appendEvent("ricky-1", "gate.resolved", { ok: true });

    assert.equal(event.sequence, 2);
    assert.equal(selectCalls, 2);
    assert.equal(insertCalls, 2);
  });
});
