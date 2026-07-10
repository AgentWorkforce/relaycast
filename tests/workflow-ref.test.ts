import { describe, expect, it } from "vitest";
import { packageWorkflowRef } from "@/lib/workers/workflow-ref";

describe("packageWorkflowRef", () => {
  it("includes the per-workspace relaycast API key in the serialized worker payload", () => {
    const ref = packageWorkflowRef({
      runId: "run_123",
      workspaceId: "ws_123",
      relayWorkspaceId: "rw_12345678",
      relaycastApiKey: "rk_live_workspace",
      relayfileUrl: "https://relayfile.test",
      relayfileToken: "jwt-token",
      workflow: "name: test",
      fileType: "yaml",
    });

    expect(ref.type).toBe("inline");
    expect(JSON.parse(ref.value)).toEqual({
      runId: "run_123",
      workspaceId: "ws_123",
      relayWorkspaceId: "rw_12345678",
      relaycastApiKey: "rk_live_workspace",
      relayfileUrl: "https://relayfile.test",
      relayfileToken: "jwt-token",
      workflow: "name: test",
      fileType: "yaml",
      sourceFileType: "yaml",
      workflowFileName: "workflow.yaml",
    });
  });

  it("serializes Ricky rerun context and isolated source-sync fields for worker dispatch", () => {
    const ref = packageWorkflowRef({
      runId: "run_repaired",
      workspaceId: "ws_123",
      relayWorkspaceId: "rw_12345678",
      relaycastApiKey: "rk_live_workspace",
      relaycastBaseUrl: "https://api.relaycast.test",
      relayfileUrl: "https://relayfile.test",
      relayfileToken: "jwt-token",
      workflow: "export default workflow;",
      fileType: "ts",
      sourceFileType: "ts",
      workflowFileName: "repair.ts",
      envSecrets: { DEPLOY_TOKEN: "secret-ref" },
      metadata: {
        RICKY_RUN_ID: "ricky_123",
        RICKY_ATTEMPT: "2",
        RICKY_REPAIR_MODE: "ricky_openrouter",
      },
      s3CodeKey: "user-123/run_repaired/code.tar.gz",
      resumeRunId: "run_resume",
      startFrom: "verify",
      previousRunId: "run_failed",
    });

    expect(JSON.parse(ref.value)).toEqual({
      runId: "run_repaired",
      workspaceId: "ws_123",
      relayWorkspaceId: "rw_12345678",
      relaycastApiKey: "rk_live_workspace",
      relaycastBaseUrl: "https://api.relaycast.test",
      relayfileUrl: "https://relayfile.test",
      relayfileToken: "jwt-token",
      workflow: "export default workflow;",
      fileType: "ts",
      sourceFileType: "ts",
      workflowFileName: "repair.ts",
      envSecrets: { DEPLOY_TOKEN: "secret-ref" },
      metadata: {
        RICKY_RUN_ID: "ricky_123",
        RICKY_ATTEMPT: "2",
        RICKY_REPAIR_MODE: "ricky_openrouter",
      },
      s3CodeKey: "user-123/run_repaired/code.tar.gz",
      resumeRunId: "run_resume",
      startFrom: "verify",
      previousRunId: "run_failed",
    });
  });
});
