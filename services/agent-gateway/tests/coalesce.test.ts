import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { EventCoalescer } from "../src/coalesce.js";

test("EventCoalescer collapses rapid events for the same key into the latest run", async () => {
  vi.useFakeTimers();
  try {
    const coalescer = new EventCoalescer();
    const calls: string[] = [];

    coalescer.schedule("support:/linear/issues/ENG-412.json", 200, () => {
      calls.push("first");
    });
    coalescer.schedule("support:/linear/issues/ENG-412.json", 200, () => {
      calls.push("second");
    });

    await vi.advanceTimersByTimeAsync(199);
    assert.deepEqual(calls, []);

    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(calls, ["second"]);
  } finally {
    vi.useRealTimers();
  }
});

test("EventCoalescer catches rejected scheduled callbacks", async () => {
  vi.useFakeTimers();
  try {
    const errors: Array<{ key: string; error: unknown }> = [];
    const coalescer = new EventCoalescer((key, error) => {
      errors.push({ key, error });
    });

    coalescer.schedule("support:/linear/issues/ENG-413.json", 10, async () => {
      throw new Error("delivery failed");
    });

    await vi.advanceTimersByTimeAsync(10);

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.key, "support:/linear/issues/ENG-413.json");
    assert.match(String((errors[0]?.error as Error | undefined)?.message), /delivery failed/);
  } finally {
    vi.useRealTimers();
  }
});

test("EventCoalescer clear prevents a pending callback", async () => {
  vi.useFakeTimers();
  try {
    const coalescer = new EventCoalescer();
    const calls: string[] = [];

    coalescer.schedule("support:/linear/issues/ENG-414.json", 100, () => {
      calls.push("ran");
    });
    coalescer.clear("support:/linear/issues/ENG-414.json");

    await vi.advanceTimersByTimeAsync(100);

    assert.deepEqual(calls, []);
  } finally {
    vi.useRealTimers();
  }
});

test("EventCoalescer clearAll prevents all pending callbacks", async () => {
  vi.useFakeTimers();
  try {
    const coalescer = new EventCoalescer();
    const calls: string[] = [];

    coalescer.schedule("support:/linear/issues/ENG-415.json", 100, () => {
      calls.push("first");
    });
    coalescer.schedule("support:/linear/issues/ENG-416.json", 100, () => {
      calls.push("second");
    });
    coalescer.clearAll();

    await vi.advanceTimersByTimeAsync(100);

    assert.deepEqual(calls, []);
  } finally {
    vi.useRealTimers();
  }
});
