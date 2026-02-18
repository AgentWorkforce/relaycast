import { describe, it, expect } from 'vitest';
import { buildFtsQuery } from '../searchQuery.js';

describe('buildFtsQuery', () => {
  it('splits on punctuation (hyphen)', () => {
    expect(buildFtsQuery('cursor-test')).toBe('cursor test');
    expect(buildFtsQuery('mcp-tooltest')).toBe('mcp tooltest');
  });

  it('collapses whitespace', () => {
    expect(buildFtsQuery('  deploy   error ')).toBe('deploy error');
  });

  it('returns empty for non-searchable input', () => {
    expect(buildFtsQuery('   ')).toBe('');
    expect(buildFtsQuery('!!!')).toBe('');
  });
});
