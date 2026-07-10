// Worker-safe nango sync dedup contract.
//
// This module MUST stay free of Node-only / Worker-incompatible imports
// (no `../db/client.js`, no `pg`). It is transitively reachable from the
// Cloudflare `webhook-worker` queue consumer, which is bundled by esbuild
// for the Workers runtime (see tests/b1-worker-import-safety.test.ts).
//
// The Postgres-backed implementation lives in `./nango-sync-dedup-postgres.js`
// and is only ever imported on a Node/Hyperdrive-capable runtime. Keep the
// pg consumer out of this file so the Worker bundle never pulls `pg`.

export const NANGO_SYNC_DEDUP_SURFACE = "nango-sync";
export const GITLAB_HOOKDECK_DEDUP_SURFACE = "gitlab-hookdeck-delivery";
export const DEFAULT_NANGO_SYNC_DEDUP_LEASE_MS = 15 * 60 * 1000;

export type NangoSyncDedupeClaimInput = {
  surface: typeof NANGO_SYNC_DEDUP_SURFACE | typeof GITLAB_HOOKDECK_DEDUP_SURFACE;
  dedupeId: string;
  workspaceId?: string;
  provider?: string;
  connectionId?: string;
  providerConfigKey?: string;
  syncName?: string;
  model?: string;
  syncWindowKey?: string;
  cursorKey?: string;
  payloadHash?: string;
};

export type NangoSyncDedupeKey = {
  surface: NangoSyncDedupeClaimInput["surface"];
  dedupeId: string;
};

export type NangoSyncDedupeClaimResult =
  | {
      type: "claimed";
      key: NangoSyncDedupeKey;
      attemptCount: number;
      leaseExpiresAt: Date;
    }
  | {
      type: "duplicate_completed";
      key: NangoSyncDedupeKey;
      completedAt?: Date;
    }
  | {
      type: "duplicate_in_flight";
      key: NangoSyncDedupeKey;
      leaseExpiresAt?: Date;
    };

export type NangoSyncDedupStore = {
  claim(
    input: NangoSyncDedupeClaimInput,
    options?: { now?: Date; leaseMs?: number },
  ): Promise<NangoSyncDedupeClaimResult>;
  complete(key: NangoSyncDedupeKey, options?: { now?: Date }): Promise<void>;
  fail(key: NangoSyncDedupeKey, error: unknown, options?: { now?: Date }): Promise<void>;
};
