import { describe, it, expect } from 'vitest';
import { SDK_VERSION } from '../index.js';

describe('@agent-relay/sdk', () => {
  it('exports SDK_VERSION', () => {
    expect(SDK_VERSION).toBe('0.1.0');
  });
});

