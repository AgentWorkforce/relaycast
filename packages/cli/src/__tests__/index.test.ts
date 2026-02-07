import { describe, it, expect } from 'vitest';
import { CLI_VERSION } from '../index.js';

describe('@agent-relay/cli', () => {
  it('exports CLI_VERSION', () => {
    expect(CLI_VERSION).toBe('0.1.0');
  });
});

