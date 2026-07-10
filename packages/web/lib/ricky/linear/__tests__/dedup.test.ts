import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { setDbForTesting } from "@/lib/db";
import { claimWebhookDelivery } from "../../webhook-dedup";

let pg: PGlite | null = null;

describe("Ricky webhook dedup", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE ricky_webhook_dedup (
        surface text NOT NULL,
        delivery_id text NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (surface, delivery_id)
      );
      CREATE INDEX ricky_webhook_dedup_expires_idx ON ricky_webhook_dedup (expires_at);
    `);
    setDbForTesting(drizzle(pg) as never);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("rejects repeated deliveries per surface but does not collide across surfaces", async () => {
    const now = new Date("2026-05-07T12:00:00Z");

    expect(await claimWebhookDelivery({ surface: "linear", deliveryId: "same", now })).toBe(true);
    expect(await claimWebhookDelivery({ surface: "linear", deliveryId: "same", now })).toBe(false);
    expect(await claimWebhookDelivery({ surface: "slack", deliveryId: "same", now })).toBe(true);
  });

  it("allows an expired delivery to be reclaimed", async () => {
    const first = new Date("2026-05-07T12:00:00Z");
    const second = new Date("2026-05-07T12:00:02Z");

    expect(await claimWebhookDelivery({ surface: "linear", deliveryId: "wh_1", ttlMs: 1000, now: first })).toBe(true);
    expect(await claimWebhookDelivery({ surface: "linear", deliveryId: "wh_1", ttlMs: 1000, now: second })).toBe(true);

    const rows = await pg!.query<{ claimed_at: string; expires_at: string }>(
      "SELECT claimed_at::text, expires_at::text FROM ricky_webhook_dedup WHERE surface = 'linear' AND delivery_id = 'wh_1'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(new Date(rows.rows[0].claimed_at).toISOString()).toBe(second.toISOString());
    expect(new Date(rows.rows[0].expires_at).toISOString()).toBe(new Date(second.getTime() + 1000).toISOString());
  });

  it("uses the same atomic claim semantics for HTTP consumers and integration-watch", async () => {
    const now = new Date("2026-05-07T12:00:00Z");

    expect(await claimWebhookDelivery({ surface: "webhook-dispatch", deliveryId: "workspace:github:consumer:delivery-1", now })).toBe(true);
    expect(await claimWebhookDelivery({ surface: "webhook-dispatch", deliveryId: "workspace:github:consumer:delivery-1", now })).toBe(false);
    expect(await claimWebhookDelivery({ surface: "webhook-dispatch", deliveryId: "workspace:github:other-consumer:delivery-1", now })).toBe(true);
    expect(await claimWebhookDelivery({ surface: "webhook-dispatch", deliveryId: "workspace:integration-watch:agent:delivery-1", now })).toBe(true);
    expect(await claimWebhookDelivery({ surface: "webhook-dispatch", deliveryId: "workspace:integration-watch:agent:delivery-1", now })).toBe(false);
  });

  it("hashes oversized delivery ids before storage for legacy varchar-compatible claims", async () => {
    const now = new Date("2026-05-07T12:00:00Z");
    const oversizedDeliveryId = [
      "workspace-1",
      "integration-watch",
      "agent-1",
      "integration-watch",
      "github",
      "issues.opened",
      "conn-1",
      "/github/repos/AgentWorkforce/cloud/issues/1041__e2e-small-persona-verification-after-queue-resilience/meta.json",
      "x".repeat(260),
    ].join(":");

    expect(oversizedDeliveryId.length).toBeGreaterThan(255);
    expect(await claimWebhookDelivery({
      surface: "webhook-dispatch",
      deliveryId: oversizedDeliveryId,
      now,
    })).toBe(true);
    expect(await claimWebhookDelivery({
      surface: "webhook-dispatch",
      deliveryId: oversizedDeliveryId,
      now,
    })).toBe(false);

    const rows = await pg!.query<{ delivery_id: string }>(
      "SELECT delivery_id FROM ricky_webhook_dedup WHERE surface = 'webhook-dispatch'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].delivery_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds raw SQL timestamps as strings for Hyperdrive compatibility", async () => {
    const executedParams: unknown[] = [];
    const queryText = (query: unknown): string =>
      ((query as { queryChunks?: unknown[] }).queryChunks ?? [])
        .map((chunk) => {
          const value = (chunk as { value?: unknown }).value;
          return Array.isArray(value) ? value.join("") : "";
        })
        .join("");
    const execute = async (query: unknown) => {
      const params = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
      executedParams.push(...params);
      expect(params.some((param) => param instanceof Date)).toBe(false);

      const text = queryText(query);
      if (text.includes("SELECT expires_at")) {
        return [];
      }
      if (text.includes("INSERT INTO ricky_webhook_dedup")) {
        return [{ delivery_id: "delivery-1" }];
      }
      return [];
    };

    setDbForTesting({
      transaction: async (callback: (tx: { execute: typeof execute }) => Promise<boolean>) =>
        callback({ execute }),
    } as never);

    const now = new Date("2026-05-07T12:00:00Z");
    expect(await claimWebhookDelivery({ surface: "webhook-dispatch", deliveryId: "delivery-1", now })).toBe(true);

    expect(executedParams).toContain("2026-05-07T12:00:00.000Z");
    expect(executedParams).toContain("2026-05-08T12:00:00.000Z");
  });
});
