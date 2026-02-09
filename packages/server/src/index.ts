export const SERVER_VERSION = '0.1.0' as const;

export { app } from './app.js';
export { generateId, getSnowflakeGenerator, SnowflakeGenerator } from './engine/snowflake.js';
export { getDb, closeDb, healthCheck as dbHealthCheck } from './db/index.js';
export { getRedis, closeRedis, redisHealthCheck } from './redis/index.js';
export { hashToken } from './middleware/auth.js';
export type { AuthenticatedRequest } from './middleware/auth.js';
export { startWsServer } from './ws/server.js';
export { publishEvent } from './ws/pubsub.js';
export type { WsEvent, EventType } from './ws/pubsub.js';
export { enqueueEvent, startEventQueuePoller, stopEventQueuePoller, cleanupOldEvents } from './engine/eventQueue.js';
export { sweepStaleAgents } from './engine/agent.js';

// Start server when run directly
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('/index.ts') ||
    process.argv[1].endsWith('/index.js'));

if (isDirectRun) {
  const { app: serverApp } = await import('./app.js');
  const { getDb } = await import('./db/index.js');
  const { runMigrations } = await import('./db/migrate.js');
  const { startWsServer: startWs } = await import('./ws/server.js');
  const { setupPubSubListener } = await import('./ws/pubsub.js');
  const { connectRedisSub } = await import('./redis/index.js');
  const { createServer } = await import('node:http');

  // Initialize DB and run migrations before accepting connections
  console.log('Running database migrations...');
  getDb();
  await runMigrations();

  const port = process.env.PORT || 3001;
  const httpServer = createServer(serverApp);

  // Start WebSocket server
  startWs(httpServer);

  // Connect Redis subscriber and set up pub/sub fanout
  await connectRedisSub();
  setupPubSubListener();

  // Start durable event queue poller for webhook delivery
  const { startEventQueuePoller: startPoller, cleanupOldEvents: cleanupEvents } = await import('./engine/eventQueue.js');
  startPoller(2000);
  // Cleanup completed/failed events hourly
  setInterval(() => cleanupEvents().catch(() => {}), 60 * 60 * 1000);

  // Sweep stale agents every 60 seconds
  const { sweepStaleAgents } = await import('./engine/agent.js');
  setInterval(() => sweepStaleAgents().catch(() => {}), 60 * 1000);

  httpServer.listen(port, () => {
    console.log(`Relay server listening on port ${port} (HTTP + WebSocket)`);
  });
}
