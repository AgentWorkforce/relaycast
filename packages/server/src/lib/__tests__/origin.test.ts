import { describe, expect, it } from 'vitest';
import {
  HARNESS_HEADER,
  UNKNOWN_HARNESS,
  extractHarness,
} from '../origin.js';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe('extractHarness', () => {
  it('returns unknown when the header is missing', () => {
    expect(extractHarness(headers({}))).toBe(UNKNOWN_HARNESS);
  });

  it('returns unknown when the header is empty or whitespace', () => {
    expect(extractHarness(headers({ [HARNESS_HEADER]: '' }))).toBe(UNKNOWN_HARNESS);
    expect(extractHarness(headers({ [HARNESS_HEADER]: '   ' }))).toBe(UNKNOWN_HARNESS);
  });

  it('lowercases well-formed values', () => {
    expect(extractHarness(headers({ [HARNESS_HEADER]: 'Claude-Code' }))).toBe('claude-code');
    expect(extractHarness(headers({ [HARNESS_HEADER]: 'CURSOR' }))).toBe('cursor');
  });

  it('accepts unknown identifiers (we segment server-side later)', () => {
    expect(extractHarness(headers({ [HARNESS_HEADER]: 'my-new-harness' }))).toBe('my-new-harness');
  });

  it('rejects oversized values', () => {
    const long = 'a'.repeat(64);
    expect(extractHarness(headers({ [HARNESS_HEADER]: long }))).toBe(UNKNOWN_HARNESS);
  });

  it('rejects disallowed characters (whitespace, slashes, etc.)', () => {
    expect(extractHarness(headers({ [HARNESS_HEADER]: 'claude code' }))).toBe(UNKNOWN_HARNESS);
    expect(extractHarness(headers({ [HARNESS_HEADER]: 'claude/code' }))).toBe(UNKNOWN_HARNESS);
    expect(extractHarness(headers({ [HARNESS_HEADER]: 'claude;code' }))).toBe(UNKNOWN_HARNESS);
    // Non-ASCII values are rejected at the platform Headers boundary before
    // reaching this code; the regex provides defense-in-depth for any that
    // slip through (e.g. via test harnesses that don't enforce the spec).
  });
});
