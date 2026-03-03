import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireUserAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as userEngine from '../engine/user.js';

export const userRoutes = new Hono<AppEnv>();

// IP-based rate limiter for unauthenticated auth endpoints
const authBuckets = new Map<string, { count: number; windowStart: number }>();

function authRateLimit(maxRequests: number, windowMs: number = 60_000) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    let bucket = authBuckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { count: 0, windowStart: now };
      authBuckets.set(key, bucket);
    }

    bucket.count++;
    if (bucket.count > maxRequests) {
      return c.json({
        ok: false,
        error: { code: 'rate_limit_exceeded', message: 'Too many requests. Please try again later.' },
      }, 429);
    }

    await next();
  });
}

const signupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const verifyEmailSchema = z.object({
  user_id: z.string(),
  code: z.string().length(6),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const switchOrgSchema = z.object({
  organization_id: z.string(),
});

// POST /user/signup
userRoutes.post('/user/signup', authRateLimit(5), async (c) => {
  try {
    const parsed = signupSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'name, email, and password (min 8 chars) are required' } }, 400);
    }

    const db = c.get('db');
    const result = await userEngine.signup(db, parsed.data);

    return c.json({
      ok: true,
      data: {
        user_id: result.user_id,
        verification_code: result.verification_code,
        created_at: result.created_at,
      },
    }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// POST /user/verify
userRoutes.post('/user/verify', authRateLimit(10), async (c) => {
  try {
    const parsed = verifyEmailSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'user_id and 6-digit code are required' } }, 400);
    }

    const db = c.get('db');
    const result = await userEngine.verifyEmail(db, parsed.data);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// POST /user/login
userRoutes.post('/user/login', authRateLimit(5), async (c) => {
  try {
    const parsed = loginSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'email and password are required' } }, 400);
    }

    const db = c.get('db');
    const result = await userEngine.login(db, parsed.data);

    c.header('Set-Cookie', `relaycast_session=${result.session_token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`);

    return c.json({
      ok: true,
      data: {
        user_id: result.user_id,
        organizations: result.organizations,
      },
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// POST /user/logout
userRoutes.post('/user/logout', requireUserAuth, async (c) => {
  const cookieHeader = c.req.header('Cookie');
  const match = cookieHeader?.match(/(?:^|;\s*)relaycast_session=([^;]*)/);
  if (match?.[1]) {
    const db = c.get('db');
    await userEngine.deleteSession(db, match[1]);
  }
  c.header('Set-Cookie', 'relaycast_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  return c.json({ ok: true, data: { logged_out: true } });
});

// GET /user - get current user
userRoutes.get('/user', requireUserAuth, rateLimit, async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  if (!user) {
    return c.json({ ok: false, error: { code: 'unauthorized', message: 'Not authenticated' } }, 401);
  }
  const profile = await userEngine.getUser(db, user.id);
  return c.json({ ok: true, data: profile });
});

// GET /user/orgs - list user's organizations
userRoutes.get('/user/orgs', requireUserAuth, rateLimit, async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  if (!user) {
    return c.json({ ok: false, error: { code: 'unauthorized', message: 'Not authenticated' } }, 401);
  }
  const orgs = await userEngine.getUserOrgs(db, user.id);
  return c.json({ ok: true, data: orgs });
});

// POST /user/orgs/switch - switch active org
userRoutes.post('/user/orgs/switch', requireUserAuth, rateLimit, async (c) => {
  try {
    const parsed = switchOrgSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'organization_id is required' } }, 400);
    }

    const db = c.get('db');
    const user = c.get('user');
    if (!user) {
      return c.json({ ok: false, error: { code: 'unauthorized', message: 'Not authenticated' } }, 401);
    }

    // Get session ID from cookie
    const cookieHeader = c.req.header('Cookie');
    const match = cookieHeader?.match(/(?:^|;\s*)relaycast_session=([^;]*)/);
    if (!match?.[1]) {
      return c.json({ ok: false, error: { code: 'unauthorized', message: 'Session not found' } }, 401);
    }

    const org = await userEngine.switchOrg(db, match[1], user.id, parsed.data.organization_id);
    return c.json({ ok: true, data: { id: org.id, name: org.name, plan: org.plan } });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});
