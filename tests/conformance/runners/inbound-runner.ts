// Inbound webhook runner.
//
// Drives the REAL webhook router code path:
//   provider webhook -> routeNangoWebhook -> per-provider forward handler ->
//   adapter normalizer/path-mapper -> record-writer -> relayfile write (HTTP)
// Mocked boundary: relayfile persistence (mock-relayfile-server over HTTP),
// relayauth token mint (fetch stub), and a permissive Nango SDK mock for any
// incidental enrichment proxy calls. Evidence is writes[].{path,content,...}.
//
// The relayfile write happens BEFORE the (best-effort) integration-watch
// dispatch, so a post-write watch error — which would otherwise need proactive-
// runtime tables this harness does not create — is tolerated: we capture the
// write either way and only fail if expected writes are missing.

import {
  type ConformanceManifest,
  type InboundFixture,
} from "../manifest-schema.ts";
import { missingSubstrings, pathMatches } from "../assertions.ts";
import type { FixtureResult } from "../harness-types.ts";
import {
  WORKSPACE_ID,
  NANGO_SECRET,
  installBaseEnv,
  resetNangoClient,
  installRelayauthFetchStub,
  clearRunEnv,
} from "../harness-env.ts";

import { createRelayfileWritebackPgliteDb } from "../../helpers/relayfile-writeback-pglite-db.ts";
import { startMockRelayfile } from "../../helpers/mock-relayfile-server.ts";
import {
  startMockNangoSdkServer,
  type NangoMockSyncTrigger,
} from "../../helpers/mock-nango-sdk-server.ts";

const DEFAULT_CONNECTION_ID = "conn_inbound_conformance";

type RelayfileWrite = {
  path: string;
  content: string;
  encoding: string;
  contentType?: string;
};

type WatchDispatch = {
  provider?: string;
  eventType?: string;
  connectionId?: string | null;
  paths?: readonly string[];
};

async function importRouter() {
  return import(
    new URL(
      "../../../packages/web/lib/integrations/nango-webhook-router.ts",
      import.meta.url,
    ).href
  ) as Promise<{
    routeNangoWebhook: (envelope: {
      from: string;
      type: string;
      providerConfigKey: string;
      connectionId: string | null;
      payload: unknown;
    }) => Promise<void>;
  }>;
}

export async function runInboundFixture(
  manifest: ConformanceManifest,
  fixture: InboundFixture,
  providerConfigKey: string,
): Promise<FixtureResult> {
  const label = `inbound:${fixture.event}`;
  const errors: string[] = [];

  const connectionId = fixture.connectionId ?? DEFAULT_CONNECTION_ID;
  const from = fixture.from ?? providerConfigKey;
  const type = fixture.type ?? "forward";

  installBaseEnv();

  const db = await createRelayfileWritebackPgliteDb();
  const relayfile = await startMockRelayfile();
  let nangoServer:
    | Awaited<ReturnType<typeof startMockNangoSdkServer>>
    | undefined;
  const restoreFetch = installRelayauthFetchStub();
  const watchDispatches: WatchDispatch[] = [];
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleLog = console.log;

  const captureWatchDispatch = (args: unknown[]) => {
    const first = args[0];
    const second = args[1];
    if (
      typeof first === "string" &&
      first.startsWith("Integration watch dispatch ") &&
      second &&
      typeof second === "object" &&
      !Array.isArray(second)
    ) {
      const record = second as Record<string, unknown>;
      watchDispatches.push({
        provider: typeof record.provider === "string" ? record.provider : undefined,
        eventType: typeof record.eventType === "string" ? record.eventType : undefined,
        connectionId:
          typeof record.connectionId === "string" ? record.connectionId : null,
        paths: Array.isArray(record.paths)
          ? record.paths.filter((p): p is string => typeof p === "string")
          : Array.isArray(record.eventPaths)
            ? record.eventPaths.filter((p): p is string => typeof p === "string")
            : undefined,
      });
    }
  };

  try {
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: manifest.provider,
      connectionId,
      providerConfigKey,
      ...(fixture.metadata ? { metadata: fixture.metadata } : {}),
    });

    process.env.RELAYFILE_URL = relayfile.url;

    // Nango mock for inbound enrichment proxy calls (e.g. Slack resolves a
    // channel name via /conversations.info). Fixtures supply canned responses
    // via mockNango; anything unmatched gets a permissive { status: 200 }.
    const responders = fixture.mockNango ?? [];
    nangoServer = await startMockNangoSdkServer({
      secret: NANGO_SECRET,
      respond: (req) => {
        for (const r of responders) {
          if (r.method && req.method.toUpperCase() !== r.method.toUpperCase()) {
            continue;
          }
          if (r.endpointMatches) {
            try {
              if (!new RegExp(r.endpointMatches).test(req.endpoint)) continue;
            } catch {
              continue;
            }
          }
          return { status: r.status ?? 200, body: r.body ?? {} };
        }
        return { status: 200, body: {} };
      },
    });
    process.env.NANGO_HOST = nangoServer.url;
    await resetNangoClient();

    const { routeNangoWebhook } = await importRouter();

    console.log = (...args: unknown[]) => {
      captureWatchDispatch(args);
      originalConsoleLog(...args);
    };
    console.error = (...args: unknown[]) => {
      captureWatchDispatch(args);
      originalConsoleError(...args);
    };
    console.warn = (...args: unknown[]) => {
      captureWatchDispatch(args);
      originalConsoleWarn(...args);
    };

    let routeError: string | undefined;
    try {
      await routeNangoWebhook({
        from,
        type,
        providerConfigKey,
        connectionId,
        payload: fixture.payload,
      });
    } catch (error) {
      // Tolerated only if the expected writes still landed (e.g. a post-write
      // watch-dispatch failure). Recorded as a diagnostic.
      routeError = error instanceof Error ? error.message : String(error);
    }

    const writes = relayfile.writes as RelayfileWrite[];

    const minWrites =
      fixture.expect.minWrites ??
      ((fixture.expect.triggersSync || fixture.expect.triggersWatch) &&
      !fixture.expect.paths &&
      !fixture.expect.pathPatterns
        ? 0
        : 1);
    if (writes.length < minWrites) {
      errors.push(
        `expected >= ${minWrites} relayfile write(s), got ${writes.length}` +
          (routeError ? ` (router error: ${routeError})` : ""),
      );
    }

    for (const exactPath of fixture.expect.paths ?? []) {
      const match = writes.find((w) => w.path === exactPath);
      if (!match) {
        errors.push(
          `expected write path ${exactPath} not found in writes: ${JSON.stringify(writes.map((w) => w.path))}`,
        );
      }
    }
    for (const pattern of fixture.expect.pathPatterns ?? []) {
      const match = writes.find((w) => pathMatches(w.path, undefined, pattern));
      if (!match) {
        errors.push(
          `expected write path matching /${pattern}/ not found in writes: ${JSON.stringify(writes.map((w) => w.path))}`,
        );
      }
    }

    // contentIncludes is checked against the concatenation of all matched
    // write contents (any write may carry the expected fields).
    if (fixture.expect.contentIncludes && writes.length > 0) {
      const haystack = writes.map((w) => w.content).join("\n");
      errors.push(...missingSubstrings(haystack, fixture.expect.contentIncludes));
    }

    for (const expected of fixture.expect.triggersSync ?? []) {
      const match = (nangoServer?.syncTriggers ?? []).find(
        (trigger: NangoMockSyncTrigger) =>
          trigger.syncName === expected.syncName &&
          (expected.providerConfigKey === undefined ||
            trigger.providerConfigKey === expected.providerConfigKey) &&
          (expected.connectionId === undefined ||
            trigger.connectionId === expected.connectionId),
      );
      if (!match) {
        errors.push(
          `expected sync trigger ${expected.providerConfigKey ?? providerConfigKey}:${expected.syncName}` +
            ` not found in triggers: ${JSON.stringify((nangoServer?.syncTriggers ?? []).map((t) => `${t.providerConfigKey}:${t.connectionId}:${t.syncName}`))}`,
        );
      }
    }

    for (const expected of fixture.expect.triggersWatch ?? []) {
      const match = watchDispatches.find((dispatch) => {
        if (dispatch.provider !== expected.provider) return false;
        if (dispatch.eventType !== expected.eventType) return false;
        if (
          expected.connectionId !== undefined &&
          dispatch.connectionId !== expected.connectionId
        ) {
          return false;
        }
        if (expected.path === undefined && expected.pathPattern === undefined) return true;
        return (dispatch.paths ?? []).some((p) =>
          pathMatches(p, expected.path, expected.pathPattern),
        );
      });
      if (!match) {
        errors.push(
          `expected watch trigger ${expected.provider}:${expected.eventType}` +
            ` not found in triggers: ${JSON.stringify(watchDispatches)}`,
        );
      }
    }

    return {
      direction: "inbound",
      label,
      passed: errors.length === 0,
      errors,
      evidence: {
        routeError,
        writes: writes.map((w) => ({
          path: w.path,
          content: w.content,
          encoding: w.encoding,
          contentType: w.contentType,
        })),
        syncTriggers: (nangoServer?.syncTriggers ?? []).map((trigger) => ({
          connectionId: trigger.connectionId,
          providerConfigKey: trigger.providerConfigKey,
          syncName: trigger.syncName,
          syncMode: trigger.syncMode,
        })),
        watchDispatches,
      },
    };
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;
    restoreFetch();
    if (nangoServer) await nangoServer.close();
    await relayfile.close();
    await db.cleanup();
    clearRunEnv();
    await resetNangoClient();
  }
}
