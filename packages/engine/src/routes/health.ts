import { Hono } from 'hono';
import type { AppEnv } from '../env.js';

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/', (c) => {
  return c.json({
    ok: true,
    version: c.get('engine').config.appSemver ?? c.get('engine').config.appVersion ?? '0.1.0',
    build: c.get('engine').config.appVersion ?? 'unknown',
  });
});
