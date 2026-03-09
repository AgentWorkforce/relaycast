import { describe, it, expect } from 'vitest';
import { MultiWorkspaceSessionManager, SDK_VERSION } from '../index.js';

describe('@relaycast/sdk', () => {
  it('exports SDK_VERSION', () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exports MultiWorkspaceSessionManager', () => {
    expect(MultiWorkspaceSessionManager).toBeTypeOf('function');
  });
});
