import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs modules before importing config
const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}));

import { detectOpenClaw, loadOpenClawConfig } from '../config.js';

describe('detectOpenClaw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects when openclaw is not installed', async () => {
    mocks.existsSync.mockReturnValue(false);

    const result = await detectOpenClaw();

    expect(result.installed).toBe(false);
    expect(result.configDir).toBe('/home/testuser/.openclaw');
    expect(result.configFile).toBeNull();
    expect(result.config).toBeNull();
  });

  it('detects installed openclaw with config', async () => {
    mocks.existsSync.mockImplementation((path: string) => {
      if (path === '/home/testuser/.openclaw') return true;
      if (path === '/home/testuser/.openclaw/openclaw.json') return true;
      return false;
    });

    const config = { agent: { model: 'anthropic/claude-opus-4-6' } };
    mocks.readFile.mockResolvedValue(JSON.stringify(config));

    const result = await detectOpenClaw();

    expect(result.installed).toBe(true);
    expect(result.configFile).toBe('/home/testuser/.openclaw/openclaw.json');
    expect(result.config).toEqual(config);
    expect(result.workspaceDir).toBe('/home/testuser/.openclaw/workspace');
  });

  it('handles invalid JSON config gracefully', async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFile.mockResolvedValue('not json{{{');

    const result = await detectOpenClaw();

    expect(result.installed).toBe(true);
    expect(result.configFile).toBe('/home/testuser/.openclaw/openclaw.json');
    expect(result.config).toBeNull();
  });
});

describe('loadOpenClawConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when openclaw not installed', async () => {
    mocks.existsSync.mockReturnValue(false);

    const config = await loadOpenClawConfig();
    expect(config).toBeNull();
  });

  it('returns parsed config when available', async () => {
    mocks.existsSync.mockReturnValue(true);

    const expected = { agent: { model: 'anthropic/claude-opus-4-6' } };
    mocks.readFile.mockResolvedValue(JSON.stringify(expected));

    const config = await loadOpenClawConfig();
    expect(config).toEqual(expected);
  });
});
