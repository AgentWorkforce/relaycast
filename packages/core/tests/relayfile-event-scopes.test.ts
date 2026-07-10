import assert from "node:assert/strict";
import { test } from "node:test";

import { eventScopedSyncPaths } from "../src/relayfile/event-scopes.js";

test("eventScopedSyncPaths prefers explicit dispatch paths and expands metadata files to resource subtrees", () => {
  assert.deepEqual(
    eventScopedSyncPaths({
      type: "github.issues.opened",
      paths: ["/github/repos/acme/cloud/issues/42__bug/meta.json"],
      resource: { issue: { number: 42 } },
    }),
    ["/github/repos/acme/cloud/issues/42__bug/**"],
  );
});

test("eventScopedSyncPaths ignores wildcard dispatch globs that are not event-scoped", () => {
  assert.deepEqual(
    eventScopedSyncPaths({
      type: "github.issues.opened",
      paths: ["/github/repos/**/**/issues/**"],
      resource: {},
    }),
    [],
  );
});

test("eventScopedSyncPaths derives a github issue subtree from webhook payload fallback", () => {
  assert.deepEqual(
    eventScopedSyncPaths({
      type: "github.issues.opened",
      resource: {
        repository: { full_name: "acme/cloud", name: "cloud", owner: { login: "acme" } },
        issue: { number: 42, title: "Bug report" },
      },
    }),
    ["/github/repos/acme/cloud/issues/42__bug-report/**"],
  );
});

test("eventScopedSyncPaths derives github PR subtrees from review and check events", () => {
  const repository = { full_name: "acme/cloud", name: "cloud", owner: { login: "acme" } };
  assert.deepEqual(
    eventScopedSyncPaths({
      type: "github.pull_request.opened",
      resource: {
        number: 42,
        title: "Review me",
        repository,
        head: { sha: "head-sha", ref: "feature", repo: repository },
        base: { sha: "base-sha", ref: "main", repo: repository },
      },
    }),
    ["/github/repos/acme/cloud/pulls/42__review-me/**"],
  );
  assert.deepEqual(
    eventScopedSyncPaths({
      type: "github.pull_request_review.submitted",
      resource: {
        repository,
        pull_request: { number: 42, title: "Review me" },
      },
    }),
    ["/github/repos/acme/cloud/pulls/42__review-me/**"],
  );
  assert.deepEqual(
    eventScopedSyncPaths({
      type: "github.pull_request_review_comment.created",
      resource: {
        repository,
        pull_request: { number: 42, title: "Review me" },
      },
    }),
    ["/github/repos/acme/cloud/pulls/42__review-me/**"],
  );
  assert.deepEqual(
    eventScopedSyncPaths({
      type: "github.check_run.completed",
      resource: {
        repository,
        pull_requests: [{ number: 42 }],
      },
    }),
    ["/github/repos/acme/cloud/pulls/42/**"],
  );
});

test("eventScopedSyncPaths derives linear and notion resource paths", () => {
  assert.deepEqual(
    eventScopedSyncPaths({
      type: "linear.issue.updated",
      resource: { issue: { id: "lin_1", identifier: "ENG-1", title: "Fix" } },
    }),
    ["/linear/issues/ENG-1__lin_1.json"],
  );
  assert.deepEqual(
    eventScopedSyncPaths({
      type: "notion.page.updated",
      resource: { page: { id: "page-1", title: "Plan" } },
    }),
    ["/notion/pages/plan__page-1/**"],
  );
});

test("eventScopedSyncPaths returns [] when the event is not relayfile-scopable", () => {
  assert.deepEqual(eventScopedSyncPaths({ type: "cron.tick", resource: {} }), []);
});
