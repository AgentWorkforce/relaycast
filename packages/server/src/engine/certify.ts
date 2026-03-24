import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { getDb } from '../db/index.js';
import { certifications } from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

const AgentCardSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  version: z.string().min(1),
  skills: z.array(z.object({
    id: z.string().optional(),
    name: z.string().min(1),
  })).min(1),
});

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
});

export const CertificationLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export interface CertificationTestResult {
  id: string;
  name: string;
  passed: boolean;
  duration_ms: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface CertificationRunResult {
  agent_url: string;
  level: 1 | 2 | 3;
  passed: boolean;
  passed_tests: number;
  total_tests: number;
  started_at: string;
  completed_at: string;
  tests: CertificationTestResult[];
}

interface RpcOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PersistCertificationInput {
  agentUrl: string;
  level: 1 | 2 | 3;
  source?: string;
  monitorEnabled?: boolean;
  monitorIntervalMinutes?: number;
}

function normalizeAgentUrl(agentUrl: string): string {
  const parsed = new URL(agentUrl);
  parsed.hash = '';
  return parsed.toString();
}

function normalizeCardUrl(agentUrl: string): string {
  const parsed = new URL(agentUrl);
  parsed.pathname = '/.well-known/agent-card.json';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function rpcCall(agentUrl: string, method: string, params: Record<string, unknown>, options: RpcOptions = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 8_000;
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const abortHandler = () => controller.abort('aborted');
  options.signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    const res = await fetch(agentUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method,
        params,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    const parsed = JsonRpcResponseSchema.safeParse(json);
    return {
      ok: res.ok && parsed.success && !parsed.data.error,
      status: res.status,
      body: json,
      parsed: parsed.success ? parsed.data : null,
      parse_error: parsed.success ? null : parsed.error.flatten(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      parsed: null,
      parse_error: null,
      transport_error: error instanceof Error ? error.message : 'unknown transport error',
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortHandler);
  }
}

async function fetchAgentCard(agentUrl: string) {
  const started = Date.now();
  const cardUrl = normalizeCardUrl(agentUrl);
  try {
    const response = await fetch(cardUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    const parsed = AgentCardSchema.safeParse(json);
    return {
      passed: response.ok && parsed.success,
      duration_ms: Date.now() - started,
      message: response.ok && parsed.success ? 'Agent card fetched successfully' : `Agent card fetch failed with status ${response.status}`,
      details: {
        url: cardUrl,
        status: response.status,
        parse_error: parsed.success ? null : parsed.error.flatten(),
      },
      card: parsed.success ? parsed.data : null,
    };
  } catch (error) {
    return {
      passed: false,
      duration_ms: Date.now() - started,
      message: 'Agent card fetch failed',
      details: {
        url: cardUrl,
        error: error instanceof Error ? error.message : 'unknown error',
      },
      card: null,
    };
  }
}

async function runTest(
  id: string,
  name: string,
  fn: () => Promise<{ passed: boolean; message: string; details?: Record<string, unknown> }>,
): Promise<CertificationTestResult> {
  const started = Date.now();
  try {
    const result = await fn();
    return {
      id,
      name,
      passed: result.passed,
      duration_ms: Date.now() - started,
      message: result.message,
      details: result.details,
    };
  } catch (error) {
    return {
      id,
      name,
      passed: false,
      duration_ms: Date.now() - started,
      message: error instanceof Error ? error.message : 'unknown test failure',
    };
  }
}

function buildMessageParams() {
  const taskId = `task_${crypto.randomUUID()}`;
  const contextId = `ctx_${crypto.randomUUID()}`;
  return {
    message: {
      message_id: `msg_${crypto.randomUUID()}`,
      role: 'user',
      context_id: contextId,
      parts: [{ kind: 'text', text: 'Certification probe message' }],
    },
    metadata: {
      task_id: taskId,
      certification: true,
    },
    task_id: taskId,
    context_id: contextId,
  };
}

async function levelOneTests(agentUrl: string): Promise<CertificationTestResult[]> {
  const cardProbe = await fetchAgentCard(agentUrl);
  const sendParams = buildMessageParams();
  const taskId = String(sendParams.task_id);

  return [
    {
      id: 'agent_card',
      name: 'Agent card discovery',
      passed: cardProbe.passed,
      duration_ms: cardProbe.duration_ms,
      message: cardProbe.message,
      details: cardProbe.details,
    },
    await runTest('rpc_reachable', 'JSON-RPC endpoint reachable', async () => {
      const response = await rpcCall(agentUrl, 'message/send', sendParams);
      return {
        passed: response.status > 0,
        message: response.status > 0 ? `Endpoint responded with HTTP ${response.status}` : 'Endpoint did not respond',
        details: { status: response.status, transport_error: response.transport_error ?? null },
      };
    }),
    await runTest('message_send', 'Message send request', async () => {
      const response = await rpcCall(agentUrl, 'message/send', sendParams);
      return {
        passed: response.ok,
        message: response.ok ? 'message/send returned a success response' : 'message/send failed',
        details: { status: response.status, body: response.body, transport_error: response.transport_error ?? null },
      };
    }),
    await runTest('task_get', 'Task retrieval', async () => {
      const response = await rpcCall(agentUrl, 'tasks/get', { id: taskId, task_id: taskId });
      return {
        passed: response.ok,
        message: response.ok ? 'tasks/get returned a success response' : 'tasks/get failed',
        details: { status: response.status, body: response.body },
      };
    }),
    await runTest('skills_declared', 'Agent card exposes skills', async () => ({
      passed: Boolean(cardProbe.card && cardProbe.card.skills.length > 0),
      message: cardProbe.card?.skills?.length ? `Agent card declares ${cardProbe.card.skills.length} skills` : 'Agent card did not declare any skills',
      details: { skills: cardProbe.card?.skills ?? [] },
    })),
    await runTest('card_url_matches', 'Agent card URL matches submitted endpoint origin', async () => {
      const card = cardProbe.card;
      const expectedOrigin = new URL(agentUrl).origin;
      const actualOrigin = card ? new URL(card.url).origin : null;
      return {
        passed: expectedOrigin === actualOrigin,
        message: expectedOrigin === actualOrigin ? 'Agent card points at the same origin as the submitted endpoint' : 'Agent card URL does not match the submitted endpoint origin',
        details: { expected_origin: expectedOrigin, actual_origin: actualOrigin },
      };
    }),
  ];
}

async function levelTwoTests(agentUrl: string): Promise<CertificationTestResult[]> {
  const params = buildMessageParams();
  const taskId = String(params.task_id);

  return [
    await runTest('message_send_subscribe', 'Streaming message flow', async () => {
      const response = await rpcCall(agentUrl, 'message/sendSubscribe', params, { timeoutMs: 10_000 });
      return {
        passed: response.ok,
        message: response.ok ? 'message/sendSubscribe returned a success response' : 'message/sendSubscribe failed',
        details: { status: response.status, body: response.body },
      };
    }),
    await runTest('task_lifecycle', 'Task lifecycle state response', async () => {
      const response = await rpcCall(agentUrl, 'tasks/get', { id: taskId, task_id: taskId });
      const state = (response.body as any)?.result?.task?.status?.state;
      const allowed = ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled', 'unknown'];
      return {
        passed: response.ok && typeof state === 'string' && allowed.includes(state),
        message: response.ok && typeof state === 'string' ? `tasks/get returned lifecycle state "${state}"` : 'tasks/get did not return a lifecycle state',
        details: { status: response.status, state, body: response.body },
      };
    }),
    await runTest('task_cancel', 'Task cancellation', async () => {
      const response = await rpcCall(agentUrl, 'tasks/cancel', { id: taskId, task_id: taskId });
      return {
        passed: response.ok,
        message: response.ok ? 'tasks/cancel returned a success response' : 'tasks/cancel failed',
        details: { status: response.status, body: response.body },
      };
    }),
    await runTest('task_resubscribe', 'Task resubscribe flow', async () => {
      const response = await rpcCall(agentUrl, 'tasks/resubscribe', { id: taskId, task_id: taskId }, { timeoutMs: 10_000 });
      return {
        passed: response.ok,
        message: response.ok ? 'tasks/resubscribe returned a success response' : 'tasks/resubscribe failed',
        details: { status: response.status, body: response.body },
      };
    }),
    await runTest('jsonrpc_shape', 'JSON-RPC envelope shape', async () => {
      const response = await rpcCall(agentUrl, 'message/send', params);
      const body = response.body as Record<string, unknown> | null;
      return {
        passed: Boolean(body && body.jsonrpc === '2.0' && ('result' in body || 'error' in body)),
        message: body && body.jsonrpc === '2.0' ? 'Response used a JSON-RPC 2.0 envelope' : 'Response did not use a valid JSON-RPC 2.0 envelope',
        details: { body, parse_error: response.parse_error },
      };
    }),
    await runTest('error_handling', 'Protocol error handling', async () => {
      const response = await rpcCall(agentUrl, 'method/doesNotExist', {});
      const errorCode = (response.body as any)?.error?.code;
      return {
        passed: response.status > 0 && typeof errorCode === 'number',
        message: typeof errorCode === 'number' ? `Unsupported method produced error code ${errorCode}` : 'Unsupported method did not produce a JSON-RPC error',
        details: { status: response.status, body: response.body },
      };
    }),
  ];
}

async function levelThreeTests(agentUrl: string): Promise<CertificationTestResult[]> {
  return [
    await runTest('response_time', 'Response time under 2 seconds', async () => {
      const started = Date.now();
      const response = await rpcCall(agentUrl, 'message/send', buildMessageParams(), { timeoutMs: 4_000 });
      const elapsed = Date.now() - started;
      return {
        passed: response.status > 0 && elapsed < 2_000,
        message: response.status > 0 && elapsed < 2_000 ? `Endpoint responded in ${elapsed}ms` : `Endpoint took ${elapsed}ms`,
        details: { elapsed_ms: elapsed, status: response.status },
      };
    }),
    await runTest('availability', 'Availability across repeated probes', async () => {
      const probes = await Promise.all([
        rpcCall(agentUrl, 'message/send', buildMessageParams()),
        rpcCall(agentUrl, 'message/send', buildMessageParams()),
        rpcCall(agentUrl, 'message/send', buildMessageParams()),
      ]);
      const successes = probes.filter((probe) => probe.status > 0).length;
      return {
        passed: successes >= 2,
        message: `${successes}/3 repeated probes returned HTTP responses`,
        details: { statuses: probes.map((probe) => probe.status) },
      };
    }),
    await runTest('concurrency', 'Concurrent request handling', async () => {
      const probes = await Promise.all([
        rpcCall(agentUrl, 'message/send', buildMessageParams()),
        rpcCall(agentUrl, 'message/send', buildMessageParams()),
        rpcCall(agentUrl, 'message/send', buildMessageParams()),
        rpcCall(agentUrl, 'message/send', buildMessageParams()),
      ]);
      const successful = probes.filter((probe) => probe.ok).length;
      return {
        passed: successful >= 3,
        message: `${successful}/4 concurrent requests completed successfully`,
        details: { statuses: probes.map((probe) => probe.status) },
      };
    }),
    await runTest('health_consistency', 'Health consistency across runs', async () => {
      const first = await fetchAgentCard(agentUrl);
      const second = await fetchAgentCard(agentUrl);
      return {
        passed: first.passed && second.passed,
        message: first.passed && second.passed ? 'Agent card remained healthy across consecutive checks' : 'Agent card was inconsistent across checks',
        details: { first: first.details, second: second.details },
      };
    }),
    await runTest('cancellation_latency', 'Cancellation completes quickly', async () => {
      const taskId = `task_${crypto.randomUUID()}`;
      await rpcCall(agentUrl, 'message/send', {
        ...buildMessageParams(),
        task_id: taskId,
      });
      const started = Date.now();
      const response = await rpcCall(agentUrl, 'tasks/cancel', { id: taskId, task_id: taskId }, { timeoutMs: 4_000 });
      const elapsed = Date.now() - started;
      return {
        passed: response.status > 0 && elapsed < 2_000,
        message: response.status > 0 && elapsed < 2_000 ? `Cancellation returned in ${elapsed}ms` : `Cancellation took ${elapsed}ms`,
        details: { elapsed_ms: elapsed, status: response.status, body: response.body },
      };
    }),
  ];
}

export async function runCertification(agentUrl: string, level: 1 | 2 | 3): Promise<CertificationRunResult> {
  const normalizedUrl = normalizeAgentUrl(agentUrl);
  const startedAt = new Date();

  const tests = [
    ...(await levelOneTests(normalizedUrl)),
    ...(level >= 2 ? await levelTwoTests(normalizedUrl) : []),
    ...(level >= 3 ? await levelThreeTests(normalizedUrl) : []),
  ];

  const passedTests = tests.filter((test) => test.passed).length;
  return {
    agent_url: normalizedUrl,
    level,
    passed: passedTests === tests.length,
    passed_tests: passedTests,
    total_tests: tests.length,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    tests,
  };
}

export async function createCertificationRun(
  db: Db,
  workspaceId: string,
  input: PersistCertificationInput,
) {
  const id = `cert_${crypto.randomUUID()}`;
  const now = new Date();

  await db.insert(certifications).values({
    id,
    workspaceId,
    agentUrl: normalizeAgentUrl(input.agentUrl),
    level: input.level,
    source: input.source ?? 'manual',
    status: 'pending',
    passed: false,
    passedTests: 0,
    totalTests: 0,
    monitorEnabled: input.monitorEnabled ?? false,
    monitorIntervalMinutes: input.monitorIntervalMinutes ?? 60,
    lastRunAt: null,
    results: [],
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

export async function completeCertificationRun(
  db: Db,
  workspaceId: string,
  id: string,
  result: CertificationRunResult,
) {
  const now = new Date();

  await db
    .update(certifications)
    .set({
      status: 'completed',
      passed: result.passed,
      passedTests: result.passed_tests,
      totalTests: result.total_tests,
      lastRunAt: now,
      results: result.tests,
      updatedAt: now,
    })
    .where(and(eq(certifications.id, id), eq(certifications.workspaceId, workspaceId)));
}

export async function createAndRunCertification(
  db: Db,
  workspaceId: string,
  input: PersistCertificationInput,
) {
  const id = await createCertificationRun(db, workspaceId, input);
  const result = await runCertification(input.agentUrl, input.level);
  await completeCertificationRun(db, workspaceId, id, result);
  return { id, ...result };
}

export async function getCertificationRun(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(certifications)
    .where(and(eq(certifications.id, id), eq(certifications.workspaceId, workspaceId)));

  if (!row) return null;

  return {
    id: row.id,
    agent_url: row.agentUrl,
    level: row.level,
    source: row.source,
    status: row.status,
    passed: row.passed,
    passed_tests: row.passedTests,
    total_tests: row.totalTests,
    monitor_enabled: row.monitorEnabled,
    monitor_interval_minutes: row.monitorIntervalMinutes,
    last_run_at: row.lastRunAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    tests: (row.results as CertificationTestResult[] | null) ?? [],
  };
}

export async function enableCertificationMonitoring(
  db: Db,
  workspaceId: string,
  agentUrl: string,
  level: 1 | 2 | 3,
  intervalMinutes = 60,
) {
  const id = await createCertificationRun(db, workspaceId, {
    agentUrl,
    level,
    source: 'monitor',
    monitorEnabled: true,
    monitorIntervalMinutes: intervalMinutes,
  });

  return getCertificationRun(db, workspaceId, id);
}

export function badgeSvg(result: {
  passed: boolean;
  level: number;
  passed_tests: number;
  total_tests: number;
  status?: string;
}) {
  const label = 'a2a certification';
  const value = result.passed
    ? `level ${result.level} ${result.passed_tests}/${result.total_tests}`
    : `${result.status ?? 'failed'} ${result.passed_tests}/${result.total_tests}`;
  const color = result.passed ? '#1f9d55' : '#d64545';
  const labelWidth = 112;
  const valueWidth = Math.max(70, value.length * 7);
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${value}"><title>${label}: ${value}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".1" stop-color="#aaa" stop-opacity=".1"/><stop offset=".9" stop-opacity=".3"/><stop offset="1" stop-opacity=".5"/></linearGradient><clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${labelWidth}" height="20" fill="#555"/><rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/><rect width="${totalWidth}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text><text x="${labelWidth / 2}" y="14">${label}</text><text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text><text x="${labelWidth + valueWidth / 2}" y="14">${value}</text></g></svg>`;
}
