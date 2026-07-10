import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advanceNotFoundRetries,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  MAX_CONSECUTIVE_NOT_FOUND,
  parseArgs,
} from "../../tests/check-status.js";

describe("check-status CLI helpers", () => {
  it("uses a 30 minute poll timeout by default", () => {
    const args = parseArgs(["--user-id", "user-123", "--run-id", "run-456", "--poll"]);
    assert.equal(args.timeoutSeconds, DEFAULT_POLL_TIMEOUT_SECONDS);
  });

  it("parses --timeout in seconds", () => {
    const args = parseArgs([
      "--user-id=user-123",
      "--run-id=run-456",
      "--poll",
      "--timeout=45",
    ]);
    assert.equal(args.timeoutSeconds, 45);
  });

  it("rejects invalid timeout values", () => {
    assert.throws(
      () => parseArgs(["--user-id", "user-123", "--run-id", "run-456", "--timeout", "0"]),
      /Invalid value for --timeout/,
    );
  });

  it("retries not_found up to the configured threshold", () => {
    let retryState = advanceNotFoundRetries("not_found", 0);
    assert.deepEqual(retryState, { consecutiveNotFound: 1, exhausted: false });

    retryState = advanceNotFoundRetries("not_found", MAX_CONSECUTIVE_NOT_FOUND - 1);
    assert.deepEqual(retryState, {
      consecutiveNotFound: MAX_CONSECUTIVE_NOT_FOUND,
      exhausted: true,
    });
  });

  it("resets not_found retries once the run is visible again", () => {
    const retryState = advanceNotFoundRetries("running", 3);
    assert.deepEqual(retryState, { consecutiveNotFound: 0, exhausted: false });
  });
});
