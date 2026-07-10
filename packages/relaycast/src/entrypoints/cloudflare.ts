//   bundled @relaycast/engine: 5.0.5
//   ^ version marker: SST hashes handler source (not node_modules), so bump this
//     comment whenever the engine version changes to force a re-bundle.
import { drizzle } from 'drizzle-orm/d1';
import { createEngine, hashToken, runA2aHealthChecks, schema } from '@relaycast/engine';
import { createCloudflareEngineDeps } from '../adapters/cloudflare/index.js';
import { handleFleetGatewayRequest } from '../fleet/routes.js';
import { createCloudflareTelemetry, flushCloudflareTelemetry } from '../providers/telemetry.js';
import { deliverQueueMessage, engineOutbox, runOutboxSweep, type OutboxQueueMessage } from '../lib/outbox.js';
import { sweepFleetInvocations } from '../durable-objects/node.js';
import type { CloudflareBindings } from '../env.js';

// Durable Object classes — re-exported so SST/wrangler can bind them. They live
// in this repo (Cloudflare-specific) and back the engine's realtime ports.
export { ChannelDO } from '../durable-objects/channel.js';
export { AgentDO } from '../durable-objects/agent.js';
export { PresenceDO } from '../durable-objects/presence.js';
export { WorkspaceStreamDO } from '../durable-objects/workspaceStream.js';
export { RateLimitDO } from '../durable-objects/rateLimit.js';
export { NodeDO } from '../durable-objects/node.js';

function dbFor(env: CloudflareBindings) {
  return drizzle(env.DB, { schema });
}

// Queue consumer for webhook delivery (engine owns the delivery + settle
// logic; lib/outbox.ts documents the settle / CF-retry interaction).
async function handleQueue(batch: MessageBatch, env: CloudflareBindings): Promise<void> {
  const db = dbFor(env);
  const telemetry = createCloudflareTelemetry(env);
  try {
    for (const msg of batch.messages) {
      const event = msg.body as OutboxQueueMessage;
      try {
        await deliverQueueMessage(db, event, engineOutbox, {
          onSettleError: (err) =>
            telemetry.captureException(err, { source: 'cloudflare.queue.outbox_settle', event_type: event.type }),
        });
        msg.ack();
      } catch (err) {
        telemetry.captureException(err, { source: 'cloudflare.queue', event_type: event.type });
        msg.retry();
      }
    }
  } finally {
    // The runtime keeps the isolate alive for this returned promise, so awaiting
    // the flush here drains any buffered captureException events before exit.
    await flushCloudflareTelemetry();
  }
}

// Scheduled work: A2A health sweep (engine owns the sweep logic), plus the
// webhook outbox sweep — re-enqueue `pending_events` rows whose queue send was
// lost and prune settled ones.
async function handleScheduled(
  _controller: ScheduledController,
  env: CloudflareBindings,
  ctx: ExecutionContext,
): Promise<void> {
  const db = dbFor(env);
  ctx.waitUntil(
    runA2aHealthChecks(db)
      .catch((err) =>
        createCloudflareTelemetry(env).captureException(err, { source: 'cloudflare.scheduled.a2a_health' }),
      )
      .finally(() => flushCloudflareTelemetry()),
  );
  ctx.waitUntil(
    runOutboxSweep(db, env.WEBHOOK_QUEUE, engineOutbox)
      .catch((err) =>
        createCloudflareTelemetry(env).captureException(err, { source: 'cloudflare.scheduled.outbox_sweep' }),
      )
      .finally(() => flushCloudflareTelemetry()),
  );
  // Fleet dispatch sweeper: re-dispatch invocations whose retry_after_at has
  // elapsed and re-dispatch dispatched-but-silent invocations past the dispatch
  // timeout. Mirrors relaycast#192 sweepTimedOutInvocations.
  ctx.waitUntil(
    sweepFleetInvocations(env)
      .catch((err) =>
        createCloudflareTelemetry(env).captureException(err, { source: 'cloudflare.scheduled.fleet_invocation_sweep' }),
      )
      .finally(() => flushCloudflareTelemetry()),
  );
}

// Build the engine app + adapters once per isolate (env is stable for the
// isolate's lifetime), not per request — rebuilding the route tree and adapter
// objects on every request would be a needless hot-path cost.
let cachedApp: ReturnType<typeof createEngine> | undefined;
let cachedEnv: CloudflareBindings | undefined;

function appFor(env: CloudflareBindings) {
  if (!cachedApp || cachedEnv !== env) {
    cachedEnv = env;
    cachedApp = createEngine(createCloudflareEngineDeps(env));
  }
  return cachedApp;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? request.headers.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
}

async function repairDmInboxParticipantsForRequest(request: Request, env: CloudflareBindings): Promise<void> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/v1/inbox') {
    return;
  }

  const token = bearerToken(request);
  if (!token?.startsWith('at_live_')) {
    return;
  }

  const tokenHash = await hashToken(token);
  const agent = await env.DB
    .prepare(`
      SELECT id, workspace_id, name
      FROM agents
      WHERE token_hash = ?
      LIMIT 1
    `)
    .bind(tokenHash)
    .first<{ id: string; workspace_id: string; name: string }>();
  if (!agent) {
    return;
  }

  const orphaned = await env.DB
    .prepare(`
      SELECT DISTINCT dc.id AS conversation_id
      FROM deliveries d
      JOIN messages m
        ON m.id = d.message_id
      JOIN dm_conversations dc
        ON dc.channel_id = m.channel_id
       AND dc.workspace_id = d.workspace_id
      LEFT JOIN dm_participants dp
        ON dp.conversation_id = dc.id
       AND dp.agent_id = d.agent_id
       AND dp.left_at IS NULL
      WHERE d.workspace_id = ?
        AND d.agent_id = ?
        AND d.status NOT IN ('acked', 'dead_lettered')
        AND m.agent_id != d.agent_id
        AND dp.agent_id IS NULL
      LIMIT 50
    `)
    .bind(agent.workspace_id, agent.id)
    .all<{ conversation_id: string }>();

  const conversationIds = [...new Set(
    (orphaned.results ?? [])
      .map((row) => row.conversation_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];
  if (conversationIds.length === 0) {
    return;
  }

  await env.DB.batch(
    conversationIds.map((conversationId) =>
      env.DB
        .prepare(`
          INSERT INTO dm_participants (conversation_id, agent_id)
          VALUES (?, ?)
          ON CONFLICT(conversation_id, agent_id) DO UPDATE SET left_at = NULL
        `)
        .bind(conversationId, agent.id),
    ),
  );

  createCloudflareTelemetry(env).capture({
    name: 'relaycast_dm_inbox_participant_repaired',
    distinctId: agent.workspace_id,
    properties: {
      workspace_id: agent.workspace_id,
      agent_id: agent.id,
      agent_name: agent.name,
      repaired_conversations: conversationIds.length,
      route: '/v1/inbox',
    },
  });
}

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext): Promise<Response> {
    const fleetResponse = await handleFleetGatewayRequest(request, env);
    const response = fleetResponse ?? (async () => {
      await repairDmInboxParticipantsForRequest(request, env).catch((err) => {
        createCloudflareTelemetry(env).captureException(err, {
          source: 'cloudflare.fetch.dm_inbox_participant_repair',
          route: '/v1/inbox',
        });
      });
      return appFor(env).fetch(request, env as never, ctx);
    })();
    // The engine emits product telemetry synchronously while handling the
    // request (emitServerEvent → buffered posthog-node client). Flush once the
    // response settles so the buffer is POSTed before the isolate suspends —
    // otherwise low-volume events are dropped on isolate eviction. Flush in a
    // `finally` so a rejected response still drains its buffered exception
    // telemetry; the `catch` keeps the flush chain (handed to waitUntil) from
    // becoming an unhandled rejection. The original `response` is still
    // returned to the runtime, which surfaces the rejection as a 5xx.
    ctx.waitUntil(
      Promise.resolve(response)
        .catch(() => {})
        .finally(() => flushCloudflareTelemetry()),
    );
    return response;
  },
  queue: handleQueue,
  scheduled: handleScheduled,
};
