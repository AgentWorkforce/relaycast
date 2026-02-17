import { Hono } from 'hono';
import type { AppEnv } from '../env.js';

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/', (c) => {
  return c.json({ ok: true, version: '0.1.0' });
});
