import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { setDbForTesting } from "@/lib/db";

let pg: PGlite | null = null;

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000b1";

describe("deployment integration watch health SQL", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE agents (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        watch_globs text[],
        watch_rules jsonb
      );

      CREATE TABLE integration_watch_deliveries (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL,
        agent_id uuid NOT NULL,
        delivery_id text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        delivered_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    setDbForTesting(drizzle(pg) as never);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("executes the health summary query and only counts recent failed deliveries", async () => {
    await pg!.exec(`
      INSERT INTO agents (
        id,
        workspace_id,
        created_at,
        watch_globs,
        watch_rules
      )
      VALUES (
        '${AGENT_ID}',
        '${WORKSPACE_ID}',
        now() - interval '2 days',
        ARRAY['github/issues/**'],
        NULL
      );

      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status,
        delivered_at,
        created_at,
        updated_at
      )
      VALUES
        (
          '00000000-0000-0000-0000-000000000101',
          '${WORKSPACE_ID}',
          '${AGENT_ID}',
          'old-failed',
          '{"type":"github.issues.opened"}'::jsonb,
          'failed',
          NULL,
          now() - interval '13 hours',
          now() - interval '13 hours'
        ),
        (
          '00000000-0000-0000-0000-000000000102',
          '${WORKSPACE_ID}',
          '${AGENT_ID}',
          'recent-failed',
          '{"type":"github.issues.opened"}'::jsonb,
          'failed',
          NULL,
          now() - interval '1 hour',
          now() - interval '1 hour'
        ),
        (
          '00000000-0000-0000-0000-000000000103',
          '${WORKSPACE_ID}',
          '${AGENT_ID}',
          'recent-delivered',
          '{"type":"github.issues.opened"}'::jsonb,
          'delivered',
          now() - interval '30 minutes',
          now() - interval '30 minutes',
          now() - interval '30 minutes'
        ),
        (
          '00000000-0000-0000-0000-000000000104',
          '00000000-0000-0000-0000-0000000000c1',
          '${AGENT_ID}',
          'other-workspace-recent-failed',
          '{"type":"github.issues.opened"}'::jsonb,
          'failed',
          NULL,
          now() - interval '1 hour',
          now() - interval '1 hour'
        );
    `);

    const { getAgentIntegrationWatchHealthSummaries } = await import("./route");

    const summaries = await getAgentIntegrationWatchHealthSummaries(WORKSPACE_ID, [AGENT_ID]);
    const summary = summaries.get(AGENT_ID);

    expect(summary).toBeDefined();
    expect(Number(summary?.recent_failed_delivery_count)).toBe(1);
    expect(Number(summary?.pending_delivery_count)).toBe(0);
    expect(summary?.last_successful_delivery_at).toBeTruthy();
    expect(summary?.last_failed_delivery_at).toBeTruthy();
  });
});
