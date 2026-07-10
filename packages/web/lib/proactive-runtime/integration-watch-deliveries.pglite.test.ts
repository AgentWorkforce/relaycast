import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { setDbForTesting } from "@/lib/db";

const mocks = vi.hoisted(() => ({
  deliverDeploymentTrigger: vi.fn(),
  pollDeploymentTriggerRun: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

vi.mock("@/lib/proactive-runtime/deployment-trigger-delivery", () => ({
  DeploymentTriggerDeliveryError: class DeploymentTriggerDeliveryError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status: number,
    ) {
      super(message);
      this.name = "DeploymentTriggerDeliveryError";
    }
  },
  DeploymentSandboxProvisioningPendingError: class DeploymentSandboxProvisioningPendingError extends Error {
    readonly code = "sandbox_provisioning_pending";
    readonly status = 503;
  },
  DeploymentSandboxProvisioningTerminalError: class DeploymentSandboxProvisioningTerminalError extends Error {
    readonly code = "sandbox_provisioning_terminal";
    readonly status = 502;
  },
  DeploymentTriggerRunPendingError: class DeploymentTriggerRunPendingError extends Error {
    readonly code = "deployment_run_pending";
    readonly status = 202;
    constructor(readonly run: {
      deploymentId: string;
      sandboxId: string;
      sessionId: string;
      commandId: string;
      startedAt: string;
      sandboxName?: string | null;
      mountConfigured?: boolean;
    }) {
      super(`Deployment run ${run.commandId} is still running`);
      this.name = "DeploymentTriggerRunPendingError";
    }
  },
  deliverDeploymentTrigger: mocks.deliverDeploymentTrigger,
  pollDeploymentTriggerRun: mocks.pollDeploymentTriggerRun,
}));

let pg: PGlite | null = null;

describe("integration watch delivery sweep age guard", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE agents (
        id uuid PRIMARY KEY,
        delivery_max_concurrency integer,
        delivery_max_concurrency_by_trigger jsonb
      );

      CREATE TABLE integration_watch_deliveries (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL,
        agent_id uuid NOT NULL,
        delivery_id text NOT NULL,
        trigger_key text,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        lease_until timestamptz,
        provisioning_sandbox_id text,
        run_deployment_id uuid,
        run_sandbox_id text,
        run_session_id text,
        run_command_id text,
        run_started_at timestamptz,
        run_sandbox_name text,
        run_mount_configured boolean,
        last_error text,
        delivered_at timestamptz,
        terminal_writeback_status text,
        slack_terminal_reply_status text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      INSERT INTO agents (id, delivery_max_concurrency, delivery_max_concurrency_by_trigger)
      VALUES ('00000000-0000-0000-0000-000000000002', NULL, NULL);
    `);
    setDbForTesting(drizzle(pg) as never);
    mocks.deliverDeploymentTrigger.mockResolvedValue({
      agentId: "00000000-0000-0000-0000-000000000002",
      workspaceId: "00000000-0000-0000-0000-000000000001",
      deploymentId: "deployment-1",
      status: "starting",
    });
    mocks.pollDeploymentTriggerRun.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("sweeps fresh pending rows but skips over-age stranded rows", async () => {
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status,
        next_attempt_at,
        created_at,
        updated_at
      )
      VALUES
        (
          '00000000-0000-0000-0000-000000000010',
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000002',
          'fresh-delivery',
          '{"type":"github.issues.opened"}'::jsonb,
          'pending',
          now() - interval '1 minute',
          now() - interval '5 minutes',
          now() - interval '5 minutes'
        ),
        (
          '00000000-0000-0000-0000-000000000020',
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000002',
          'stale-delivery',
          '{"type":"github.issues.opened"}'::jsonb,
          'pending',
          now() - interval '1 minute',
          now() - interval '2 hours',
          now() - interval '2 hours'
        );
    `);
    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(
      drainIntegrationWatchDeliveries({
        limit: 10,
        maxDeliveryAgeSeconds: 60 * 60,
        deliveryOptions: {
          sandboxCreateTimeoutSeconds: 120,
          runScriptTimeoutMs: 15_000,
          asyncRunScript: true,
        },
      }),
    ).resolves.toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });

    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { type: "github.issues.opened" },
        options: {
          sandboxCreateTimeoutSeconds: 120,
          runScriptTimeoutMs: 15_000,
          asyncRunScript: true,
        },
      }),
    );

    const rows = await pg!.query<{ delivery_id: string; status: string }>(
      "SELECT delivery_id, status FROM integration_watch_deliveries ORDER BY delivery_id",
    );
    expect(rows.rows).toEqual([
      { delivery_id: "fresh-delivery", status: "delivered" },
      { delivery_id: "stale-delivery", status: "pending" },
    ]);
  });

  it("reclaims running rows and polls the persisted sandbox command", async () => {
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status,
        next_attempt_at,
        run_deployment_id,
        run_sandbox_id,
        run_session_id,
        run_command_id,
        run_started_at,
        run_sandbox_name,
        run_mount_configured,
        created_at,
        updated_at
      )
      VALUES (
        '00000000-0000-0000-0000-000000000030',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        'running-delivery',
        '{"type":"github.issues.opened"}'::jsonb,
        'running',
        now() - interval '1 minute',
        '00000000-0000-0000-0000-000000000099',
        'sbx-warm',
        'tick-00000000-0000-0000-0000-000000000099',
        'cmd-123',
        '2026-05-26T20:55:00.000Z',
        'cloud-small-issue-codex-abcd1234',
        true,
        now() - interval '5 minutes',
        now() - interval '1 minute'
      );
    `);
    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1 })).resolves.toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });

    expect(mocks.deliverDeploymentTrigger).not.toHaveBeenCalled();
    expect(mocks.pollDeploymentTriggerRun).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: "00000000-0000-0000-0000-000000000099",
      sandboxId: "sbx-warm",
      sessionId: "tick-00000000-0000-0000-0000-000000000099",
      commandId: "cmd-123",
      sandboxName: "cloud-small-issue-codex-abcd1234",
      mountConfigured: true,
    }));

    const rows = await pg!.query<{ delivery_id: string; status: string; run_command_id: string | null }>(
      "SELECT delivery_id, status, run_command_id FROM integration_watch_deliveries",
    );
    expect(rows.rows).toEqual([
      { delivery_id: "running-delivery", status: "delivered", run_command_id: null },
    ]);
  });

  it("marks handler-ok cleanup-only async runs delivered instead of retrying", async () => {
    mocks.pollDeploymentTriggerRun.mockRejectedValueOnce(new Error([
      '{"t":"2026-06-19T20:00:56.077Z","level":"info","message":"runner.handler.ok","eventId":"delivery","source":"slack","type":"slack.message.created","durationMs":1}',
      '{"t":"2026-06-19T20:00:56.078Z","level":"info","message":"runner.envelope-stream.ended","persona":"customer-health"}',
      '{"message":"relayfile.mount.cleanup","flushExitCode":1,"killAttempted":true,"killExitCode":0,"pendingWriteback":0,"hasPendingWriteback":false,"outboxNeedsAttention":false,"commandDraftWrittenThisRun":false,"commandDraftsUndeliverable":null}',
    ].join("\n")));
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status,
        next_attempt_at,
        run_deployment_id,
        run_sandbox_id,
        run_session_id,
        run_command_id,
        run_started_at,
        run_mount_configured,
        created_at,
        updated_at
      )
      VALUES (
        '00000000-0000-0000-0000-000000000040',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        'cleanup-only-delivery',
        '{"type":"slack.message.created"}'::jsonb,
        'running',
        now() - interval '1 minute',
        '00000000-0000-0000-0000-000000000099',
        'sbx-cleanup',
        'tick-00000000-0000-0000-0000-000000000099',
        'cmd-cleanup',
        '2026-06-19T20:00:00.000Z',
        true,
        now() - interval '5 minutes',
        now() - interval '1 minute'
      );
    `);
    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1 })).resolves.toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });

    const rows = await pg!.query<{
      status: string;
      attempt_count: number;
      run_command_id: string | null;
      last_error: string | null;
    }>("SELECT status, attempt_count, run_command_id, last_error FROM integration_watch_deliveries");
    expect(rows.rows).toEqual([{
      status: "delivered",
      attempt_count: 0,
      run_command_id: null,
      last_error: null,
    }]);
  });

  it("keeps retrying handler-ok cleanup failures with pending writeback", async () => {
    mocks.pollDeploymentTriggerRun.mockRejectedValueOnce(new Error([
      '{"t":"2026-06-19T20:00:56.077Z","level":"info","message":"runner.handler.ok","eventId":"delivery","source":"slack","type":"slack.message.created","durationMs":1}',
      '{"message":"relayfile.mount.cleanup","flushExitCode":1,"killAttempted":true,"killExitCode":0,"pendingWriteback":1,"hasPendingWriteback":true,"outboxNeedsAttention":false,"commandDraftWrittenThisRun":true,"commandDraftsUndeliverable":null}',
    ].join("\n")));
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status,
        next_attempt_at,
        run_deployment_id,
        run_sandbox_id,
        run_session_id,
        run_command_id,
        run_started_at,
        run_mount_configured,
        created_at,
        updated_at
      )
      VALUES (
        '00000000-0000-0000-0000-000000000050',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        'pending-writeback-delivery',
        '{"type":"slack.message.created"}'::jsonb,
        'running',
        now() - interval '1 minute',
        '00000000-0000-0000-0000-000000000099',
        'sbx-pending-writeback',
        'tick-00000000-0000-0000-0000-000000000099',
        'cmd-pending-writeback',
        '2026-06-19T20:00:00.000Z',
        true,
        now() - interval '5 minutes',
        now() - interval '1 minute'
      );
    `);
    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 1 })).resolves.toMatchObject({
      attempted: 1,
      delivered: 0,
      failed: 1,
      pending: 1,
      terminal: 0,
    });

    const rows = await pg!.query<{
      status: string;
      attempt_count: number;
      run_command_id: string | null;
      last_error: string | null;
    }>("SELECT status, attempt_count, run_command_id, last_error FROM integration_watch_deliveries");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      status: "pending",
      attempt_count: 1,
      run_command_id: null,
    });
    expect(rows.rows[0]!.last_error).toContain('"pendingWriteback":1');
  });

  it("does not convert cleanup-only failures that already have terminal writeback status", async () => {
    const cleanupOnlyError = new Error([
      '{"t":"2026-06-19T20:00:56.077Z","level":"info","message":"runner.handler.ok","eventId":"delivery","source":"slack","type":"slack.message.created","durationMs":1}',
      '{"message":"relayfile.mount.cleanup","flushExitCode":1,"killAttempted":true,"killExitCode":0,"pendingWriteback":0,"hasPendingWriteback":false,"outboxNeedsAttention":false,"commandDraftWrittenThisRun":false,"commandDraftsUndeliverable":0}',
    ].join("\n"));
    mocks.pollDeploymentTriggerRun
      .mockRejectedValueOnce(cleanupOnlyError)
      .mockRejectedValueOnce(cleanupOnlyError);
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        payload,
        status,
        next_attempt_at,
        run_deployment_id,
        run_sandbox_id,
        run_session_id,
        run_command_id,
        run_started_at,
        run_mount_configured,
        terminal_writeback_status,
        slack_terminal_reply_status,
        created_at,
        updated_at
      )
      VALUES
      (
        '00000000-0000-0000-0000-000000000051',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        'linear-terminal-status-delivery',
        '{"type":"slack.message.created"}'::jsonb,
        'running',
        now() - interval '1 minute',
        '00000000-0000-0000-0000-000000000099',
        'sbx-terminal-linear',
        'tick-00000000-0000-0000-0000-000000000099',
        'cmd-terminal-linear',
        '2026-06-19T20:00:00.000Z',
        true,
        'failed',
        null,
        now() - interval '5 minutes',
        now() - interval '1 minute'
      ),
      (
        '00000000-0000-0000-0000-000000000052',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        'slack-terminal-status-delivery',
        '{"type":"slack.message.created"}'::jsonb,
        'running',
        now() - interval '1 minute',
        '00000000-0000-0000-0000-000000000099',
        'sbx-terminal-slack',
        'tick-00000000-0000-0000-0000-000000000099',
        'cmd-terminal-slack',
        '2026-06-19T20:00:00.000Z',
        true,
        null,
        'failed',
        now() - interval '5 minutes',
        now() - interval '1 minute'
      );
    `);
    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 2 })).resolves.toMatchObject({
      attempted: 2,
      delivered: 0,
      failed: 2,
      pending: 2,
      terminal: 0,
    });

    const rows = await pg!.query<{
      delivery_id: string;
      status: string;
      attempt_count: number;
      last_error: string | null;
    }>(
      "SELECT delivery_id, status, attempt_count, last_error FROM integration_watch_deliveries ORDER BY delivery_id",
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        delivery_id: "linear-terminal-status-delivery",
        status: "pending",
        attempt_count: 1,
      }),
      expect.objectContaining({
        delivery_id: "slack-terminal-status-delivery",
        status: "pending",
        attempt_count: 1,
      }),
    ]);
    expect(rows.rows[0]!.last_error).toContain("relayfile.mount.cleanup");
    expect(rows.rows[1]!.last_error).toContain("relayfile.mount.cleanup");
  });
});

describe("coalesced issue-dispatch re-dispatch sweep (#1516 Bug 1 trailing edge)", () => {
  let pgb: PGlite | null = null;
  const WS = "00000000-0000-0000-0000-000000000001";
  const AGENT = "00000000-0000-0000-0000-000000000002";

  beforeEach(async () => {
    vi.clearAllMocks();
    pgb = new PGlite();
    await pgb.exec(`
      CREATE TABLE integration_watch_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        agent_id uuid NOT NULL,
        delivery_id text NOT NULL,
        trigger_key text,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        lease_until timestamptz,
        provisioning_sandbox_id text,
        run_deployment_id uuid,
        run_sandbox_id text,
        run_session_id text,
        run_command_id text,
        run_started_at timestamptz,
        run_sandbox_name text,
        run_mount_configured boolean,
        last_error text,
        delivered_at timestamptz,
        terminal_writeback_status text,
        slack_terminal_reply_status text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, agent_id, delivery_id)
      );
      CREATE TABLE integration_watch_issue_dispatch_dedup (
        id bigserial PRIMARY KEY,
        workspace_id uuid NOT NULL,
        issue_key text NOT NULL,
        agent_id uuid NOT NULL,
        delivery_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        pending_delivery_id text,
        pending_payload jsonb,
        UNIQUE (workspace_id, issue_key, agent_id)
      );
    `);
    setDbForTesting(drizzle(pgb) as never);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pgb?.close();
    pgb = null;
  });

  async function insertPendingDedup(updatedAtSql: string): Promise<void> {
    await pgb!.exec(`
      INSERT INTO integration_watch_issue_dispatch_dedup
        (workspace_id, issue_key, agent_id, delivery_id, updated_at, pending_delivery_id, pending_payload)
      VALUES (
        '${WS}', '/github/repos/o/r/pulls/9', '${AGENT}',
        'orig-delivery', ${updatedAtSql}, 'cubic-delivery',
        '{"type":"github.pull_request_review.submitted","resource":{"reviewer":"cubic"}}'::jsonb
      );
    `);
  }

  it("re-fires exactly one coalesced delivery once the cooldown window has expired and clears the pending marker", async () => {
    // window expired: updated_at older than the 180s default cooldown.
    await insertPendingDedup("now() - interval '200 seconds'");
    const { sweepCoalescedIssueDispatchRedispatches } =
      await import("./integration-watch-deliveries");

    const fired = await sweepCoalescedIssueDispatchRedispatches({});
    expect(fired).toBe(1);

    // exactly ONE delivery enqueued, carrying the LATEST within-window event's
    // delivery id + payload (the coalesced re-fire).
    const dels = await pgb!.query<{ delivery_id: string; payload: { type: string }; status: string }>(
      "SELECT delivery_id, payload, status FROM integration_watch_deliveries",
    );
    expect(dels.rows).toHaveLength(1);
    expect(dels.rows[0]!.delivery_id).toBe("cubic-delivery");
    expect(dels.rows[0]!.payload.type).toBe("github.pull_request_review.submitted");

    // pending marker cleared + window reset (so it fires once per window).
    const dedup = await pgb!.query<{ pending_delivery_id: string | null; pending_payload: unknown }>(
      "SELECT pending_delivery_id, pending_payload FROM integration_watch_issue_dispatch_dedup",
    );
    expect(dedup.rows[0]!.pending_delivery_id).toBeNull();
    expect(dedup.rows[0]!.pending_payload).toBeNull();
  });

  it("does NOT re-fire while the cooldown window is still active (no premature trailing edge)", async () => {
    await insertPendingDedup("now() - interval '10 seconds'");
    const { sweepCoalescedIssueDispatchRedispatches } =
      await import("./integration-watch-deliveries");

    const fired = await sweepCoalescedIssueDispatchRedispatches({});
    expect(fired).toBe(0);

    const dels = await pgb!.query("SELECT delivery_id FROM integration_watch_deliveries");
    expect(dels.rows).toHaveLength(0);
    // pending preserved for a later sweep once the window expires.
    const dedup = await pgb!.query<{ pending_delivery_id: string | null }>(
      "SELECT pending_delivery_id FROM integration_watch_issue_dispatch_dedup",
    );
    expect(dedup.rows[0]!.pending_delivery_id).toBe("cubic-delivery");
  });

  it("re-fires a coalesced recurring Linear issue update exactly once after the cooldown", async () => {
    await pgb!.exec(`
      INSERT INTO integration_watch_issue_dispatch_dedup
        (workspace_id, issue_key, agent_id, delivery_id, updated_at, pending_delivery_id, pending_payload)
      VALUES (
        '${WS}', 'linear:LIN-88', '${AGENT}',
        'linear-update-1', now() - interval '200 seconds', 'linear-update-2',
        '{"type":"linear.issue.updated","issue":{"identifier":"LIN-88","title":"latest title"}}'::jsonb
      );
    `);
    const { sweepCoalescedIssueDispatchRedispatches } =
      await import("./integration-watch-deliveries");

    expect(await sweepCoalescedIssueDispatchRedispatches({})).toBe(1);
    expect(await sweepCoalescedIssueDispatchRedispatches({})).toBe(0);

    const deliveries = await pgb!.query<{
      delivery_id: string;
      payload: { issue?: { title?: string } };
    }>("SELECT delivery_id, payload FROM integration_watch_deliveries");
    expect(deliveries.rows).toEqual([{
      delivery_id: "linear-update-2",
      payload: {
        type: "linear.issue.updated",
        issue: {
          identifier: "LIN-88",
          title: "latest title",
        },
      },
    }]);
  });

  it("is idempotent across ticks — a second sweep after the re-fire does nothing (fires once per window)", async () => {
    await insertPendingDedup("now() - interval '200 seconds'");
    const { sweepCoalescedIssueDispatchRedispatches } =
      await import("./integration-watch-deliveries");

    expect(await sweepCoalescedIssueDispatchRedispatches({})).toBe(1);
    // second tick: marker was cleared + window reset → nothing to re-fire.
    expect(await sweepCoalescedIssueDispatchRedispatches({})).toBe(0);
    const dels = await pgb!.query("SELECT delivery_id FROM integration_watch_deliveries");
    expect(dels.rows).toHaveLength(1);
  });
});

describe("integration watch delivery maxConcurrency", () => {
  const WS = "00000000-0000-0000-0000-000000000001";
  const CAPPED_AGENT = "00000000-0000-0000-0000-000000000002";
  const OTHER_AGENT = "00000000-0000-0000-0000-000000000003";
  const CAP2_AGENT = "00000000-0000-0000-0000-000000000004";
  const PER_TRIGGER_AGENT = "00000000-0000-0000-0000-000000000005";
  const SCALAR_CAP_MAP_AGENT = "00000000-0000-0000-0000-000000000006";
  const JSON_NULL_CAP_MAP_AGENT = "00000000-0000-0000-0000-000000000007";
  const ARRAY_CAP_MAP_AGENT = "00000000-0000-0000-0000-000000000008";

  beforeEach(async () => {
    vi.clearAllMocks();
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE agents (
        id uuid PRIMARY KEY,
        delivery_max_concurrency integer,
        delivery_max_concurrency_by_trigger jsonb
      );

      CREATE TABLE integration_watch_deliveries (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL,
        agent_id uuid NOT NULL,
        delivery_id text NOT NULL,
        trigger_key text,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        lease_until timestamptz,
        provisioning_sandbox_id text,
        run_deployment_id uuid,
        run_sandbox_id text,
        run_session_id text,
        run_command_id text,
        run_started_at timestamptz,
        run_sandbox_name text,
        run_mount_configured boolean,
        last_error text,
        delivered_at timestamptz,
        terminal_writeback_status text,
        slack_terminal_reply_status text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      INSERT INTO agents (id, delivery_max_concurrency, delivery_max_concurrency_by_trigger)
      VALUES
        ('${CAPPED_AGENT}', 1, NULL),
        ('${OTHER_AGENT}', NULL, NULL),
        ('${CAP2_AGENT}', 2, NULL),
        ('${PER_TRIGGER_AGENT}', 1, '{"provider:slack:trigger:0":1}'::jsonb),
        ('${SCALAR_CAP_MAP_AGENT}', NULL, '"malformed"'::jsonb),
        ('${JSON_NULL_CAP_MAP_AGENT}', NULL, 'null'::jsonb),
        ('${ARRAY_CAP_MAP_AGENT}', NULL, '["provider:linear:trigger:0"]'::jsonb);
    `);
    setDbForTesting(drizzle(pg) as never);
    mocks.deliverDeploymentTrigger.mockResolvedValue({
      agentId: CAPPED_AGENT,
      workspaceId: WS,
      deploymentId: "deployment-1",
      status: "starting",
    });
    mocks.pollDeploymentTriggerRun.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  async function insertDelivery(input: {
    id: string;
    agentId: string;
    deliveryId: string;
    status?: string;
    triggerKey?: string | null;
    nextAttempt?: string;
    leaseUntil?: string | null;
    createdOffsetMinutes?: number;
    run?: boolean;
  }): Promise<void> {
    await pg!.exec(`
      INSERT INTO integration_watch_deliveries (
        id,
        workspace_id,
        agent_id,
        delivery_id,
        trigger_key,
        payload,
        status,
        next_attempt_at,
        lease_until,
        run_deployment_id,
        run_sandbox_id,
        run_session_id,
        run_command_id,
        run_started_at,
        created_at,
        updated_at
      )
      VALUES (
        '${input.id}',
        '${WS}',
        '${input.agentId}',
        '${input.deliveryId}',
        ${input.triggerKey === undefined || input.triggerKey === null ? "NULL" : `'${input.triggerKey}'`},
        '{"type":"slack.message.created"}'::jsonb,
        '${input.status ?? "pending"}',
        ${input.nextAttempt ?? "now() - interval '1 minute'"},
        ${input.leaseUntil === undefined ? "NULL" : input.leaseUntil},
        ${input.run ? "'00000000-0000-0000-0000-000000000099'" : "NULL"},
        ${input.run ? "'sbx-running'" : "NULL"},
        ${input.run ? "'sess-running'" : "NULL"},
        ${input.run ? "'cmd-running'" : "NULL"},
        ${input.run ? "'2026-05-26T20:55:00.000Z'" : "NULL"},
        now() - interval '${input.createdOffsetMinutes ?? 5} minutes',
        now() - interval '${input.createdOffsetMinutes ?? 5} minutes'
      );
    `);
  }

  it("claims only one pending row for a capped agent while still filling the sweep from another agent", async () => {
    for (let index = 0; index < 4; index += 1) {
      await insertDelivery({
        id: `00000000-0000-0000-0000-00000000010${index}`,
        agentId: CAPPED_AGENT,
        deliveryId: `capped-${index}`,
        createdOffsetMinutes: 10 - index,
      });
    }
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000200",
      agentId: OTHER_AGENT,
      deliveryId: "other-0",
      createdOffsetMinutes: 1,
    });

    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 5 })).resolves.toMatchObject({
      attempted: 2,
      delivered: 2,
      failed: 0,
    });

    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledTimes(2);
    expect(mocks.deliverDeploymentTrigger.mock.calls.map(([input]) => input.deliveryId).sort()).toEqual([
      "capped-0",
      "other-0",
    ]);
  });

  it("does not claim new pending rows for an agent with a non-due running delivery at its cap", async () => {
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000300",
      agentId: CAPPED_AGENT,
      deliveryId: "running-not-due",
      status: "running",
      nextAttempt: "now() + interval '10 minutes'",
      run: true,
    });
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000301",
      agentId: CAPPED_AGENT,
      deliveryId: "blocked-pending",
    });
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000302",
      agentId: OTHER_AGENT,
      deliveryId: "other-available",
    });

    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 5 })).resolves.toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.deliverDeploymentTrigger.mock.calls[0]?.[0].deliveryId).toBe("other-available");
  });

  it("always admits due running rows for polling without releasing another pending row", async () => {
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000400",
      agentId: CAPPED_AGENT,
      deliveryId: "running-due",
      status: "running",
      nextAttempt: "now() - interval '1 minute'",
      run: true,
    });
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000401",
      agentId: CAPPED_AGENT,
      deliveryId: "still-blocked",
    });

    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 5 })).resolves.toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(mocks.pollDeploymentTriggerRun).toHaveBeenCalledTimes(1);
    expect(mocks.pollDeploymentTriggerRun.mock.calls[0]?.[0]).toMatchObject({
      deliveryId: "running-due",
      commandId: "cmd-running",
    });
    expect(mocks.deliverDeploymentTrigger).not.toHaveBeenCalled();
  });

  it("reclaims a stale processing lease instead of counting it against the cap", async () => {
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000500",
      agentId: CAPPED_AGENT,
      deliveryId: "stale-processing",
      status: "processing",
      leaseUntil: "now() - interval '1 minute'",
    });

    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 5 })).resolves.toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(mocks.deliverDeploymentTrigger.mock.calls[0]?.[0].deliveryId).toBe("stale-processing");
  });

  it("keeps null-cap agents on the existing global sweep behavior", async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertDelivery({
        id: `00000000-0000-0000-0000-00000000060${index}`,
        agentId: OTHER_AGENT,
        deliveryId: `uncapped-${index}`,
        createdOffsetMinutes: 10 - index,
      });
    }

    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 3 })).resolves.toMatchObject({
      attempted: 3,
      delivered: 3,
      failed: 0,
    });
    expect(mocks.deliverDeploymentTrigger.mock.calls.map(([input]) => input.deliveryId)).toEqual([
      "uncapped-0",
      "uncapped-1",
      "uncapped-2",
    ]);
  });

  // The motivating Issue #2 scenario, end-to-end: a backlog that resumes must be
  // delivered ONE AT A TIME for a cap=1 agent — a running delivery blocks the
  // next, and only once it reaches a terminal state is the next pending released.
  // Single-sweep tests prove each half; this proves the full serial cycle holds
  // across sequential sweeps so a 3-message burst can never be 2+ concurrent.
  it("serializes a resumed backlog across sweeps: running blocks, terminal completion releases the next", async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertDelivery({
        id: `00000000-0000-0000-0000-00000000070${index}`,
        agentId: CAPPED_AGENT,
        deliveryId: `burst-${index}`,
        createdOffsetMinutes: 10 - index,
      });
    }

    const deploymentTriggerDelivery = await import(
      "./deployment-trigger-delivery"
    );
    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    // Sweep 1: the oldest backlog row dispatches an async run and transitions to
    // 'running' (non-due, next_attempt pushed ~15s out). Exactly one is claimed.
    const runPending = new deploymentTriggerDelivery.DeploymentTriggerRunPendingError({
      deploymentId: "00000000-0000-0000-0000-000000000099",
      sandboxId: "sbx-burst",
      sessionId: "sess-burst",
      commandId: "cmd-burst",
      startedAt: "2026-05-26T20:55:00.000Z",
    });
    mocks.deliverDeploymentTrigger.mockRejectedValueOnce(runPending);

    const sweep1 = await drainIntegrationWatchDeliveries({ limit: 5 });
    expect(sweep1).toMatchObject({ attempted: 1, delivered: 0, pending: 1 });
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.deliverDeploymentTrigger.mock.calls[0]?.[0].deliveryId).toBe("burst-0");

    // Sweep 2: burst-0 is a non-due running row and holds the only slot. No new
    // pending may be claimed — the backlog stays serialized behind the in-flight run.
    const sweep2 = await drainIntegrationWatchDeliveries({ limit: 5 });
    expect(sweep2.attempted).toBe(0);
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.pollDeploymentTriggerRun).not.toHaveBeenCalled();

    // The run becomes due; its poll resolves → burst-0 reaches a terminal
    // delivered state this sweep. Because the due-running row occupies the rank-1
    // slot, NO pending row is released in the same sweep.
    await pg!.exec(
      `UPDATE integration_watch_deliveries SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = 'burst-0'`,
    );
    const sweep3 = await drainIntegrationWatchDeliveries({ limit: 5 });
    expect(sweep3).toMatchObject({ attempted: 1, delivered: 1 });
    expect(mocks.pollDeploymentTriggerRun).toHaveBeenCalledTimes(1);
    expect(mocks.pollDeploymentTriggerRun.mock.calls[0]?.[0].deliveryId).toBe("burst-0");
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledTimes(1);

    // Sweep 4: no in-flight remains → the next backlog row is finally released,
    // still strictly one at a time. burst-2 must remain pending afterwards.
    const sweep4 = await drainIntegrationWatchDeliveries({ limit: 5 });
    expect(sweep4).toMatchObject({ attempted: 1, delivered: 1 });
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledTimes(2);
    expect(mocks.deliverDeploymentTrigger.mock.calls[1]?.[0].deliveryId).toBe("burst-1");

    const rows = await pg!.query<{ delivery_id: string; status: string }>(
      "SELECT delivery_id, status FROM integration_watch_deliveries ORDER BY delivery_id",
    );
    expect(rows.rows).toEqual([
      { delivery_id: "burst-0", status: "delivered" },
      { delivery_id: "burst-1", status: "delivered" },
      { delivery_id: "burst-2", status: "pending" },
    ]);
  });

  // cap=1 coincides with several edge behaviors (the running row alone exhausts
  // the budget). cap=2 proves the budget arithmetic itself: exactly two release
  // in one sweep, the third waits — independent of the cap=1 special case.
  it("releases exactly maxConcurrency rows in a single sweep for a cap=2 agent", async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertDelivery({
        id: `00000000-0000-0000-0000-00000000080${index}`,
        agentId: CAP2_AGENT,
        deliveryId: `cap2-${index}`,
        createdOffsetMinutes: 10 - index,
      });
    }

    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 5 })).resolves.toMatchObject({
      attempted: 2,
      delivered: 2,
      failed: 0,
    });
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledTimes(2);
    expect(
      mocks.deliverDeploymentTrigger.mock.calls.map(([input]) => input.deliveryId).sort(),
    ).toEqual(["cap2-0", "cap2-1"]);

    const remaining = await pg!.query<{ delivery_id: string; status: string }>(
      "SELECT delivery_id, status FROM integration_watch_deliveries WHERE status = 'pending' ORDER BY delivery_id",
    );
    expect(remaining.rows).toEqual([{ delivery_id: "cap2-2", status: "pending" }]);
  });

  it("scopes keyed caps per trigger so a capped trigger does not serialize an uncapped trigger on the same agent", async () => {
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000900",
      agentId: PER_TRIGGER_AGENT,
      deliveryId: "slack-running",
      triggerKey: "provider:slack:trigger:0",
      status: "running",
      nextAttempt: "now() + interval '10 minutes'",
      run: true,
    });
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000901",
      agentId: PER_TRIGGER_AGENT,
      deliveryId: "slack-blocked",
      triggerKey: "provider:slack:trigger:0",
    });
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000902",
      agentId: PER_TRIGGER_AGENT,
      deliveryId: "github-uncapped",
      triggerKey: "provider:github:trigger:0",
    });

    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 5 })).resolves.toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.deliverDeploymentTrigger.mock.calls[0]?.[0].deliveryId).toBe("github-uncapped");

    const remaining = await pg!.query<{ delivery_id: string; status: string }>(
      "SELECT delivery_id, status FROM integration_watch_deliveries WHERE delivery_id IN ('slack-blocked', 'github-uncapped') ORDER BY delivery_id",
    );
    expect(remaining.rows).toEqual([
      { delivery_id: "github-uncapped", status: "delivered" },
      { delivery_id: "slack-blocked", status: "pending" },
    ]);
  });

  it("treats malformed trigger cap maps as uncapped instead of crashing the drain", async () => {
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000910",
      agentId: SCALAR_CAP_MAP_AGENT,
      deliveryId: "scalar-cap-map",
      triggerKey: "provider:slack:trigger:0",
    });
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000911",
      agentId: JSON_NULL_CAP_MAP_AGENT,
      deliveryId: "json-null-cap-map",
      triggerKey: "provider:github:trigger:0",
    });
    await insertDelivery({
      id: "00000000-0000-0000-0000-000000000912",
      agentId: ARRAY_CAP_MAP_AGENT,
      deliveryId: "array-cap-map",
      triggerKey: "provider:linear:trigger:0",
    });

    const { drainIntegrationWatchDeliveries } =
      await import("./integration-watch-deliveries");

    await expect(drainIntegrationWatchDeliveries({ limit: 5 })).resolves.toMatchObject({
      attempted: 3,
      delivered: 3,
      failed: 0,
    });
    expect(
      mocks.deliverDeploymentTrigger.mock.calls.map(([input]) => input.deliveryId).sort(),
    ).toEqual(["array-cap-map", "json-null-cap-map", "scalar-cap-map"]);
  });
});
