#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const DEFAULT_PR_REVIEWER_AGENT_ID = "3750177c-7572-47b7-bf5a-3c634e60a1ba";

const DEFAULTS = {
  agentId: DEFAULT_PR_REVIEWER_AGENT_ID,
  agentName: "pr-reviewer",
  windowMinutes: 30,
  minRuns: 3,
  maxFailureRate: 0,
  unhealthySampleLimit: 5,
};

function readNumber(value, name, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function readInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = readNumber(value, name, { min, max });
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    ...DEFAULTS,
    databaseUrl: env.DATABASE_URL || env.NEON_APP_DATABASE_URL || "",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent-id") {
      options.agentId = argv[++i] ?? "";
    } else if (arg === "--agent-name") {
      options.agentName = argv[++i] ?? "";
    } else if (arg === "--window-minutes") {
      options.windowMinutes = readInteger(argv[++i], "--window-minutes", { min: 1 });
    } else if (arg === "--min-runs") {
      options.minRuns = readInteger(argv[++i], "--min-runs", { min: 1 });
    } else if (arg === "--max-failure-rate") {
      options.maxFailureRate = readNumber(argv[++i], "--max-failure-rate", { min: 0, max: 1 });
    } else if (arg === "--unhealthy-sample-limit") {
      options.unhealthySampleLimit = readInteger(argv[++i], "--unhealthy-sample-limit", {
        min: 1,
        max: 50,
      });
    } else if (arg === "--database-url") {
      options.databaseUrl = argv[++i] ?? "";
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.agentId) {
    throw new Error("--agent-id is required");
  }
  if (!options.agentName) {
    throw new Error("--agent-name is required");
  }
  return options;
}

export function buildAgentDeploymentRunHealthQuery(options) {
  return {
    text: `
      WITH recent AS (
        SELECT
          created_at,
          status,
          sandbox_id,
          cleanup_status,
          error,
          (
            status <> 'succeeded'
            OR sandbox_id IS NULL
            OR COALESCE(cleanup_status->>'scriptCompleted', 'false') <> 'true'
          ) AS unhealthy
        FROM agent_deployment_runs
        WHERE agent_id = $1::uuid
          AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')
      )
      SELECT
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_runs,
        COUNT(*) FILTER (WHERE unhealthy)::int AS unhealthy_runs,
        COUNT(*) FILTER (WHERE NOT unhealthy)::int AS healthy_runs,
        MAX(created_at) AS latest_run_at,
        COALESCE(
          json_agg(
            json_build_object(
              'createdAt', created_at,
              'status', status,
              'sandboxId', sandbox_id,
              'error', left(COALESCE(error, ''), 180)
            )
            ORDER BY created_at DESC
          ) FILTER (WHERE unhealthy),
          '[]'::json
        ) AS recent_unhealthy
      FROM recent
    `,
    values: [options.agentId, options.windowMinutes],
  };
}

function toCount(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

export function normalizeHealthRow(row) {
  const totalRuns = toCount(row?.total_runs);
  const unhealthyRuns = toCount(row?.unhealthy_runs);
  const healthyRuns = toCount(row?.healthy_runs);
  const succeededRuns = toCount(row?.succeeded_runs);
  return {
    totalRuns,
    succeededRuns,
    healthyRuns,
    unhealthyRuns,
    failureRate: totalRuns === 0 ? 0 : unhealthyRuns / totalRuns,
    latestRunAt: row?.latest_run_at ?? null,
    recentUnhealthy: Array.isArray(row?.recent_unhealthy) ? row.recent_unhealthy : [],
  };
}

export function classifyAgentDeploymentRunHealth(row, options) {
  const health = normalizeHealthRow(row);
  if (health.totalRuns < options.minRuns) {
    return {
      status: "skip",
      health,
      message: `${options.agentName}: only ${health.totalRuns} run(s) in the last ${options.windowMinutes} minute(s); minRuns=${options.minRuns}`,
    };
  }
  if (health.failureRate > options.maxFailureRate) {
    return {
      status: "fail",
      health,
      message: `${options.agentName}: unhealthy rate ${(health.failureRate * 100).toFixed(1)}% exceeds ${(options.maxFailureRate * 100).toFixed(1)}% (${health.unhealthyRuns}/${health.totalRuns})`,
    };
  }
  return {
    status: "pass",
    health,
    message: `${options.agentName}: unhealthy rate ${(health.failureRate * 100).toFixed(1)}% (${health.unhealthyRuns}/${health.totalRuns})`,
  };
}

function printHelp() {
  console.log(`Usage: node scripts/check-agent-deployment-run-health.mjs [options]

Checks agent_deployment_runs for unhealthy proactive agent executions.
Unhealthy means status != succeeded, sandbox_id is null, or cleanup_status.scriptCompleted is not true.

Options:
  --agent-id <uuid>                 Agent id to check (default: pr-reviewer prod id)
  --agent-name <name>               Name used in output (default: pr-reviewer)
  --window-minutes <n>              Lookback window (default: 30)
  --min-runs <n>                    Skip alert below this sample size (default: 3)
  --max-failure-rate <0..1>         Allowed unhealthy rate (default: 0)
  --unhealthy-sample-limit <n>      Number of recent unhealthy rows to print (default: 5)
  --database-url <postgres-url>     Overrides DATABASE_URL / NEON_APP_DATABASE_URL
`);
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL or NEON_APP_DATABASE_URL is required");
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const query = buildAgentDeploymentRunHealthQuery(options);
    const result = await client.query(query.text, query.values);
    const classification = classifyAgentDeploymentRunHealth(result.rows[0], options);
    const { health } = classification;

    console.log(classification.message);
    console.log(
      JSON.stringify(
        {
          agentId: options.agentId,
          agentName: options.agentName,
          windowMinutes: options.windowMinutes,
          totalRuns: health.totalRuns,
          succeededRuns: health.succeededRuns,
          healthyRuns: health.healthyRuns,
          unhealthyRuns: health.unhealthyRuns,
          failureRate: health.failureRate,
          latestRunAt: health.latestRunAt,
        },
        null,
        2,
      ),
    );

    for (const row of health.recentUnhealthy.slice(0, options.unhealthySampleLimit)) {
      console.log(
        `unhealthy ${row.createdAt} status=${row.status} sandbox=${row.sandboxId ?? "null"} error=${row.error}`,
      );
    }

    if (classification.status === "fail") {
      console.error(`::error::${classification.message}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`agent-deployment-run-health: fatal: ${error.message}`);
    process.exit(1);
  });
}
