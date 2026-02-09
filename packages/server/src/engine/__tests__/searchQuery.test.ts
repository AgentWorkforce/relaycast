import { describe, it, expect } from 'vitest';
import { buildTsquery } from '../searchQuery.js';

describe('buildTsquery', () => {
  it('splits on punctuation (hyphen)', () => {
    expect(buildTsquery('cursor-test')).toBe('cursor & test');
    expect(buildTsquery('mcp-tooltest')).toBe('mcp & tooltest');
  });

  it('collapses whitespace', () => {
    expect(buildTsquery('  deploy   error ')).toBe('deploy & error');
  });

  it('returns empty for non-searchable input', () => {
    expect(buildTsquery('   ')).toBe('');
    expect(buildTsquery('!!!')).toBe('');
  });
});
