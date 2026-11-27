import { describe, expect, it } from 'vitest';
import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_PATTERN,
  canonicalizeAgentName,
  validateAgentName,
} from '../index.js';

describe('agent name validation and canonicalization', () => {
  it('accepts valid printable non-whitespace ASCII names and preserves display casing via canonical key', () => {
    for (const [name, canonical] of [
      ['alpha1', 'alpha1'],
      ['Alice', 'alice'],
      ['ops.lead', 'ops.lead'],
      ['dave@ops', 'dave@ops'],
      ['worker-1_beta', 'worker-1_beta'],
      ['a,b', 'a,b'],
      ['x'.repeat(AGENT_NAME_MAX_LENGTH), 'x'.repeat(AGENT_NAME_MAX_LENGTH)],
    ] as const) {
      expect(AGENT_NAME_PATTERN.test(name)).toBe(true);
      expect(validateAgentName(name)).toEqual({ ok: true, canonical });
    }
  });

  it('rejects empty, oversized, whitespace, control, invisible, bidi, and non-ASCII homoglyph names', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['a'.repeat(AGENT_NAME_MAX_LENGTH + 1), 'at most'],
      ['alpha1 ', 'whitespace'],
      [' alpha1', 'whitespace'],
      ['alpha 1', 'whitespace'],
      ['alpha1\u00a0', 'whitespace'],
      ['alpha1\t', 'control'],
      ['alpha1\n', 'control'],
      ['alpha1\u0000', 'control'],
      ['alpha1\u007f', 'control'],
      ['alph\u04301', 'printable ASCII'], // Cyrillic small letter a (U+0430)
      ['\u03b1lpha1', 'printable ASCII'], // Greek alpha (U+03B1)
      ['\uff41lpha1', 'printable ASCII'], // Fullwidth 'a'
      ['alpha1\u200b', 'printable ASCII'], // Zero-width space (U+200B)
      ['alpha1\ufeff', 'whitespace'], // BOM / ZWNBSP (matches Unicode whitespace)
      ['alpha\u202e1', 'printable ASCII'], // Right-to-left override
      ['e\u0301', 'printable ASCII'], // Combining acute accent
    ];
    for (const [input, expectedFragment] of cases) {
      const result = validateAgentName(input);
      expect(result.ok, `expected "${JSON.stringify(input)}" to be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(expectedFragment);
      }
    }
  });

  it('NFC-normalizes and lowercases in canonicalizeAgentName for downstream comparisons', () => {
    expect(canonicalizeAgentName('ALPHA1')).toBe('alpha1');
    expect(canonicalizeAgentName('Cafe\u0301')).toBe('caf\u00e9');
  });
});
