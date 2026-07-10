import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CredentialBundle, S3Credentials } from "../../packages/core/src/auth/credentials.js";

const fakeS3Creds: S3Credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "token",
  bucket: "test-bucket",
  prefix: "user-123/run-456",
};

describe("Orchestrator Cloud API token passthrough", () => {
  it("injects Cloud API tokens into the launch credential bundle", async () => {
    const { Orchestrator } = await import("../../packages/core/src/orchestrator.js");
    const orchestrator = new Orchestrator(
      { agents: [{ name: "test", command: "echo hi" }] } as never,
      {
        daytonaAuth: { apiKey: "daytona-key" },
        cloudApiUrl: "https://cloud.example.com",
        cloudApiAccessToken: "access-token",
        cloudApiRefreshToken: "refresh-token",
        cloudApiAccessTokenExpiresAt: "2026-03-13T12:00:00.000Z",
      }
    ) as any;

    const bundle = orchestrator.buildLaunchCredentialBundle({
      s3Credentials: fakeS3Creds,
      cliCredentials: '{"provider":"openai"}',
      workspaceId: "workspace-123",
      relayApiKey: "relay-key",
      runId: "run-123",
      userId: "user-123",
      daytonaApiKey: "daytona-key",
    });

    assert.equal(bundle.cloudApiUrl, "https://cloud.example.com");
    assert.equal(bundle.cloudApiAccessToken, "access-token");
    assert.equal(bundle.cloudApiRefreshToken, "refresh-token");
    assert.equal(
      bundle.cloudApiAccessTokenExpiresAt,
      "2026-03-13T12:00:00.000Z"
    );
    assert.equal(bundle.daytonaApiKey, "daytona-key");
    assert.equal(bundle.runId, "run-123");
  });
});
