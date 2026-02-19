import { Hono } from 'hono';
import type { AppEnv } from '../env.js';

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/', (c) => {
  return c.json({
    ok: true,
    version: c.env.APP_SEMVER ?? '0.1.0',
    build: c.env.APP_VERSION ?? 'unknown',
  });
});
