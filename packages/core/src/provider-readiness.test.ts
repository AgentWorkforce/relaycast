import { afterEach, describe, expect, it } from "vitest";
import { setDbForTesting } from "./db/client.js";
import {
  aggregateProviderInitialSync,
  markProviderInitialSyncComplete,
  markProviderInitialSyncFailed,
  markProviderInitialSyncQueued,
  markProviderInitialSyncRunning,
  markProviderOAuthConnected,
  parseIntegrationMetadata,
  readProviderReadiness,
} from "./provider-readiness.js";

type AdapterShape = "node-postgres" | "postgres-js";

type IntegrationRow = {
  workspaceId: string;
  provider: string;
  metadataJson: string;
};

type UpdateValues = {
  metadataJson?: string;
  updatedAt?: Date;
};

class FakeReadinessDb {
  readonly updates: UpdateValues[] = [];
  private row: IntegrationRow | null;

  constructor(
    private readonly adapterShape: AdapterShape,
    row: IntegrationRow | null,
  ) {
    this.row = row ? { ...row } : null;
  }

  get storedRow(): IntegrationRow | null {
    return this.row ? { ...this.row } : null;
  }

  select() {
    return {
      from: () => ({
        where: () => ({
          limit: async () => (this.row ? [{ ...this.row }] : []),
        }),
      }),
    };
  }

  update() {
    return {
      set: (values: UpdateValues) => ({
        where: async () => {
          this.updates.push(values);
          if (this.row && values.metadataJson !== undefined) {
            this.row = {
              ...this.row,
              metadataJson: values.metadataJson,
            };
          }

          // Drizzle query builder callers ignore update results here, but keep
          // both driver-like shapes to prove no hidden dependency on either.
          return this.adapterShape === "node-postgres"
            ? { rows: [], rowCount: this.row ? 1 : 0 }
            : [];
        },
      }),
    };
  }
}

function installDb(adapterShape: AdapterShape, row: IntegrationRow | null) {
  const db = new FakeReadinessDb(adapterShape, row);
  setDbForTesting(db as never);
  return db;
}

function readinessFrom(db: FakeReadinessDb) {
  const metadataJson = db.storedRow?.metadataJson ?? "{}";
  return readProviderReadiness(parseIntegrationMetadata(metadataJson));
}

const baseRow: IntegrationRow = {
  workspaceId: "ws_123",
  provider: "confluence",
  metadataJson: "{}",
};

describe.each<AdapterShape>(["node-postgres", "postgres-js"])(
  "provider readiness adapter invariance (%s)",
  (adapterShape) => {
    afterEach(() => {
      setDbForTesting(null);
    });

    it("returns null on empty select and does not attempt an update", async () => {
      const db = installDb(adapterShape, null);

      await markProviderInitialSyncQueued({
        workspaceId: "ws_123",
        provider: "confluence",
        syncName: "fetch-pages",
        model: "Page",
      });

      expect(db.updates).toHaveLength(0);
      expect(db.storedRow).toBeNull();
    });

    it("destructures the selected row and writes queued metadata", async () => {
      const db = installDb(adapterShape, baseRow);

      await markProviderInitialSyncQueued({
        workspaceId: "ws_123",
        provider: "confluence",
        syncName: "fetch-pages",
        model: "Page",
        modifiedAfter: "2026-05-19T10:00:00.000Z",
        at: "2026-05-19T10:01:00.000Z",
      });

      expect(db.updates).toHaveLength(1);
      expect(readinessFrom(db)).toMatchObject({
        updatedAt: "2026-05-19T10:01:00.000Z",
        initialSync: {
          state: "queued",
          enqueuedAt: "2026-05-19T10:01:00.000Z",
          syncName: "fetch-pages",
          model: "Page",
          modifiedAfter: "2026-05-19T10:00:00.000Z",
        },
      });
    });

    it("preserves OAuth connected metadata semantics", async () => {
      const db = installDb(adapterShape, baseRow);

      await markProviderOAuthConnected({
        workspaceId: "ws_123",
        provider: "confluence",
        connectionId: "conn_123",
        providerConfigKey: "confluence-relay",
        at: "2026-05-19T10:02:00.000Z",
      });

      expect(readinessFrom(db)).toMatchObject({
        oauthConnectedAt: "2026-05-19T10:02:00.000Z",
        lastAuthAt: "2026-05-19T10:02:00.000Z",
        connectionId: "conn_123",
        providerConfigKey: "confluence-relay",
        initialSync: {
          state: "queued",
          enqueuedAt: "2026-05-19T10:02:00.000Z",
        },
      });
    });

    it("preserves running, complete, and failed metadata semantics", async () => {
      const db = installDb(adapterShape, baseRow);

      await markProviderInitialSyncRunning({
        workspaceId: "ws_123",
        provider: "confluence",
        syncName: "fetch-pages",
        model: "Page",
        at: "2026-05-19T10:03:00.000Z",
      });
      expect(readinessFrom(db)).toMatchObject({
        initialSync: {
          state: "running",
          startedAt: "2026-05-19T10:03:00.000Z",
          syncName: "fetch-pages",
          model: "Page",
        },
      });

      await markProviderInitialSyncComplete({
        workspaceId: "ws_123",
        provider: "confluence",
        syncName: "fetch-pages",
        model: "Page",
        at: "2026-05-19T10:04:00.000Z",
      });
      expect(readinessFrom(db)).toMatchObject({
        initialSync: {
          state: "complete",
          completedAt: "2026-05-19T10:04:00.000Z",
          failedAt: null,
        },
      });

      await markProviderInitialSyncFailed({
        workspaceId: "ws_123",
        provider: "confluence",
        error: "upstream failed",
        syncName: "fetch-pages",
        model: "Page",
        at: "2026-05-19T10:05:00.000Z",
      });
      expect(readinessFrom(db)).toMatchObject({
        initialSync: {
          state: "failed",
          failedAt: "2026-05-19T10:05:00.000Z",
          lastError: "upstream failed",
        },
      });
    });

    it("tracks generated Nango model readiness independently of the legacy scalar", async () => {
      const db = installDb(adapterShape, {
        ...baseRow,
        provider: "slack",
      });
      const expectedModelKeys = [
        "slack-relay:fetch-channel-history:SlackMessage",
        "slack-relay:fetch-users:SlackUser",
        "slack-relay:fetch-channels:SlackChannel",
      ];

      await markProviderInitialSyncRunning({
        workspaceId: "ws_123",
        provider: "slack",
        providerConfigKey: "slack-relay",
        syncName: "fetch-users",
        model: "SlackUser",
        at: "2026-05-19T10:03:00.000Z",
      });
      await markProviderInitialSyncComplete({
        workspaceId: "ws_123",
        provider: "slack",
        providerConfigKey: "slack-relay",
        syncName: "fetch-channel-history",
        model: "SlackMessage",
        at: "2026-05-19T10:04:00.000Z",
      });
      await markProviderInitialSyncComplete({
        workspaceId: "ws_123",
        provider: "slack",
        providerConfigKey: "slack-relay",
        syncName: "fetch-users",
        model: "SlackUser",
        at: "2026-05-19T10:05:00.000Z",
      });

      const partial = readinessFrom(db);
      expect(partial?.initialSync.byModel).toMatchObject({
        "slack-relay:fetch-users:SlackUser": {
          state: "complete",
          completedAt: "2026-05-19T10:05:00.000Z",
        },
        "slack-relay:fetch-channel-history:SlackMessage": {
          state: "complete",
          completedAt: "2026-05-19T10:04:00.000Z",
        },
      });
      expect(
        aggregateProviderInitialSync({
          initialSync: partial!.initialSync,
          expectedModelKeys,
        }).state,
      ).toBe("queued");

      await markProviderInitialSyncComplete({
        workspaceId: "ws_123",
        provider: "slack",
        providerConfigKey: "slack-relay",
        syncName: "fetch-channels",
        model: "SlackChannel",
        at: "2026-05-19T10:06:00.000Z",
      });

      const complete = readinessFrom(db);
      expect(
        aggregateProviderInitialSync({
          initialSync: complete!.initialSync,
          expectedModelKeys,
        }),
      ).toMatchObject({
        state: "complete",
        completedAt: "2026-05-19T10:06:00.000Z",
      });

      await markProviderInitialSyncRunning({
        workspaceId: "ws_123",
        provider: "slack",
        providerConfigKey: "slack-relay",
        syncName: "fetch-users",
        model: "SlackUser",
        at: "2026-05-19T10:07:00.000Z",
      });

      const incremental = readinessFrom(db);
      expect(
        aggregateProviderInitialSync({
          initialSync: incremental!.initialSync,
          expectedModelKeys,
        }),
      ).toMatchObject({
        state: "complete",
        completedAt: "2026-05-19T10:06:00.000Z",
      });

      await markProviderInitialSyncFailed({
        workspaceId: "ws_123",
        provider: "slack",
        providerConfigKey: "slack-relay",
        syncName: "fetch-users",
        model: "SlackUser",
        error: "incremental users failed",
        at: "2026-05-19T10:08:00.000Z",
      });

      const failedIncremental = readinessFrom(db);
      expect(
        aggregateProviderInitialSync({
          initialSync: failedIncremental!.initialSync,
          expectedModelKeys,
        }),
      ).toMatchObject({
        state: "complete",
        completedAt: "2026-05-19T10:06:00.000Z",
        failedAt: null,
        lastError: null,
      });
    });
  },
);
