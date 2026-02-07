export const SERVER_VERSION = '0.1.0' as const;

export { app } from './app.js';
export { generateId, getSnowflakeGenerator, SnowflakeGenerator } from './engine/snowflake.js';
export { getDb, closeDb, healthCheck as dbHealthCheck } from './db/index.js';
export { getRedis, closeRedis, redisHealthCheck } from './redis/index.js';
export { hashToken } from './middleware/auth.js';
export type { AuthenticatedRequest } from './middleware/auth.js';

// Start server when run directly
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('/index.ts') ||
    process.argv[1].endsWith('/index.js'));

if (isDirectRun) {
  const { app: serverApp } = await import('./app.js');
  const port = process.env.PORT || 3001;
  serverApp.listen(port, () => {
    console.log(`Relay server listening on port ${port}`);
  });
}
