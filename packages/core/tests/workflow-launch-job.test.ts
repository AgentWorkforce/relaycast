import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_LAUNCH_JOB_LEASE_MS } from "../src/workflow-launch/job.js";

const CLONE_WAIT_TIMEOUT_MS = 25 * 60 * 1000;
const POST_CLONE_MARGIN_MS = 10 * 60 * 1000;

test("workflow launch lease exceeds clone wait plus post-clone margin", () => {
  assert.equal(WORKFLOW_LAUNCH_JOB_LEASE_MS, 40 * 60 * 1000);
  assert.ok(
    WORKFLOW_LAUNCH_JOB_LEASE_MS >= CLONE_WAIT_TIMEOUT_MS + POST_CLONE_MARGIN_MS,
    "launch lease must cover the registered workflow clone window plus PR handoff margin",
  );
});
