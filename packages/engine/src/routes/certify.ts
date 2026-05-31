import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as certifyEngine from '../engine/certify.js';
import { errorResponse } from '../lib/httpError.js';

export const certifyRoutes = new Hono<AppEnv>();

const submitCertificationSchema = z.object({
  agent_url: z.string().url(),
  level: certifyEngine.CertificationLevelSchema.default(1),
});

const monitorCertificationSchema = z.object({
  agent_url: z.string().url(),
  level: certifyEngine.CertificationLevelSchema.default(1),
  interval_minutes: z.number().int().min(5).max(10_080).default(60),
});

certifyRoutes.post('/certify', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = submitCertificationSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'agent_url and a valid level are required' },
      }, 400);
    }

    const result = await certifyEngine.createAndRunCertification(c.get('db'), c.get('workspace').id, {
      agentUrl: parsed.data.agent_url,
      level: parsed.data.level,
      source: 'manual',
    });

    return c.json({
      ok: true,
      data: {
        id: result.id,
        agent_url: result.agent_url,
        level: result.level,
        passed: result.passed,
        passed_tests: result.passed_tests,
        total_tests: result.total_tests,
        started_at: result.started_at,
        completed_at: result.completed_at,
        tests: result.tests,
      },
    }, 201);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

certifyRoutes.get('/certify/:id', requireAuth, rateLimit, async (c) => {
  try {
    const result = await certifyEngine.getCertificationRun(c.get('db'), c.get('workspace').id, c.req.param('id'));
    if (!result) {
      return c.json({
        ok: false,
        error: { code: 'certification_not_found', message: 'Certification run not found' },
      }, 404);
    }

    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

certifyRoutes.get('/certify/:id/badge.svg', requireAuth, rateLimit, async (c) => {
  try {
    const result = await certifyEngine.getCertificationRun(c.get('db'), c.get('workspace').id, c.req.param('id'));
    if (!result) {
      return c.text('Not found', 404);
    }

    return new Response(
      certifyEngine.badgeSvg({
        passed: result.passed,
        level: result.level,
        passed_tests: result.passed_tests,
        total_tests: result.total_tests,
        status: result.status,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      },
    );
  } catch {
    return c.text('Internal Server Error', 500);
  }
});

certifyRoutes.post('/certify/monitor', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = monitorCertificationSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'agent_url and a valid monitoring configuration are required' },
      }, 400);
    }

    const result = await certifyEngine.enableCertificationMonitoring(
      c.get('db'),
      c.get('workspace').id,
      parsed.data.agent_url,
      parsed.data.level,
      parsed.data.interval_minutes,
    );

    return c.json({
      ok: true,
      data: result,
    }, 201);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
