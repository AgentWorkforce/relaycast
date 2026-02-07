import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';

describe('GET /health', () => {
  it('returns 200 with ok and version', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: '0.1.0' });
  });
});

describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/v1/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('malformed JSON', () => {
  it('returns 400 for malformed JSON body', async () => {
    const res = await request(app)
      .post('/v1/workspaces')
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('invalid_json');
  });
});
