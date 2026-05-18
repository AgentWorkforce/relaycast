import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_HARNESS_HEADER,
  UNKNOWN_ORCHESTRATOR_HARNESS,
  extractOrchestratorHarness,
} from '../origin.js';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('extractOrchestratorHarness', () => {
  it('returns unknown when the header is missing', () => {
    expect(extractOrchestratorHarness(headers({}))).toBe(UNKNOWN_ORCHESTRATOR_HARNESS);
  });

  it('returns unknown when the header is empty or whitespace', () => {
    expect(extractOrchestratorHarness(headers({ [ORCHESTRATOR_HARNESS_HEADER]: '' }))).toBe(UNKNOWN_ORCHESTRATOR_HARNESS);
    expect(extractOrchestratorHarness(headers({ [ORCHESTRATOR_HARNESS_HEADER]: '   ' }))).toBe(UNKNOWN_ORCHESTRATOR_HARNESS);
  });

  it('lowercases well-formed values', () => {
    expect(extractOrchestratorHarness(headers({ [ORCHESTRATOR_HARNESS_HEADER]: 'Claude-Code' }))).toBe('claude-code');
    expect(extractOrchestratorHarness(headers({ [ORCHESTRATOR_HARNESS_HEADER]: 'CURSOR' }))).toBe('cursor');
  });

  it('accepts unknown identifiers (we segment server-side later)', () => {
    expect(extractOrchestratorHarness(headers({ [ORCHESTRATOR_HARNESS_HEADER]: 'my-new-harness' }))).toBe('my-new-harness');
  });

  it('rejects oversized values', () => {
    const long = 'a'.repeat(64);
    expect(extractOrchestratorHarness(headers({ [ORCHESTRATOR_HARNESS_HEADER]: long }))).toBe(UNKNOWN_ORCHESTRATOR_HARNESS);
  });

  it('rejects disallowed characters (whitespace, slashes, etc.)', () => {
    expect(extractOrchestratorHarness(headers({ [ORCHESTRATOR_HARNESS_HEADER]: 'claude code' }))).toBe(UNKNOWN_ORCHESTRATOR_HARNESS);
    expect(extractOrchestratorHarness(headers({ [ORCHESTRATOR_HARNESS_HEADER]: 'claude/code' }))).toBe(UNKNOWN_ORCHESTRATOR_HARNESS);
    expect(extractOrchestratorHarness(headers({ [ORCHESTRATOR_HARNESS_HEADER]: 'claude;code' }))).toBe(UNKNOWN_ORCHESTRATOR_HARNESS);
    // Non-ASCII values are rejected at the platform Headers boundary before
    // reaching this code; the regex provides defense-in-depth for any that
    // slip through (e.g. via test harnesses that don't enforce the spec).
  });
});
