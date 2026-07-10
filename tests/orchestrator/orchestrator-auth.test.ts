import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for Orchestrator explicit Daytona auth — no process.env.DAYTONA_API_KEY.
 *
 * The Orchestrator should accept daytonaAuth credentials in its constructor,
 * following the same pattern as credentialEncryptionKey. It should NOT read
 * process.env.DAYTONA_API_KEY anywhere.
 */

import {
  buildCredentialBundle,
  resolveDaytonaAuthCredentials,
  type DaytonaAuthCredentials,
} from "../../packages/core/src/auth/credentials.js";

describe("Orchestrator Daytona auth (explicit credentials)", () => {
  describe("DaytonaAuthCredentials in credential bundle", () => {
    it("includes daytonaApiKey in bundle when API key auth is used", () => {
      const daytonaAuth: DaytonaAuthCredentials = { apiKey: "dtn_test_key" };
      const resolved = resolveDaytonaAuthCredentials(daytonaAuth);

      assert.deepEqual(resolved, { apiKey: "dtn_test_key" });

      const bundle = buildCredentialBundle({
        s3Credentials: {
          accessKeyId: "AK", secretAccessKey: "SK",
          sessionToken: "ST", bucket: "b", prefix: "p",
        },
        cliCredentials: "",
        workspaceId: "ws", relayApiKey: "rk", runId: "r", userId: "u",
        daytonaApiKey: "apiKey" in resolved ? resolved.apiKey : undefined,
      });

      assert.equal(bundle.daytonaApiKey, "dtn_test_key");
      assert.equal(bundle.daytonaJwtToken, undefined);
    });

    it("includes JWT token + org ID in bundle when JWT auth is used", () => {
      const daytonaAuth: DaytonaAuthCredentials = {
        jwtToken: "jwt-abc",
        organizationId: "org-123",
      };
      const resolved = resolveDaytonaAuthCredentials(daytonaAuth);

      const bundle = buildCredentialBundle({
        s3Credentials: {
          accessKeyId: "AK", secretAccessKey: "SK",
          sessionToken: "ST", bucket: "b", prefix: "p",
        },
        cliCredentials: "",
        workspaceId: "ws", relayApiKey: "rk", runId: "r", userId: "u",
        daytonaJwtToken: "jwtToken" in resolved ? resolved.jwtToken : undefined,
        daytonaOrganizationId: "organizationId" in resolved ? resolved.organizationId : undefined,
      });

      assert.equal(bundle.daytonaApiKey, undefined);
      assert.equal(bundle.daytonaJwtToken, "jwt-abc");
      assert.equal(bundle.daytonaOrganizationId, "org-123");
    });

    it("throws when no Daytona auth is provided", () => {
      assert.throws(
        () => resolveDaytonaAuthCredentials({}),
        { message: "Daytona auth is required in credential bundle" },
      );
    });

    it("prefers apiKey over JWT when both are present", () => {
      const resolved = resolveDaytonaAuthCredentials({
        apiKey: "dtn_key", jwtToken: "jwt-token", organizationId: "org-1",
      });
      assert.deepEqual(resolved, { apiKey: "dtn_key" });
    });
  });

  describe("Orchestrator constructor accepts daytonaAuth", () => {
    it("accepts OrchestratorOptions with daytonaAuth as second argument", async () => {
      const { Orchestrator } = await import("../../packages/core/src/orchestrator.js");

      const orchestrator = new Orchestrator(
        { agents: [{ name: "test", cli: "claude" }] } as any,
        { daytonaAuth: { apiKey: "dtn_explicit_key" } }
      );
      assert.ok(orchestrator);
    });

    it("accepts JWT-based auth in constructor options", async () => {
      const { Orchestrator } = await import("../../packages/core/src/orchestrator.js");

      const orchestrator = new Orchestrator(
        { agents: [{ name: "test", cli: "claude" }] } as any,
        { daytonaAuth: { jwtToken: "jwt-abc", organizationId: "org-123" } }
      );
      assert.ok(orchestrator);
    });
  });

  describe("No process.env.DAYTONA_API_KEY in orchestrator source", () => {
    it("orchestrator.ts should not reference process.env.DAYTONA_API_KEY", async () => {
      const { readFileSync } = await import("node:fs");
      const source = readFileSync("packages/core/src/orchestrator.ts", "utf-8");
      assert.ok(
        !source.includes("process.env.DAYTONA_API_KEY"),
        "orchestrator.ts should not read process.env.DAYTONA_API_KEY — use explicit daytonaAuth"
      );
    });
  });
});
