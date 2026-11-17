import { describe, expect, it } from 'vitest';
import {
  MAX_LEADER_PATTERNS,
  isGlobPattern,
  leaderMatcher,
  matchesLeaderPattern,
  normalizeLeaderPatterns,
} from '../leaders.js';

describe('leader pattern matcher', () => {
  it('treats a pattern without wildcards as an exact, case-sensitive name', () => {
    expect(isGlobPattern('admin')).toBe(false);
    expect(matchesLeaderPattern('admin', 'admin')).toBe(true);
    expect(matchesLeaderPattern('admin', 'Admin')).toBe(false);
    expect(matchesLeaderPattern('admin', 'admin2')).toBe(false);
    expect(matchesLeaderPattern('admin', 'xadmin')).toBe(false);
  });

  it('matches * against any run of characters, including none', () => {
    expect(matchesLeaderPattern('*grok', 'grok')).toBe(true);
    expect(matchesLeaderPattern('*grok', 'opsgrok')).toBe(true);
    expect(matchesLeaderPattern('*grok', 'grokker')).toBe(false);
    expect(matchesLeaderPattern('lead-*', 'lead-')).toBe(true);
    expect(matchesLeaderPattern('lead-*', 'lead-alpha')).toBe(true);
    expect(matchesLeaderPattern('lead-*', 'Lead-alpha')).toBe(false);
    expect(matchesLeaderPattern('a*b*c', 'axxbyyc')).toBe(true);
    expect(matchesLeaderPattern('a*b*c', 'axxbyy')).toBe(false);
    expect(matchesLeaderPattern('*', 'anything at all')).toBe(true);
  });

  it('matches ? against exactly one character', () => {
    expect(matchesLeaderPattern('agent-?', 'agent-1')).toBe(true);
    expect(matchesLeaderPattern('agent-?', 'agent-')).toBe(false);
    expect(matchesLeaderPattern('agent-?', 'agent-12')).toBe(false);
    expect(matchesLeaderPattern('??', 'é1')).toBe(true);
    expect(matchesLeaderPattern('?', '🦀')).toBe(true);
  });

  it('treats regex metacharacters literally', () => {
    expect(matchesLeaderPattern('a.b', 'a.b')).toBe(true);
    expect(matchesLeaderPattern('a.b*', 'axb')).toBe(false);
    expect(matchesLeaderPattern('a.b*', 'a.bc')).toBe(true);
    expect(matchesLeaderPattern('(x)+[y]{1}|z$^\\/*', '(x)+[y]{1}|z$^\\/tail')).toBe(true);
    expect(matchesLeaderPattern('(x)+*', 'xx')).toBe(false);
    expect(() => matchesLeaderPattern('[unclosed*', '[unclosed')).not.toThrow();
    expect(matchesLeaderPattern('[unclosed*', '[unclosed]')).toBe(true);
    expect(matchesLeaderPattern('\\d+', '1')).toBe(false);
    expect(matchesLeaderPattern('\\d?', '\\d1')).toBe(true);
  });

  it('anchors the whole name, including across newlines', () => {
    expect(matchesLeaderPattern('*grok', 'grok\nevil')).toBe(false);
    expect(matchesLeaderPattern('x*', 'x\ny')).toBe(true);
    expect(matchesLeaderPattern('x?y', 'x\ny')).toBe(true);
    expect(matchesLeaderPattern('grok*', 'evil\ngrok')).toBe(false);
  });

  it('collapses consecutive stars', () => {
    expect(matchesLeaderPattern('a**b', 'ab')).toBe(true);
    expect(matchesLeaderPattern('a**b', 'axxb')).toBe(true);
    expect(matchesLeaderPattern('a**b', 'axxbc')).toBe(false);
    expect(matchesLeaderPattern('***', '')).toBe(true);
  });

  it('handles patterns that start and end with *', () => {
    expect(matchesLeaderPattern('*lead*', 'lead')).toBe(true);
    expect(matchesLeaderPattern('*lead*', 'team-lead-1')).toBe(true);
    expect(matchesLeaderPattern('*lead*', 'leda')).toBe(false);
    expect(matchesLeaderPattern('*a?c*', 'xxabcyy')).toBe(true);
    expect(matchesLeaderPattern('*a?c*', 'xxacyy')).toBe(false);
  });

  it('matches the empty name only against star-only patterns', () => {
    expect(matchesLeaderPattern('*', '')).toBe(true);
    expect(matchesLeaderPattern('?', '')).toBe(false);
    expect(matchesLeaderPattern('a*', '')).toBe(false);
  });

  it('does not backtrack catastrophically on adversarial patterns', () => {
    const name = 'a'.repeat(60);
    const started = performance.now();
    expect(matchesLeaderPattern('*a'.repeat(30) + 'b', name)).toBe(false);
    expect(matchesLeaderPattern('*a'.repeat(30), name)).toBe(true);
    expect(leaderMatcher(['*a'.repeat(30) + 'b'])(name)).toBe(false);
    expect(leaderMatcher(['*a'.repeat(30) + 'b', '*a'.repeat(30)])(name)).toBe(true);
    // Worst case within the stored limits: 128-char pattern vs a long name.
    expect(matchesLeaderPattern('*a'.repeat(63) + 'b', 'a'.repeat(4096))).toBe(false);
    expect(matchesLeaderPattern('*a'.repeat(60) + 'b', 'a'.repeat(10000))).toBe(false);
    expect(matchesLeaderPattern('*a'.repeat(60), 'a'.repeat(10000))).toBe(true);
    // Generous bound: CI and shared hosts run loaded; the real work is microseconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('combines exact names and globs', () => {
    const matches = leaderMatcher(['admin', '*grok', 'lead-?']);
    expect(['admin', 'opsgrok', 'lead-1', 'lead-12', 'bob'].filter(matches))
      .toEqual(['admin', 'opsgrok', 'lead-1']);
    expect(leaderMatcher([])('admin')).toBe(false);
  });
});

describe('normalizeLeaderPatterns', () => {
  it('trims, dedupes in first-seen order, and accepts an empty list', () => {
    expect(normalizeLeaderPatterns([' *grok ', 'admin', '*grok', 'admin'])).toEqual({
      ok: true,
      patterns: ['*grok', 'admin'],
    });
    expect(normalizeLeaderPatterns([])).toEqual({ ok: true, patterns: [] });
  });

  it(`accepts up to ${MAX_LEADER_PATTERNS} entries and 128 characters`, () => {
    const max = Array.from({ length: MAX_LEADER_PATTERNS }, (_, i) => `agent-${i}`);
    expect(normalizeLeaderPatterns(max)).toEqual({ ok: true, patterns: max });
    expect(normalizeLeaderPatterns(['a'.repeat(128)]).ok).toBe(true);
    // The length limit counts code points, so astral characters count once.
    expect(normalizeLeaderPatterns(['😀'.repeat(128)])).toEqual({ ok: true, patterns: ['😀'.repeat(128)] });
    expect(normalizeLeaderPatterns(['😀'.repeat(129)]).ok).toBe(false);
    // Duplicates still count toward the raw entry limit.
    expect(normalizeLeaderPatterns(Array.from({ length: MAX_LEADER_PATTERNS + 1 }, () => 'a')).ok).toBe(false);
  });

  it.each([
    ['not an array', 'admin'],
    ['null', null],
    ['an object', { patterns: ['a'] }],
    ['a non-string entry', ['admin', 3]],
    ['an empty entry', ['']],
    ['a whitespace-only entry', ['   ']],
    ['an entry over 128 characters', ['a'.repeat(129)]],
    ['a control character', ['ad\u0000min']],
    ['an embedded newline', ['ad\nmin']],
    ['a DEL character', ['ad\u007fmin']],
    ['too many entries', Array.from({ length: MAX_LEADER_PATTERNS + 1 }, (_, i) => `a${i}`)],
  ])('rejects %s', (_label, value) => {
    expect(normalizeLeaderPatterns(value).ok).toBe(false);
  });
});
