import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectWorkflowAgentConfigs,
  compileAgentPermissions,
} from "../../packages/core/src/cloud-index.js";

describe("workflow agent permissions", () => {
  it("collects and merges YAML agent permissions from top-level and workflow agents", () => {
    const config = `
agents:
  - name: code-agent
    interactive: false
    scopes:
      - relayfile:fs:read:/**
    permissions:
      ignored:
        - secrets/
        - .env
      readonly:
        - README.md
workflows:
  - name: my-workflow
    agents:
      - name: code-agent
        permissions:
          ignored:
            - "**/*.pem"
          readonly:
            - package.json
      - name: review-agent
        preset: reviewer
        permissions:
          readonly: ["*"]
`;

    assert.deepEqual(collectWorkflowAgentConfigs(config), [
      {
        name: "code-agent",
        interactive: false,
        scopes: ["relayfile:fs:read:/**"],
        permissions: {
          ignored: ["secrets/", ".env", "**/*.pem"],
          readonly: ["README.md", "package.json"],
        },
      },
      {
        name: "review-agent",
        preset: "reviewer",
        scopes: undefined,
        permissions: {
          readonly: ["*"],
        },
      },
    ]);
  });

  it("applies default system permissions to compiled agent scopes and ACL rules", () => {
    const compiled = compileAgentPermissions("code-agent", {});
    const scopes = new Set(compiled.scopes);
    const rootAcl = new Set(compiled.aclRules["/"] ?? []);

    assert.equal(compiled.agentName, "code-agent");
    assert.ok(scopes.has("fs:read"));
    assert.ok(scopes.has("fs:write"));
    assert.ok(scopes.has("sync:read"));
    assert.ok(scopes.has("workspace:code-agent:read:*"));
    assert.ok(scopes.has("workspace:code-agent:write:*"));
    assert.ok(scopes.has("workspace:code-agent:read:/.env"));
    assert.ok(scopes.has("workspace:code-agent:read:/.env.*"));
    assert.ok(scopes.has("workspace:code-agent:read:/**/*.pem"));
    assert.ok(scopes.has("workspace:code-agent:write:/.env"));
    assert.ok(scopes.has("workspace:code-agent:write:/.github/workflows/*"));
    assert.ok(scopes.has("workspace:code-agent:write:/docker-compose*.yml"));
    assert.ok(scopes.has("workspace:code-agent:write:/Dockerfile"));

    assert.deepEqual(Object.keys(compiled.aclRules), ["/"]);
    assert.ok(rootAcl.has("allow:agent:cloud-orchestrator"));
    assert.ok(rootAcl.has("allow:scope:workspace:code-agent:read:*"));
    assert.ok(rootAcl.has("allow:scope:workspace:code-agent:write:*"));
    assert.ok(rootAcl.has("deny:scope:workspace:code-agent:read:/.env"));
    assert.ok(rootAcl.has("deny:scope:workspace:code-agent:read:/**/*.pem"));
    assert.ok(rootAcl.has("deny:scope:workspace:code-agent:write:/.github/workflows/*"));
  });
});
