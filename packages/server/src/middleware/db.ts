import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import { getDb } from '../db/index.js';

export const dbMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set('db', getDb(c.env.DB));
  await next();
});
