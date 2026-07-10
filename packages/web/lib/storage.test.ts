import { beforeEach, describe, expect, it, vi } from "vitest";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  isWorkerRuntime: vi.fn(),
  mintCredentialStoreCredentials: vi.fn(),
  mintScopedS3Credentials: vi.fn(),
  optionalEnv: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    WorkflowStorage: {
      bucketName: "workflow-storage-test",
    },
  },
}));

vi.mock("@/lib/cloudflare-context", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}));

vi.mock("@/lib/aws/runtime", () => ({
  isWorkerRuntime: mocks.isWorkerRuntime,
}));

vi.mock("@/lib/aws/sts-credentials", () => ({
  mintCredentialStoreCredentials: mocks.mintCredentialStoreCredentials,
  mintScopedS3Credentials: mocks.mintScopedS3Credentials,
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
}));

import {
  createCredentialStoreS3Client,
  createWorkflowStorageS3Client,
  createWorkflowStorageS3ClientForRun,
} from "./storage";

describe("storage S3 client factories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCloudflareContext.mockReturnValue({
      env: {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "worker-access-key",
        AWS_SECRET_ACCESS_KEY: "worker-secret-key",
        WORKFLOW_STORAGE_BUCKET: "workflow-storage-test",
      },
    });
    mocks.isWorkerRuntime.mockReturnValue(true);
    mocks.mintCredentialStoreCredentials.mockResolvedValue({
      accessKeyId: "credential-store-access-key",
      secretAccessKey: "credential-store-secret-key",
      sessionToken: "credential-store-session-token",
    });
    mocks.mintScopedS3Credentials.mockResolvedValue({
      accessKeyId: "run-access-key",
      secretAccessKey: "run-secret-key",
      sessionToken: "run-session-token",
    });
  });

  it("uses Smithy's fetch handler for Worker workflow-storage clients", () => {
    const client = createWorkflowStorageS3Client();

    expect(client.config.requestHandler).toBeInstanceOf(FetchHttpHandler);
  });

  it("uses Smithy's fetch handler for Worker run-scoped clients", async () => {
    const client = await createWorkflowStorageS3ClientForRun({
      userId: "user-1",
      runId: "run-1",
    });

    expect(client.config.requestHandler).toBeInstanceOf(FetchHttpHandler);
  });

  it("uses Smithy's fetch handler for Worker credential-store clients", async () => {
    const client = await createCredentialStoreS3Client({ userId: "user-1" });

    expect(client.config.requestHandler).toBeInstanceOf(FetchHttpHandler);
  });
});
