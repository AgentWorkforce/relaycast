import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getRunStatus } from "../../packages/core/src/cli/status.js";

const originalSend = S3Client.prototype.send;
const originalWarn = console.warn;

describe("getRunStatus", () => {
  afterEach(() => {
    S3Client.prototype.send = originalSend;
    console.warn = originalWarn;
  });

  it("returns a degraded running result when the manifest is corrupt", async () => {
    const warnings: string[] = [];
    console.warn = ((message?: unknown) => {
      warnings.push(String(message));
    }) as typeof console.warn;

    S3Client.prototype.send = (async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from(["{invalid-json"]) };
      }

      throw new Error(`Unexpected command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
    }) as typeof S3Client.prototype.send;

    const result = await getRunStatus({
      bucket: "test-bucket",
      userId: "user-123",
      runId: "run-456",
      region: "us-east-1",
    });

    assert.deepEqual(result, {
      runId: "run-456",
      status: "running",
      steps: [],
      logKeys: [],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Failed to parse run manifest user-123\/run-456\/manifest\.json:/);
  });
});
