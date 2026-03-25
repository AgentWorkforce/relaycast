import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { badgeSvg, runCertification } from '../certify.js';

async function startMockA2aServer() {
  const requests: Array<{ method: string; body: any }> = [];
  const taskStore = new Map<string, string>();

  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      const address = server.address();
      if (!address || typeof address === 'string') {
        res.writeHead(500);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: 'Mock Cert Agent',
        url: `http://127.0.0.1:${address.port}/rpc`,
        version: '1.0.0',
        skills: [
          { id: 'reporting', name: 'reporting' },
          { id: 'triage', name: 'triage' },
        ],
      }));
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ method: payload.method, body: payload });

      if (payload.method === 'message/send') {
        const taskId = String(payload.params?.task_id);
        taskStore.set(taskId, 'completed');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            task: {
              id: taskId,
              status: { state: 'completed' },
            },
            message: {
              message_id: `reply_${taskId}`,
              role: 'agent',
              context_id: payload.params?.context_id,
              parts: [{ kind: 'text', text: 'Probe accepted' }],
            },
          },
        }));
        return;
      }

      if (payload.method === 'tasks/get') {
        const taskId = String(payload.params?.task_id ?? payload.params?.id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            task: {
              id: taskId,
              status: { state: taskStore.get(taskId) ?? 'unknown' },
            },
          },
        }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock A2A server');
  }

  return {
    url: `http://127.0.0.1:${address.port}/rpc`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

describe('certification engine', () => {
  let mockServer: Awaited<ReturnType<typeof startMockA2aServer>> | null = null;

  beforeEach(async () => {
    mockServer = await startMockA2aServer();
  });

  afterEach(async () => {
    await mockServer?.close();
    mockServer = null;
  });

  it('passes level 1 certification against a mock A2A server', async () => {
    const result = await runCertification(`${mockServer!.url}?via=test#fragment`, 1);

    expect(result.agent_url).toBe(`${mockServer!.url}?via=test`);
    expect(result.level).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.passed_tests).toBe(6);
    expect(result.total_tests).toBe(6);
    expect(result.tests).toHaveLength(6);
    expect(result.tests.every((test) => test.passed)).toBe(true);
    expect(result.tests.map((test) => test.id)).toEqual([
      'agent_card',
      'rpc_reachable',
      'message_send',
      'task_get',
      'skills_declared',
      'card_url_matches',
    ]);
    expect(mockServer!.requests.map((request) => request.method)).toEqual([
      'message/send',
      'message/send',
      'tasks/get',
    ]);
  });

  it('renders badge SVG output for passed and failed results', () => {
    const passed = badgeSvg({
      passed: true,
      level: 1,
      passed_tests: 6,
      total_tests: 6,
      status: 'completed',
    });
    const failed = badgeSvg({
      passed: false,
      level: 1,
      passed_tests: 4,
      total_tests: 6,
      status: 'pending',
    });

    expect(passed).toContain('<svg');
    expect(passed).toContain('a2a certification: level 1 6/6');
    expect(passed).toContain('#1f9d55');
    expect(failed).toContain('a2a certification: pending 4/6');
    expect(failed).toContain('#d64545');
  });
});
