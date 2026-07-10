import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findGitLabIntegrationByProjectWebhookToken: vi.fn(),
  gitLabIntegrationMetadataMatchesProjectToken: vi.fn(),
  listWorkspaceIntegrationsForProvider: vi.fn(),
  getNangoClient: vi.fn(),
  triggerNangoSyncs: vi.fn(),
  claimWebhookDelivery: vi.fn(),
  releaseWebhookDelivery: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findGitLabIntegrationByProjectWebhookToken: mocks.findGitLabIntegrationByProjectWebhookToken,
  gitLabIntegrationMetadataMatchesProjectToken: mocks.gitLabIntegrationMetadataMatchesProjectToken,
  listWorkspaceIntegrationsForProvider: mocks.listWorkspaceIntegrationsForProvider,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  triggerNangoSyncs: mocks.triggerNangoSyncs,
}));

vi.mock("@/lib/ricky/webhook-dedup", () => ({
  claimWebhookDelivery: mocks.claimWebhookDelivery,
  releaseWebhookDelivery: mocks.releaseWebhookDelivery,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { handleGitLabHookdeckWebhook } from "./gitlab-hookdeck-webhook";

const integration = {
  workspaceId: "ws_123",
  provider: "gitlab",
  connectionId: "conn_gitlab",
  providerConfigKey: "gitlab-relay",
  installationId: null,
  metadata: {},
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const payload = {
  event_type: "merge_request",
  object_kind: "merge_request",
  project: { id: 20, path_with_namespace: "acme/api" },
  object_attributes: { id: 9001, iid: 7, action: "update", state: "opened" },
};

describe("handleGitLabHookdeckWebhook", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findGitLabIntegrationByProjectWebhookToken.mockResolvedValue(integration);
    mocks.gitLabIntegrationMetadataMatchesProjectToken.mockReturnValue(false);
    mocks.listWorkspaceIntegrationsForProvider.mockResolvedValue([]);
    mocks.getNangoClient.mockReturnValue({ getConnection: vi.fn() });
    mocks.triggerNangoSyncs.mockResolvedValue({ ok: true });
    mocks.claimWebhookDelivery.mockResolvedValue(true);
    mocks.releaseWebhookDelivery.mockResolvedValue(undefined);
  });

  it("verifies the GitLab token against selected project metadata and triggers the MR sync", async () => {
    const result = await handleGitLabHookdeckWebhook(
      JSON.stringify(payload),
      new Headers({
        "x-gitlab-event": "Merge Request Hook",
        "x-gitlab-event-uuid": "event-123",
        "x-gitlab-token": "secret-token",
      }),
    );

    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.response.status).toBe(200);
    await expect(result.response.json()).resolves.toMatchObject({
      accepted: true,
      ingress: "hookdeck",
    });
    expect(mocks.findGitLabIntegrationByProjectWebhookToken).toHaveBeenCalledWith(
      "20",
      "secret-token",
      expect.any(Function),
    );
    expect(mocks.claimWebhookDelivery).toHaveBeenCalledWith({
      surface: "gitlab",
      deliveryId: "event-123",
    });
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
      syncs: ["fetch-merge-requests"],
      syncMode: "incremental",
    });
  });

  it("releases the dedup claim when triggering syncs fails so Hookdeck retries are not lost", async () => {
    const failure = new Error("nango unavailable");
    mocks.triggerNangoSyncs.mockRejectedValue(failure);

    await expect(
      handleGitLabHookdeckWebhook(
        JSON.stringify(payload),
        new Headers({
          "x-gitlab-event": "Merge Request Hook",
          "x-gitlab-event-uuid": "event-retry-123",
          "x-gitlab-token": "secret-token",
        }),
      ),
    ).rejects.toThrow(failure);

    expect(mocks.releaseWebhookDelivery).toHaveBeenCalledWith({
      surface: "gitlab",
      deliveryId: "event-retry-123",
    });
  });

  it("preserves the trigger failure when dedup release also fails", async () => {
    const triggerFailure = new Error("nango unavailable");
    mocks.triggerNangoSyncs.mockRejectedValue(triggerFailure);
    mocks.releaseWebhookDelivery.mockRejectedValue(new Error("dedup database unavailable"));

    await expect(
      handleGitLabHookdeckWebhook(
        JSON.stringify(payload),
        new Headers({
          "x-gitlab-event": "Merge Request Hook",
          "x-gitlab-event-uuid": "event-release-fails",
          "x-gitlab-token": "secret-token",
        }),
      ),
    ).rejects.toThrow(triggerFailure);

    expect(mocks.releaseWebhookDelivery).toHaveBeenCalledWith({
      surface: "gitlab",
      deliveryId: "event-release-fails",
    });
  });

  it("routes issue deliveries to the GitLab issue sync", async () => {
    const result = await handleGitLabHookdeckWebhook(
      JSON.stringify({
        event_type: "issue",
        object_kind: "issue",
        project: { id: 20, path_with_namespace: "acme/api" },
        object_attributes: { id: 3001, iid: 17, action: "close", state: "closed" },
      }),
      new Headers({
        "x-gitlab-event": "Issue Hook",
        "x-gitlab-event-uuid": "event-issue-123",
        "x-gitlab-token": "secret-token",
      }),
    );

    expect(result.handled).toBe(true);
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
      syncs: ["fetch-issues"],
      syncMode: "incremental",
    });
  });

  it("routes push deliveries to the GitLab commit sync", async () => {
    const result = await handleGitLabHookdeckWebhook(
      JSON.stringify({
        event_type: "push",
        object_kind: "push",
        project: { id: 20, path_with_namespace: "acme/api" },
      }),
      new Headers({
        "x-gitlab-event": "Push Hook",
        "x-gitlab-event-uuid": "event-push-123",
        "x-gitlab-token": "secret-token",
      }),
    );

    expect(result.handled).toBe(true);
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
      syncs: ["fetch-commits"],
      syncMode: "incremental",
    });
  });

  it("routes GitLab tag push deliveries to the tag sync", async () => {
    const result = await handleGitLabHookdeckWebhook(
      JSON.stringify({
        event_type: "tag_push",
        object_kind: "tag_push",
        project: { id: 20, path_with_namespace: "acme/api" },
      }),
      new Headers({
        "x-gitlab-event": "Tag Push Hook",
        "x-gitlab-event-uuid": "event-tag-push-123",
        "x-gitlab-token": "secret-token",
      }),
    );

    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.response.status).toBe(200);
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
      syncs: ["fetch-tags"],
      syncMode: "incremental",
    });
  });

  it("routes GitLab pipeline and deployment deliveries to their syncs", async () => {
    const pipelineResult = await handleGitLabHookdeckWebhook(
      JSON.stringify({
        object_kind: "pipeline",
        project: { id: 20, path_with_namespace: "acme/api" },
        object_attributes: { id: 9001, status: "failed" },
      }),
      new Headers({
        "x-gitlab-event": "Pipeline Hook",
        "x-gitlab-event-uuid": "event-pipeline-123",
        "x-gitlab-token": "secret-token",
      }),
    );

    expect(pipelineResult.handled).toBe(true);
    expect(mocks.triggerNangoSyncs).toHaveBeenLastCalledWith({
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
      syncs: ["fetch-pipelines"],
      syncMode: "incremental",
    });

    const jobResult = await handleGitLabHookdeckWebhook(
      JSON.stringify({
        object_kind: "build",
        project: { id: 20, path_with_namespace: "acme/api" },
        build_id: 101,
        build_status: "failed",
      }),
      new Headers({
        "x-gitlab-event": "Job Hook",
        "x-gitlab-event-uuid": "event-job-123",
        "x-gitlab-token": "secret-token",
      }),
    );

    expect(jobResult.handled).toBe(true);
    expect(mocks.triggerNangoSyncs).toHaveBeenLastCalledWith({
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
      syncs: ["fetch-pipelines"],
      syncMode: "incremental",
    });

    const deploymentResult = await handleGitLabHookdeckWebhook(
      JSON.stringify({
        object_kind: "deployment",
        project: { id: 20, path_with_namespace: "acme/api" },
        status: "success",
      }),
      new Headers({
        "x-gitlab-event": "Deployment Hook",
        "x-gitlab-event-uuid": "event-deployment-123",
        "x-gitlab-token": "secret-token",
      }),
    );

    expect(deploymentResult.handled).toBe(true);
    expect(mocks.triggerNangoSyncs).toHaveBeenLastCalledWith({
      providerConfigKey: "gitlab-relay",
      connectionId: "conn_gitlab",
      syncs: ["fetch-deployments"],
      syncMode: "incremental",
    });
  });

  it("rejects deliveries whose token does not map to the selected project", async () => {
    mocks.findGitLabIntegrationByProjectWebhookToken.mockResolvedValue(null);

    const result = await handleGitLabHookdeckWebhook(
      JSON.stringify(payload),
      new Headers({
        "x-gitlab-event": "Merge Request Hook",
        "x-gitlab-token": "wrong",
      }),
    );

    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.response.status).toBe(401);
    expect(mocks.triggerNangoSyncs).not.toHaveBeenCalled();
  });
});
