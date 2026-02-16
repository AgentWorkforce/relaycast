import { describe, it, expect } from 'vitest';
import { SDK_VERSION } from '../index.js';

describe('@relaycast/sdk', () => {
  it('exports SDK_VERSION', () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

