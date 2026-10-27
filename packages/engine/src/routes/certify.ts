import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as certifyEngine from '../engine/certify.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

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
    const parsed = await parseJsonBody(
      c,
      submitCertificationSchema,
      'agent_url and a valid level are required',
    );
    if (!parsed.ok) {
      return parsed.response;
    }

    const result = await certifyEngine.createAndRunCertification(c.get('db'), c.get('workspace').id, {
      agentUrl: parsed.data.agent_url,
      level: parsed.data.level,
      source: 'manual',
    });

    return jsonCreated(c, {
      id: result.id,
      agent_url: result.agent_url,
      level: result.level,
      passed: result.passed,
      passed_tests: result.passed_tests,
      total_tests: result.total_tests,
      started_at: result.started_at,
      completed_at: result.completed_at,
      tests: result.tests,
    });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

certifyRoutes.get('/certify/:id', requireAuth, rateLimit, async (c) => {
  try {
    const result = await certifyEngine.getCertificationRun(c.get('db'), c.get('workspace').id, c.req.param('id'));
    if (!result) {
      return jsonNotFound(c, 'certification_not_found', 'Certification run not found');
    }

    return jsonOk(c, result);
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
    const parsed = await parseJsonBody(
      c,
      monitorCertificationSchema,
      'agent_url and a valid monitoring configuration are required',
    );
    if (!parsed.ok) {
      return parsed.response;
    }

    const result = await certifyEngine.enableCertificationMonitoring(
      c.get('db'),
      c.get('workspace').id,
      parsed.data.agent_url,
      parsed.data.level,
      parsed.data.interval_minutes,
    );

    return jsonCreated(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
