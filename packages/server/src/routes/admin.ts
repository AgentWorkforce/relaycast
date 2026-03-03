import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAdminSecret } from '../middleware/auth.js';
import * as orgEngine from '../engine/organization.js';

export const adminRoutes = new Hono<AppEnv>();

const setPlanSchema = z.object({
  plan: z.enum(['free', 'pro']),
});

// PUT /admin/orgs/:id/plan - set org plan
adminRoutes.put('/admin/orgs/:id/plan', requireAdminSecret, async (c) => {
  try {
    const parsed = setPlanSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'plan ("free" or "pro") is required' } }, 400);
    }

    const db = c.get('db');
    const orgId = c.req.param('id');

    const result = await orgEngine.setOrgPlan(db, orgId, parsed.data.plan);

    if (!result) {
      return c.json({ ok: false, error: { code: 'org_not_found', message: 'Organization not found' } }, 404);
    }

    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});
