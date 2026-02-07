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

  httpServer.listen(port, () => {
    console.log(`Relay server listening on port ${port} (HTTP + WebSocket)`);
  });
}
