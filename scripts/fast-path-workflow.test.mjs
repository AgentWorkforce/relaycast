// Pins the approval gate of .github/workflows/fast-path.yml: it only runs on
// workflow_dispatch, keeps top-level permissions minimal, and nothing runs
// before the one job that uses the fast-path environment.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/fast-path.yml", import.meta.url), "utf8"),
);
const jobs = workflow.jobs;
const envName = (job) => (typeof job.environment === "object" ? job.environment?.name : job.environment);
const needsOf = (job) => (job.needs === undefined ? [] : [job.needs].flat());

describe("fast-path workflow", () => {
  it("is triggered by workflow_dispatch only", () => {
    assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  });

  it("keeps top-level permissions to contents: read", () => {
    assert.deepEqual(workflow.permissions, { contents: "read" });
  });

  it("has exactly one gate job, with no needs", () => {
    const gates = Object.keys(jobs).filter((id) => envName(jobs[id]) === "fast-path");
    assert.equal(gates.length, 1);
    assert.deepEqual(needsOf(jobs[gates[0]]), []);
  });

  it("makes every other job need the gate, directly or transitively", () => {
    const gate = Object.keys(jobs).find((id) => envName(jobs[id]) === "fast-path");
    const reaches = (id, seen = new Set()) => {
      if (id === gate) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return needsOf(jobs[id]).some((dep) => reaches(dep, seen));
    };
    for (const id of Object.keys(jobs)) {
      assert.ok(reaches(id), `${id} does not need ${gate}`);
    }
  });
});
