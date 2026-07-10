import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BY_STATE_SEGMENT } from "../src/aliases.js";
import { buildLinearConventionFragment } from "../src/conventions.js";
import { byStateSubtreeForIssue, groupIssuesByState } from "../src/insights/by-state.js";

describe("linear by-state helpers", () => {
  it("groups issues by the adapter-compatible state path segment", () => {
    const grouped = groupIssuesByState([
      { identifier: "ENG-1", state: { type: "Started" } },
      { identifier: "ENG-2", state: { type: "Started" } },
      { identifier: "ENG-3", state: { type: "QA-Ready" } },
    ]);

    assert.deepEqual(Object.keys(grouped).sort(), ["QA%2DReady", "Started"]);
    assert.deepEqual(
      grouped.Started?.map((issue) => issue.identifier),
      ["ENG-1", "ENG-2"],
    );
  });

  it("buckets missing or null state.type into unknown", () => {
    const grouped = groupIssuesByState([
      { identifier: "ENG-1", state: null },
      { identifier: "ENG-2" },
      { identifier: "ENG-3", state: { type: "   " } },
    ]);

    assert.deepEqual(
      grouped.unknown?.map((issue) => issue.identifier),
      ["ENG-1", "ENG-2", "ENG-3"],
    );
  });

  it("trims and percent-encodes state segments before building the alias path", () => {
    assert.equal(
      byStateSubtreeForIssue({
        identifier: "ENG-42",
        state: { type: " Triage Queue " },
      }),
      `/linear/issues/${BY_STATE_SEGMENT}/Triage%20Queue/ENG-42.json`,
    );
  });

  it("falls back to the internal id when identifier is missing", () => {
    assert.equal(
      byStateSubtreeForIssue({
        id: "issue_internal_7",
        state: { type: "unstarted" },
      }),
      `/linear/issues/${BY_STATE_SEGMENT}/unstarted/issue_internal_7.json`,
    );
  });

  it("encodes alias-like state names so they remain nested under the by-state subtree", () => {
    assert.deepEqual(
      ["By Title", "by-id", "by_name"].map((state, index) =>
        byStateSubtreeForIssue({
          identifier: `ENG-${index + 10}`,
          state: { type: state },
        }),
      ),
      [
        `/linear/issues/${BY_STATE_SEGMENT}/By%20Title/ENG-10.json`,
        `/linear/issues/${BY_STATE_SEGMENT}/by%2Did/ENG-11.json`,
        `/linear/issues/${BY_STATE_SEGMENT}/by_name/ENG-12.json`,
      ],
    );
  });

  it("declares by-state issue and project convention patterns", () => {
    const patterns = buildLinearConventionFragment().paths.map((path) => path.pattern);

    assert.ok(patterns.includes(`/linear/issues/${BY_STATE_SEGMENT}/{state}/{id}.json`));
    assert.ok(patterns.includes(`/linear/projects/${BY_STATE_SEGMENT}/{state}/{id}.json`));
    assert.ok(patterns.every((pattern) => pattern.includes(BY_STATE_SEGMENT) || !pattern.includes("by-state")));
  });
});
