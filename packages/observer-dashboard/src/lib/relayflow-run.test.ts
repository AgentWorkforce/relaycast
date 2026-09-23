import { describe, expect, it } from 'vitest';
import type { MessageWithMeta } from '@relaycast/sdk';
import { latestRelayflowRun, stepColumns, type RelayflowStep } from './relayflow-run';

function message(id: string, createdAt: string, metadata?: Record<string, unknown>): MessageWithMeta {
  return {
    id, channelId: 'c', agentName: 'flow', agentId: 'a', text: 't', blocks: null,
    ...(metadata ? { metadata } : {}),
    hasAttachments: false, threadId: null, attachments: [], createdAt, replyCount: 0, reactions: [], readByCount: 0,
  } as MessageWithMeta;
}

function snapshot(status: string, state: string) {
  return { relayflow: { version: 1, event: 'x', run: {
    runId: 'R1', flow: 'hello', status,
    steps: [{ id: 'greet', type: 'deterministic', dependsOn: [], state }],
  } } };
}

describe('latestRelayflowRun', () => {
  it('returns the newest snapshot regardless of message order', () => {
    const run = latestRelayflowRun([
      message('3', '2026-09-23T00:00:02.000Z', snapshot('completed', 'completed')),
      message('1', '2026-09-23T00:00:00.000Z', snapshot('running', 'pending')),
      message('2', '2026-09-23T00:00:01.000Z', snapshot('running', 'running')),
    ]);
    expect(run?.status).toBe('completed');
    expect(run?.steps[0]?.state).toBe('completed');
  });

  it('breaks a timestamp tie by the later snowflake id', () => {
    const at = '2026-09-23T00:00:00.000Z';
    const run = latestRelayflowRun([
      message('228601462569775105', at, snapshot('completed', 'completed')),
      message('228601462569775104', at, snapshot('running', 'running')),
    ]);
    expect(run?.status).toBe('completed');
  });

  it('ignores ordinary messages and malformed or unknown-version metadata', () => {
    expect(latestRelayflowRun([message('1', '2026-09-23T00:00:00.000Z')])).toBeNull();
    expect(latestRelayflowRun([message('1', '2026-09-23T00:00:00.000Z', { relayflow: { version: 2, run: {} } })])).toBeNull();
    expect(latestRelayflowRun([message('1', '2026-09-23T00:00:00.000Z', { relayflow: { version: 1, run: { runId: 1 } } })])).toBeNull();
    const run = latestRelayflowRun([message('1', '2026-09-23T00:00:00.000Z', { relayflow: { version: 1, run: {
      runId: 'R', flow: 'f', status: 'running', steps: [{ id: 'ok', state: 'running' }, { id: 'bad', state: 'exploded' }, 7],
    } } })]);
    expect(run?.steps.map(step => step.id)).toEqual(['ok']);
  });
});

describe('stepColumns', () => {
  const step = (id: string, dependsOn: string[] = []): RelayflowStep => ({ id, type: 'deterministic', dependsOn, state: 'pending' });

  it('groups steps by dependency depth in declaration order', () => {
    const columns = stepColumns([step('a'), step('b'), step('c', ['a']), step('d', ['b', 'c'])]);
    expect(columns.map(column => column.map(s => s.id))).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('keeps steps with unknown dependencies or cycles visible', () => {
    const columns = stepColumns([step('x', ['missing']), step('y', ['z']), step('z', ['y'])]);
    expect(columns.flat().map(s => s.id).sort()).toEqual(['x', 'y', 'z']);
  });
});
