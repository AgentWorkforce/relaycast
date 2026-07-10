import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyDaytonaAuthEnv,
  buildCredentialBundle,
  buildStepCredentials,
  credentialsToEnv,
  DEFAULT_RELAY_BASE_URL,
  resolveDaytonaAuthCredentials,
  type S3Credentials,
  type CredentialBundle,
} from "../../packages/core/src/auth/credentials.js";

const fakeS3Creds: S3Credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "FwoGZXIvYXdzEBYaDHqa0AP",
  bucket: "test-bucket",
  prefix: "user-123/run-456",
};

describe("buildCredentialBundle", () => {
  it("returns all fields from params", () => {
    const bundle = buildCredentialBundle({
      s3Credentials: fakeS3Creds,
      cliCredentials: '{"token":"abc"}',
      credentialProxyUrl: "https://proxy.example.com",
      credentialProxyTokens: { anthropic: "jwt-token" },
      workspaceId: "ws-1",
      relayApiKey: "relay-key",
      runId: "run-456",
      userId: "user-123",
      cloudApiUrl: "https://cloud.example.com",
      cloudApiAccessToken: "access-token",
      cloudApiRefreshToken: "refresh-token",
      cloudApiAccessTokenExpiresAt: "2026-03-13T12:00:00.000Z",
      callbackUrl: "https://example.com/callback",
      callbackToken: "cb-token",
      daytonaJwtToken: "daytona-jwt",
      daytonaOrganizationId: "org-1",
      s3CodeKey: "code.tar.gz",
      workflowConfig: '{"agents":[]}',
    });

    assert.deepEqual(bundle.s3Credentials, fakeS3Creds);
    assert.equal(bundle.cliCredentials, '{"token":"abc"}');
    assert.equal(bundle.credentialProxyUrl, "https://proxy.example.com");
    assert.deepEqual(bundle.credentialProxyTokens, { anthropic: "jwt-token" });
    assert.equal(bundle.workspaceId, "ws-1");
    assert.equal(bundle.relayApiKey, "relay-key");
    assert.equal(bundle.runId, "run-456");
    assert.equal(bundle.userId, "user-123");
    assert.equal(bundle.cloudApiUrl, "https://cloud.example.com");
    assert.equal(bundle.cloudApiAccessToken, "access-token");
    assert.equal(bundle.cloudApiRefreshToken, "refresh-token");
    assert.equal(bundle.cloudApiAccessTokenExpiresAt, "2026-03-13T12:00:00.000Z");
    assert.equal(bundle.callbackUrl, "https://example.com/callback");
    assert.equal(bundle.callbackToken, "cb-token");
    assert.equal(bundle.daytonaJwtToken, "daytona-jwt");
    assert.equal(bundle.daytonaOrganizationId, "org-1");
    assert.equal(bundle.s3CodeKey, "code.tar.gz");
    assert.equal(bundle.workflowConfig, '{"agents":[]}');
  });

  it("works with optional fields omitted", () => {
    const bundle = buildCredentialBundle({
      s3Credentials: fakeS3Creds,
      cliCredentials: "",
      workspaceId: "ws-1",
      relayApiKey: "key",
      runId: "r1",
      userId: "u1",
    });

    assert.equal(bundle.callbackUrl, undefined);
    assert.equal(bundle.callbackToken, undefined);
    assert.equal(bundle.cloudApiUrl, undefined);
    assert.equal(bundle.cloudApiAccessToken, undefined);
    assert.equal(bundle.cloudApiRefreshToken, undefined);
    assert.equal(bundle.cloudApiAccessTokenExpiresAt, undefined);
    assert.equal(bundle.daytonaApiKey, undefined);
    assert.equal(bundle.daytonaJwtToken, undefined);
    assert.equal(bundle.daytonaOrganizationId, undefined);
    assert.equal(bundle.credentialProxyUrl, undefined);
    assert.equal(bundle.credentialProxyTokens, undefined);
    assert.equal(bundle.s3CodeKey, undefined);
    assert.equal(bundle.workflowConfig, undefined);
  });

  it("defaults relayBaseUrl to DEFAULT_RELAY_BASE_URL when omitted or blank", () => {
    const omitted = buildCredentialBundle({
      s3Credentials: fakeS3Creds,
      cliCredentials: "",
      workspaceId: "ws-1",
      relayApiKey: "key",
      runId: "r1",
      userId: "u1",
    });
    assert.equal(omitted.relayBaseUrl, DEFAULT_RELAY_BASE_URL);

    const blank = buildCredentialBundle({
      s3Credentials: fakeS3Creds,
      cliCredentials: "",
      workspaceId: "ws-1",
      relayApiKey: "key",
      runId: "r1",
      userId: "u1",
      relayBaseUrl: "   ",
    });
    assert.equal(blank.relayBaseUrl, DEFAULT_RELAY_BASE_URL);
  });

  it("honors an explicit relayBaseUrl (e.g. staging/self-hosted)", () => {
    const bundle = buildCredentialBundle({
      s3Credentials: fakeS3Creds,
      cliCredentials: "",
      workspaceId: "ws-1",
      relayApiKey: "key",
      runId: "r1",
      userId: "u1",
      relayBaseUrl: "https://relaycast.staging.internal",
    });
    assert.equal(bundle.relayBaseUrl, "https://relaycast.staging.internal");
  });
});

describe("buildStepCredentials", () => {
  it("extracts subset from bundle and adds sandboxId", () => {
    const bundle: CredentialBundle = {
      s3Credentials: fakeS3Creds,
      cliCredentials: '{"token":"abc"}',
      credentialProxyUrl: "https://proxy.example.com",
      credentialProxyTokens: { anthropic: "jwt-token" },
      workspaceId: "ws-1",
      relayApiKey: "relay-key",
      relayBaseUrl: "https://api.relaycast.dev",
      runId: "run-456",
      userId: "user-123",
      cloudApiUrl: "https://cloud.example.com",
      cloudApiAccessToken: "access-token",
      cloudApiRefreshToken: "refresh-token",
      cloudApiAccessTokenExpiresAt: "2026-03-13T12:00:00.000Z",
      callbackUrl: "https://example.com/callback",
      callbackToken: "cb-token",
      daytonaJwtToken: "daytona-jwt",
      daytonaOrganizationId: "org-1",
    };

    const step = buildStepCredentials(bundle, "sandbox-789");

    assert.deepEqual(step.s3Credentials, fakeS3Creds);
    assert.equal(step.cliCredentials, '{"token":"abc"}');
    assert.equal(step.credentialProxyUrl, "https://proxy.example.com");
    assert.deepEqual(step.credentialProxyTokens, { anthropic: "jwt-token" });
    assert.equal(step.workspaceId, "ws-1");
    assert.equal(step.relayApiKey, "relay-key");
    assert.equal(step.relayBaseUrl, "https://api.relaycast.dev");
    assert.equal(step.runId, "run-456");
    assert.equal(step.userId, "user-123");
    assert.equal(step.sandboxId, "sandbox-789");
    assert.equal(step.cloudApiUrl, "https://cloud.example.com");
    assert.equal(step.cloudApiAccessToken, "access-token");
    assert.equal(step.cloudApiRefreshToken, "refresh-token");
    assert.equal(step.cloudApiAccessTokenExpiresAt, "2026-03-13T12:00:00.000Z");
    // Should NOT have callbackUrl, callbackToken, or Daytona auth
    assert.equal("callbackUrl" in step, false);
    assert.equal("daytonaApiKey" in step, false);
    assert.equal("daytonaJwtToken" in step, false);
    assert.equal("daytonaOrganizationId" in step, false);
  });
});

describe("credentialsToEnv", () => {
  it("maps step credentials to environment variables", () => {
    const env = credentialsToEnv({
      s3Credentials: fakeS3Creds,
      cliCredentials: '{"t":"x"}',
      workspaceId: "ws-1",
      relayApiKey: "relay-key",
      relayBaseUrl: "https://api.relaycast.dev",
      runId: "run-456",
      userId: "user-123",
      sandboxId: "sandbox-789",
      cloudApiUrl: "https://cloud.example.com",
      cloudApiAccessToken: "access-token",
      cloudApiRefreshToken: "refresh-token",
      cloudApiAccessTokenExpiresAt: "2026-03-13T12:00:00.000Z",
    });

    assert.equal(env.S3_ACCESS_KEY_ID, "AKIAIOSFODNN7EXAMPLE");
    assert.equal(env.S3_SECRET_ACCESS_KEY, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    assert.equal(env.S3_SESSION_TOKEN, "FwoGZXIvYXdzEBYaDHqa0AP");
    assert.equal(env.S3_BUCKET, "test-bucket");
    assert.equal(env.S3_PREFIX, "user-123/run-456");
    assert.equal(env.WORKFLOW_STORAGE_BACKEND, "s3");
    assert.equal(env.WORKFLOW_STORAGE_CLOUD_API_URL, "https://cloud.example.com");
    assert.equal(env.WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN, "access-token");
    assert.equal(env.RELAY_WORKSPACE_ID, "ws-1");
    assert.equal(env.RELAY_API_KEY, "relay-key");
    assert.equal(env.RELAY_BASE_URL, "https://api.relaycast.dev");
    assert.equal(env.RUN_ID, "run-456");
    assert.equal(env.USER_ID, "user-123");
    assert.equal(env.SANDBOX_ID, "sandbox-789");
    assert.equal(env.CLOUD_API_URL, "https://cloud.example.com");
    assert.equal(env.CLOUD_API_ACCESS_TOKEN, "access-token");
    assert.equal(env.CLOUD_API_REFRESH_TOKEN, "refresh-token");
    assert.equal(env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT, "2026-03-13T12:00:00.000Z");
  });

  it("prefers cloud-api storage refresh tokens for workflow storage env", () => {
    const env = credentialsToEnv({
      s3Credentials: {
        ...fakeS3Creds,
        backend: "cloud-api",
        cloudApiRefreshToken: "storage-refresh-token",
      },
      cliCredentials: "",
      workspaceId: "ws-1",
      relayApiKey: "relay-key",
      relayBaseUrl: "https://api.relaycast.dev",
      runId: "run-456",
      userId: "user-123",
      sandboxId: "sandbox-789",
      cloudApiRefreshToken: "bundle-refresh-token",
    });

    assert.equal(env.CLOUD_API_REFRESH_TOKEN, "storage-refresh-token");
  });

  it("returns exactly 18 keys", () => {
    const env = credentialsToEnv({
      s3Credentials: fakeS3Creds,
      cliCredentials: "",
      workspaceId: "ws",
      relayApiKey: "rk",
      relayBaseUrl: "https://api.relaycast.dev",
      runId: "r",
      userId: "u",
      sandboxId: "s",
      cloudApiUrl: "https://cloud.example.com",
      cloudApiAccessToken: "cld_at_token",
      cloudApiRefreshToken: "cld_rt_token",
      cloudApiAccessTokenExpiresAt: "2026-03-14T00:00:00.000Z",
    });

    assert.equal(Object.keys(env).length, 18);
  });

  it("does not include credential proxy env vars in the base mapping", () => {
    const env = credentialsToEnv({
      s3Credentials: fakeS3Creds,
      cliCredentials: "",
      workspaceId: "ws",
      relayApiKey: "rk",
      relayBaseUrl: "https://api.relaycast.dev",
      runId: "r",
      userId: "u",
      sandboxId: "s",
      cloudApiUrl: "https://cloud.example.com",
      cloudApiAccessToken: "cld_at_token",
      cloudApiRefreshToken: "cld_rt_token",
      cloudApiAccessTokenExpiresAt: "2026-03-14T00:00:00.000Z",
    });

    for (const key of [
      "RELAY_LLM_PROXY",
      "RELAY_LLM_PROXY_URL",
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "GOOGLE_API_BASE",
      "OPENAI_API_BASE",
      "CREDENTIAL_PROXY_TOKEN",
      "RELAY_LLM_PROXY_TOKEN",
    ]) {
      assert.equal(key in env, false);
    }
  });
});

describe("resolveDaytonaAuthCredentials", () => {
  it("prefers apiKey when present", () => {
    assert.deepEqual(
      resolveDaytonaAuthCredentials({
        apiKey: " api-key ",
        jwtToken: "jwt-token",
        organizationId: "org-1",
      }),
      { apiKey: "api-key" },
    );
  });

  it("accepts jwtToken with organizationId", () => {
    assert.deepEqual(
      resolveDaytonaAuthCredentials({
        jwtToken: " jwt-token ",
        organizationId: " org-1 ",
      }),
      { jwtToken: "jwt-token", organizationId: "org-1" },
    );
  });

  it("rejects missing organizationId for jwt auth", () => {
    assert.throws(
      () => resolveDaytonaAuthCredentials({ jwtToken: "jwt-token" }),
      { message: "DAYTONA_ORGANIZATION_ID is required when using Daytona JWT auth" },
    );
  });
});

describe("applyDaytonaAuthEnv", () => {
  it("writes jwt auth env vars without DAYTONA_API_KEY", () => {
    const env: Record<string, string> = {};
    applyDaytonaAuthEnv(env, {
      jwtToken: "jwt-token",
      organizationId: "org-1",
    });

    assert.deepEqual(env, {
      DAYTONA_JWT_TOKEN: "jwt-token",
      DAYTONA_ORGANIZATION_ID: "org-1",
    });
  });
});
