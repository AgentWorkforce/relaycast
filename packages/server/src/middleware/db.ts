import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import { getDb } from '../db/index.js';
import { ensureSchemaCompat } from '../db/ensureSchemaCompat.js';

export const dbMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  await ensureSchemaCompat(c.env.DB);
  c.set('db', getDb(c.env.DB));
  await next();
});
