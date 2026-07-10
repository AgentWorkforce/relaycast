import { app } from "./app.js";
import cleanupWorker from "./cleanup-cron.js";
import queueConsumer from "./queue-consumer.js";
import { createRouterBackpressureFetch } from "./workspace-do-backpressure.js";

// Durable Object exports
export { WorkspaceDO } from "./api-worker.js";

export { app };

const fetch = createRouterBackpressureFetch(app.fetch);

export default {
  fetch,
  queue: queueConsumer.queue,
  scheduled: cleanupWorker.scheduled,
};
