import { describe, expect, it } from "vitest";
import {
  buildGitHubWebhookIngestData,
  buildGitHubWebhookFileData,
  enrichGitHubWatchPayload,
  computePath,
  GITHUB_RELAYFILE_FILE_DELETED_EVENT,
  GITHUB_RELAYFILE_FILE_UPDATED_EVENT,
  isGitHubWebhookDeletionEvent,
  normalizeWebhook,
} from "./github-relayfile";

function repoPayload() {
  return {
    repository: {
      name: "cloud",
      full_name: "AgentWorkforce/cloud",
      owner: { login: "AgentWorkforce" },
    },
  };
}

describe("GitHub Relayfile webhook state mapping", () => {
  it("treats closed issues as state updates instead of deletes", () => {
    const normalized = normalizeWebhook({
      headers: { "x-github-event": "issues" },
      connectionId: "conn_123",
      payload: {
        ...repoPayload(),
        action: "closed",
        issue: {
          number: 43,
          title: "Fix bug",
          state: "closed",
        },
      },
    });

    expect(isGitHubWebhookDeletionEvent(normalized)).toBe(false);
    expect(buildGitHubWebhookIngestData(normalized).eventType).toBe(
      GITHUB_RELAYFILE_FILE_UPDATED_EVENT,
    );
  });

  it("treats closed and merged pull requests as state updates instead of deletes", () => {
    const normalized = normalizeWebhook({
      headers: { "x-github-event": "pull_request" },
      connectionId: "conn_123",
      payload: {
        ...repoPayload(),
        action: "closed",
        pull_request: {
          number: 12,
          title: "Ship it",
          state: "closed",
          merged: true,
        },
      },
    });

    expect(isGitHubWebhookDeletionEvent(normalized)).toBe(false);
    const ingest = buildGitHubWebhookIngestData(normalized);
    expect(ingest.eventType).toBe(GITHUB_RELAYFILE_FILE_UPDATED_EVENT);
    expect(ingest.data).toMatchObject({
      state: "closed",
      merged: true,
    });
  });

  it("materializes pull request author from webhook user login", () => {
    const normalized = normalizeWebhook({
      headers: { "x-github-event": "pull_request" },
      connectionId: "conn_123",
      payload: {
        ...repoPayload(),
        action: "opened",
        pull_request: {
          number: 1803,
          title: "Trigger review",
          state: "open",
          user: {
            login: "khaliqgant",
          },
        },
      },
    });

    expect(buildGitHubWebhookFileData(normalized)).toMatchObject({
      number: 1803,
      author: "khaliqgant",
      _webhook: {
        eventType: "pull_request.opened",
        objectType: "pull_request",
        objectId: "1803",
      },
    });
  });

  it("enriches the watch payload with a nested pull_request author stub", () => {
    const normalized = normalizeWebhook({
      headers: { "x-github-event": "pull_request" },
      connectionId: "conn_123",
      payload: {
        ...repoPayload(),
        action: "opened",
        pull_request: {
          number: 156,
          title: "Fix relay helper mount root resolution",
          state: "open",
          user: { login: "kjgbot" },
        },
      },
    });
    const data = buildGitHubWebhookFileData(normalized);
    const enriched = enrichGitHubWatchPayload(data, normalized);

    // The persona's payload read (`payload.pull_request.user.login`) resolves
    // deterministically — no mounted meta.json required.
    expect(enriched.pull_request).toEqual({ user: { login: "kjgbot" } });
    // The stub is minimal: no number/base/head, so dispatcher key derivation
    // falls through to the same unwrapped-record fields as today.
    expect(enriched).toMatchObject({ number: 156, author: "kjgbot" });
    // The stored record stays untouched (no shape pollution in meta.json).
    expect(data.pull_request).toBeUndefined();
  });

  it("leaves non-pull_request and authorless watch payloads unenriched", () => {
    const issueNormalized = normalizeWebhook({
      headers: { "x-github-event": "issues" },
      connectionId: "conn_123",
      payload: {
        ...repoPayload(),
        action: "opened",
        issue: { number: 9, title: "An issue", user: { login: "kjgbot" } },
      },
    });
    const issueData = buildGitHubWebhookFileData(issueNormalized);
    expect(enrichGitHubWatchPayload(issueData, issueNormalized)).toBe(issueData);

    const authorlessNormalized = normalizeWebhook({
      headers: { "x-github-event": "pull_request" },
      connectionId: "conn_123",
      payload: {
        ...repoPayload(),
        action: "opened",
        pull_request: { number: 7, title: "No user", state: "open" },
      },
    });
    const authorlessData = buildGitHubWebhookFileData(authorlessNormalized);
    expect(enrichGitHubWatchPayload(authorlessData, authorlessNormalized)).toBe(
      authorlessData,
    );

    // An already-nested pull_request is never overwritten.
    const preNested = { author: "kjgbot", pull_request: { number: 7 } };
    expect(
      enrichGitHubWatchPayload(preNested, authorlessNormalized).pull_request,
    ).toEqual({ number: 7 });
  });

  it("still treats actual GitHub deletions as deletes", () => {
    const normalized = normalizeWebhook({
      headers: { "x-github-event": "issues" },
      connectionId: "conn_123",
      payload: {
        ...repoPayload(),
        action: "deleted",
        issue: {
          number: 43,
          title: "Fix bug",
        },
      },
    });

    expect(isGitHubWebhookDeletionEvent(normalized)).toBe(true);
    expect(buildGitHubWebhookIngestData(normalized).eventType).toBe(
      GITHUB_RELAYFILE_FILE_DELETED_EVENT,
    );
  });

  it("normalizes deployment_status events to a canonical deployment-status path", () => {
    const normalized = normalizeWebhook({
      headers: { "x-github-event": "deployment_status" },
      connectionId: "conn_123",
      payload: {
        ...repoPayload(),
        action: "created",
        deployment: { id: 42, environment: "production", sha: "abc123" },
        deployment_status: {
          id: 555,
          state: "success",
          target_url: "https://deploy.example/status/555",
          created_at: "2026-06-02T22:00:00Z",
        },
      },
    });

    expect(normalized.eventType).toBe("deployment_status.created");
    expect(normalized.objectType).toBe("deployment_status");
    expect(normalized.objectId).toBe("555");
    expect(isGitHubWebhookDeletionEvent(normalized)).toBe(false);
    expect(computePath(normalized)).toBe(
      "/github/repos/AgentWorkforce/cloud/deployments/42/statuses/555.json",
    );
    expect(buildGitHubWebhookFileData(normalized)).toMatchObject({
      id: 555,
      state: "success",
      target_url: "https://deploy.example/status/555",
      targetUrl: "https://deploy.example/status/555",
      createdAt: "2026-06-02T22:00:00Z",
      deployment_id: 42,
      deploymentId: 42,
      environment: "production",
      deployment_environment: "production",
      deployment_sha: "abc123",
      repository: expect.objectContaining({
        full_name: "AgentWorkforce/cloud",
      }),
      _webhook: expect.objectContaining({
        eventType: "deployment_status.created",
        objectType: "deployment_status",
        objectId: "555",
      }),
    });
    expect(buildGitHubWebhookFileData(normalized)).not.toHaveProperty(
      "deployment_status",
    );
  });

  it("preserves string deployment_status identifiers in canonical paths", () => {
    const normalized = normalizeWebhook({
      headers: { "x-github-event": "deployment_status" },
      connectionId: "conn_123",
      payload: {
        ...repoPayload(),
        action: "created",
        deployment: { id: "dep_42", environment: "production" },
        deployment_status: { id: "status_555", state: "failure" },
      },
    });

    expect(normalized.objectId).toBe("status_555");
    expect(computePath(normalized)).toBe(
      "/github/repos/AgentWorkforce/cloud/deployments/dep_42/statuses/status_555.json",
    );
  });
});
