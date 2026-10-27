import { describe, expect, it } from 'vitest';
import { FleetActionAcceptMessageSchema, FleetActionResultMessageSchema, FleetCapabilitySchema, FleetRelaycastToBrokerMessageSchema, FleetTaskContextSchema } from '../index.js';

describe('opt-in fleet task protocol', () => {
  const accept = { v: 1, id: 'request', type: 'action.accept', invocation_id: 'inv', execution_id: 'inv/1', worker_generation: 'worker-1' };
  const final = { ...accept, type: 'action.result', final: true, output: { answer: 42 }, accounting: { tokens: 13 } };
  it('requires a request identity, execution fence, and worker generation on acceptance', () => {
    expect(FleetActionAcceptMessageSchema.safeParse(accept).success).toBe(true);
    for (const key of ['id', 'invocation_id', 'execution_id', 'worker_generation']) {
      expect(FleetActionAcceptMessageSchema.safeParse({ ...accept, [key]: undefined }).success).toBe(false);
      expect(FleetActionAcceptMessageSchema.safeParse({ ...accept, [key]: '' }).success).toBe(false);
    }
  });
  it('requires every task result fence and explicit final while retaining legacy results', () => {
    expect(FleetActionResultMessageSchema.safeParse(final).success).toBe(true);
    expect(FleetActionResultMessageSchema.safeParse({ ...final, final: false }).success).toBe(true);
    for (const key of ['id', 'execution_id', 'worker_generation', 'final']) {
      expect(FleetActionResultMessageSchema.safeParse({ ...final, [key]: undefined }).success).toBe(false);
    }
    expect(FleetActionResultMessageSchema.safeParse({ v: 1, type: 'action.result', invocation_id: 'spawn', output: { ready: true } }).success).toBe(true);
    expect(FleetActionResultMessageSchema.safeParse({ ...final, accounting: { tokens: -1 } }).success).toBe(false);
    expect(FleetActionResultMessageSchema.safeParse({ ...final, error: 'mixed output and error' }).success).toBe(false);
  });
  it('validates opt-in capability and immutable bounded correlation without rewriting identifiers', () => {
    expect(FleetCapabilitySchema.safeParse({ name: 'task.run', kind: 'action', execution_mode: 'task' }).success).toBe(true);
    expect(FleetCapabilitySchema.safeParse({ name: 'task.run', execution_mode: 'invented' }).success).toBe(false);
    const context = { run_id: 'run', step_id: 'step', dispatch_id: 'dispatch', timeout_ms: 1000 };
    expect(FleetTaskContextSchema.parse(context)).toEqual(context);
    for (const value of [0, 86_400_001, 1.5]) expect(FleetTaskContextSchema.safeParse({ ...context, timeout_ms: value }).success).toBe(false);
    expect(FleetTaskContextSchema.safeParse({ ...context, run_id: ' run ' }).success).toBe(false);
    expect(FleetRelaycastToBrokerMessageSchema.safeParse({ v: 1, type: 'action.invoke', invocation_id: 'inv', action: 'task.run', input: {}, task_execution: { execution_id: 'inv/1', run_id: 'run', step_id: 'step', dispatch_id: 'dispatch', deadline: '2026-01-01T00:00:00.000Z' } }).success).toBe(true);
  });
});
