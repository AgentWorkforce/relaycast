import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMetadata } from "../../packages/core/src/storage/metadata.js";

describe("buildMetadata", () => {
  it("produces correct metadata from step and result", () => {
    const meta = buildMetadata(
      { name: "analyze", agent: "claude", preset: "worker", cli: "claude" },
      {
        sandboxId: "sb-123",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:01:00.000Z",
        exitCode: 0,
        output: "Analysis complete.",
      }
    );

    assert.equal(meta.stepName, "analyze");
    assert.equal(meta.agent, "claude");
    assert.equal(meta.preset, "worker");
    assert.equal(meta.cli, "claude");
    assert.equal(meta.sandboxId, "sb-123");
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.durationMs, 60_000);
    assert.equal(meta.outputSummary, "Analysis complete.");
    assert.equal(meta.error, undefined);
  });

  it("truncates output summary to 1000 chars", () => {
    const longOutput = "x".repeat(2000);
    const meta = buildMetadata(
      { name: "step1" },
      { sandboxId: "sb-1", output: longOutput }
    );

    assert.equal(meta.outputSummary.length, 1000);
  });

  it("uses defaults when optional fields missing", () => {
    const meta = buildMetadata(
      { name: "step1" },
      { sandboxId: "sb-1" }
    );

    assert.equal(meta.agent, "unknown");
    assert.equal(meta.preset, "unknown");
    assert.equal(meta.cli, "unknown");
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.outputSummary, "");
  });

  it("prefers result fields over step fields", () => {
    const meta = buildMetadata(
      { name: "step1", agent: "step-agent", preset: "step-preset" },
      { sandboxId: "sb-1", agent: "result-agent", preset: "result-preset" }
    );

    assert.equal(meta.agent, "result-agent");
    assert.equal(meta.preset, "result-preset");
  });

  it("computes duration from start/end times", () => {
    const meta = buildMetadata(
      { name: "step1" },
      {
        sandboxId: "sb-1",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:00:30.000Z",
      }
    );

    assert.equal(meta.durationMs, 30_000);
  });

  it("uses explicit durationMs when provided", () => {
    const meta = buildMetadata(
      { name: "step1" },
      {
        sandboxId: "sb-1",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:01:00.000Z",
        durationMs: 5000,
      }
    );

    assert.equal(meta.durationMs, 5000);
  });

  it("includes error when provided", () => {
    const meta = buildMetadata(
      { name: "step1" },
      { sandboxId: "sb-1", error: "Something went wrong" }
    );

    assert.equal(meta.error, "Something went wrong");
  });
});
