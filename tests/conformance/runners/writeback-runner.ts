// Outbound writeback runner.
//
// Drives the REAL writeback bridge code path:
//   relayfile file write -> executeRelayfileProviderWriteback -> provider
//   executor -> Nango action/proxy
// Only the Nango SDK + provider HTTP boundary is mocked (mock-nango-sdk-server),
// plus a PGLite app DB for the workspace_integration lookup + receipt write.
// Evidence is capturedRequests[].{method, endpoint, query, body, connectionId,
// providerConfigKey} — the surface G5 diffs against provider API docs.

import {
  type ConformanceManifest,
  type WritebackFixture,
} from "../manifest-schema.ts";
import { deepSubsetMismatch } from "../assertions.ts";
import type { FixtureResult, RunOptions } from "../harness-types.ts";
import {
  WORKSPACE_ID,
  NANGO_SECRET,
  installBaseEnv,
  resetNangoClient,
  clearRunEnv,
} from "../harness-env.ts";

import { createRelayfileWritebackPgliteDb } from "../../helpers/relayfile-writeback-pglite-db.ts";
import {
  startMockNangoSdkServer,
  type NangoMockRequest,
} from "../../helpers/mock-nango-sdk-server.ts";

type ExecuteResult = {
  outcome: "success" | "permanent_failure" | "retryable_failure";
  provider: string;
  error?: { code: string; message: string };
  metadata?: unknown;
};

async function importBridge() {
  return import(
    new URL(
      "../../../packages/web/lib/integrations/relayfile-writeback-bridge.ts",
      import.meta.url,
    ).href
  ) as Promise<{
    executeRelayfileProviderWriteback: (
      input: Record<string, unknown>,
      options?: { fetchImpl?: typeof fetch },
    ) => Promise<ExecuteResult>;
  }>;
}

function serializeContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

export async function runWritebackFixture(
  manifest: ConformanceManifest,
  fixture: WritebackFixture,
  providerConfigKey: string,
  options: RunOptions = {},
): Promise<FixtureResult> {
  const label = `writeback:${fixture.action}`;
  const errors: string[] = [];
  const expectedOutcome = fixture.expectOutcome ?? "success";

  const connectionId =
    options.live && options.liveConnections?.[providerConfigKey]
      ? options.liveConnections[providerConfigKey]
      : `conn_${manifest.provider}_conformance`;

  installBaseEnv();

  const db = await createRelayfileWritebackPgliteDb();
  let nangoServer:
    | Awaited<ReturnType<typeof startMockNangoSdkServer>>
    | undefined;
  let captured: NangoMockRequest[] = [];

  try {
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: manifest.provider,
      connectionId,
      providerConfigKey,
      // Mirror a real Nango connection's connection_config (e.g. Atlassian
      // Cloud cloudId) when the fixture supplies it.
      ...(fixture.metadata ? { metadata: fixture.metadata } : {}),
    });

    if (!options.live) {
      const mock = fixture.mockResponse ?? { status: 200, body: {} };
      nangoServer = await startMockNangoSdkServer({
        secret: NANGO_SECRET,
        respond: () => ({ status: mock.status ?? 200, body: mock.body ?? {} }),
      });
      captured = nangoServer.capturedRequests;
      process.env.NANGO_HOST = nangoServer.url;
    } else {
      // Live mode targets the real Nango host configured in the environment
      // (NANGO_HOST / NANGO_SECRET_KEY_PRODUCTION supplied by the caller).
      if (process.env.NANGO_SECRET_KEY_PRODUCTION) {
        process.env.NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY_PRODUCTION;
      }
    }
    await resetNangoClient();

    const { executeRelayfileProviderWriteback } = await importBridge();

    let result: ExecuteResult | undefined;
    try {
      result = await executeRelayfileProviderWriteback({
        opId: `op_${manifest.provider}_${fixture.action}`,
        workspaceId: WORKSPACE_ID,
        path: fixture.filePath,
        revision: "rev_conformance",
        correlationId: `corr_${manifest.provider}_${fixture.action}`,
        action: fixture.fileAction ?? "file_upsert",
        content: serializeContent(fixture.content),
        contentType: fixture.contentType ?? "application/json",
        provider: manifest.provider,
      });
    } catch (error) {
      errors.push(
        `executeRelayfileProviderWriteback threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (result && result.outcome !== expectedOutcome) {
      errors.push(
        `expected outcome ${expectedOutcome}, got ${result.outcome}` +
          (result.error ? ` (${result.error.code}: ${result.error.message})` : ""),
      );
    }

    // For non-success expectations the captured-call assertions are optional.
    if (expectedOutcome === "success" && !options.live) {
      if (captured.length === 0) {
        errors.push("no outbound Nango request was captured");
      } else {
        const ec = fixture.expectCall;
        // Find the captured request matching method + endpoint; report the
        // closest candidate otherwise.
        const match = captured.find((req) => {
          if (req.method.toUpperCase() !== ec.method.toUpperCase()) return false;
          if (ec.endpoint !== undefined) return req.endpoint === ec.endpoint;
          if (ec.endpointMatches !== undefined) {
            try {
              return new RegExp(ec.endpointMatches).test(req.endpoint);
            } catch {
              return false;
            }
          }
          return true;
        });
        if (!match) {
          errors.push(
            `no captured request matched ${ec.method} ${ec.endpoint ?? ec.endpointMatches}; captured: ` +
              JSON.stringify(captured.map((r) => `${r.method} ${r.endpoint}`)),
          );
        } else {
          if (ec.connectionId && match.connectionId !== ec.connectionId) {
            errors.push(
              `connectionId mismatch: expected ${ec.connectionId}, got ${match.connectionId}`,
            );
          }
          if (ec.providerConfigKey && match.providerConfigKey !== ec.providerConfigKey) {
            errors.push(
              `providerConfigKey mismatch: expected ${ec.providerConfigKey}, got ${match.providerConfigKey}`,
            );
          }
          if (ec.bodyIncludes) {
            errors.push(...deepSubsetMismatch(ec.bodyIncludes, match.body));
          }
        }
      }
    }

    return {
      direction: "writeback",
      label,
      passed: errors.length === 0,
      errors,
      evidence: {
        outcome: result?.outcome,
        error: result?.error,
        capturedRequests: captured.map((r) => ({
          method: r.method,
          endpoint: r.endpoint,
          query: r.query,
          body: r.body,
          connectionId: r.connectionId,
          providerConfigKey: r.providerConfigKey,
        })),
      },
    };
  } finally {
    if (nangoServer) await nangoServer.close();
    await db.cleanup();
    clearRunEnv();
    await resetNangoClient();
  }
}
