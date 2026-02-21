import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireOrgAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as orgEngine from '../engine/organization.js';
import * as workspaceEngine from '../engine/workspace.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const organizationRoutes = new Hono<AppEnv>();

const createOrgSchema = z.object({
  name: z.string().min(1),
});

const updateOrgSchema = z.object({
  name: z.string().optional(),
});

const claimWorkspaceSchema = z.object({
  workspace_api_key: z.string(),
});

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
});

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).optional(),
});

// POST /orgs - create a new organization (requires user session)
organizationRoutes.post('/orgs', requireOrgAuth, rateLimit, async (c) => {
  try {
    const parsed = createOrgSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'name is required' } }, 400);
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ ok: false, error: { code: 'unauthorized', message: 'User session required to create an organization' } }, 401);
    }

    const db = c.get('db');
    const result = await orgEngine.createOrg(db, user.id, parsed.data);
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// GET /org - get current org
organizationRoutes.get('/org', requireOrgAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const org = await orgEngine.getOrg(db, c.get('organization').id);
    if (!org) {
      return c.json({ ok: false, error: { code: 'org_not_found', message: 'Organization not found' } }, 404);
    }
    return c.json({ ok: true, data: org });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// PATCH /org - update org
organizationRoutes.patch('/org', requireOrgAuth, rateLimit, async (c) => {
  try {
    const parsed = updateOrgSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'invalid update body' } }, 400);
    }

    const db = c.get('db');
    const updated = await orgEngine.updateOrg(db, c.get('organization').id, parsed.data);
    return c.json({ ok: true, data: updated });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// POST /org/claim - claim a free workspace
organizationRoutes.post('/org/claim', requireOrgAuth, rateLimit, async (c) => {
  try {
    const parsed = claimWorkspaceSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'workspace_api_key is required' } }, 400);
    }

    const db = c.get('db');
    const result = await orgEngine.claimWorkspace(db, c.get('organization').id, parsed.data.workspace_api_key);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// POST /org/workspaces - create workspace under org
organizationRoutes.post('/org/workspaces', requireOrgAuth, rateLimit, async (c) => {
  try {
    const parsed = createWorkspaceSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'name is required' } }, 400);
    }

    const db = c.get('db');
    const org = c.get('organization');
    const result = await workspaceEngine.createWorkspace(db, parsed.data.name, org.id);
    emitServerEvent(c, result.workspace_id, 'relaycast_server_workspace_created', {
      created_via: 'org_api',
      organization_id: org.id,
    });
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// GET /org/workspaces - list org workspaces
organizationRoutes.get('/org/workspaces', requireOrgAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const list = await orgEngine.getOrgWorkspaces(db, c.get('organization').id);
    return c.json({ ok: true, data: list });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// GET /org/members - list org members
organizationRoutes.get('/org/members', requireOrgAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const members = await orgEngine.getOrgMembers(db, c.get('organization').id);
    return c.json({ ok: true, data: members });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// POST /org/members/invite - invite a user to the org
organizationRoutes.post('/org/members/invite', requireOrgAuth, rateLimit, async (c) => {
  try {
    const parsed = inviteMemberSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'email is required' } }, 400);
    }

    const db = c.get('db');
    const result = await orgEngine.inviteMember(
      db,
      c.get('organization').id,
      parsed.data.email,
      parsed.data.role,
    );
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// DELETE /org/members/:userId - remove a member from the org
organizationRoutes.delete('/org/members/:userId', requireOrgAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    await orgEngine.removeMember(db, c.get('organization').id, c.req.param('userId'));
    return c.json({ ok: true, data: { removed: true } });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});
