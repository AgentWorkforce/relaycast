import {
  handleCfQueue,
  TurnExecutorDO,
  wrapCloudflareWorker,
} from "@agent-assistant/cloudflare-runtime";
import sageApp, {
  parseSlackWebhook,
  runSageTurn,
} from "@agentworkforce/sage";
import type { SageBindings } from "@agentworkforce/sage";
import type {
  DurableObjectNamespace,
  ExecutionContext,
  Queue,
} from "@cloudflare/workers-types";

type Env = SageBindings & {
  TURN_QUEUE: Queue;
  DEAD_LETTER_QUEUE?: Queue;
  TURN_EXECUTOR_DO: DurableObjectNamespace;
};

type QueueHandlerArgs = Parameters<typeof handleCfQueue<Env>>;
type SageTurnDescriptor = Parameters<typeof runSageTurn>[0];

const sageWorker = wrapCloudflareWorker<Env>({
  webhookRoutes: {
    "/api/webhooks/slack": {
      provider: "slack",
      verify: async () => ({ ok: true }),
      parse: async (req, env) => {
        const result = await parseSlackWebhook(req as Request, env);
        const turn = result.kind === "dispatch" ? result.turn : undefined;

        return {
          kind: result.kind,
          response: result.response,
          turn,
          dedupKey: turn?.slackEvent
            ? {
                eventId: turn.slackEvent.eventId,
                ts: turn.slackEvent.ts,
              }
            : undefined,
        };
      },
    },
  },
  // Anything that isn't /api/webhooks/slack falls through to the existing
  // sage Hono app — /health, admin routes, GitHub/Linear webhooks, etc.
  // The bundle probe (scripts/check-sage-worker-bundle.mjs) hits /health
  // and expects 200 { status: "ok" }; without this, every non-Slack
  // request 404s.
  inner: {
    fetch: (req, env, ctx) =>
      sageApp.fetch(req as unknown as Request, env, ctx as ExecutionContext),
  },
  queueBinding: "TURN_QUEUE",
  dedupBinding: "DEDUP",
  turnExecutorDoBinding: "TURN_EXECUTOR_DO",
});

export default {
  fetch: sageWorker.fetch!,
  queue: (
    batch: QueueHandlerArgs[0],
    env: QueueHandlerArgs[1],
    ctx: QueueHandlerArgs[2],
  ) =>
    handleCfQueue(batch, env, ctx, {
      runTurn: async (message, env, ctx) => {
        if (message.type !== "webhook") {
          return;
        }

        await runSageTurn(message.descriptor as SageTurnDescriptor, env, ctx);
      },
    }),
};

export { TurnExecutorDO };
