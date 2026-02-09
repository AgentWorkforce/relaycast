import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  readFile: mocks.readFile,
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}));

import { setupSkill } from '../setup.js';

describe('setupSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it('creates skill directory and writes files', async () => {
    // OpenClaw installed but no config file
    mocks.existsSync.mockImplementation((path: string) => {
      if (path === '/home/testuser/.openclaw') return true;
      return false;
    });

    const result = await setupSkill({
      apiKey: 'rk_test_abc',
      clawName: 'home-claw',
    });

    expect(result.ok).toBe(true);
    expect(result.skillDir).toBe('/home/testuser/.openclaw/workspace/relaycast');

    // Should create directory
    expect(mocks.mkdir).toHaveBeenCalledWith(
      '/home/testuser/.openclaw/workspace/relaycast',
      { recursive: true },
    );

    // Should write SKILL.md
    const skillMdCall = mocks.writeFile.mock.calls.find(
      (c: string[]) => c[0].endsWith('SKILL.md'),
    );
    expect(skillMdCall).toBeDefined();
    expect(skillMdCall[1]).toContain('Relaycast');
    expect(skillMdCall[1]).toContain('npx relaycast send');

    // Should write .env with correct values
    const envCall = mocks.writeFile.mock.calls.find(
      (c: string[]) => c[0].endsWith('.env'),
    );
    expect(envCall).toBeDefined();
    expect(envCall[1]).toContain('rk_test_abc');
    expect(envCall[1]).toContain('home-claw');
  });

  it('adds MCP config to openclaw.json when present', async () => {
    const existingConfig = { agent: { model: 'anthropic/claude-opus-4-6' } };

    mocks.existsSync.mockReturnValue(true);
    mocks.readFile.mockResolvedValue(JSON.stringify(existingConfig));

    await setupSkill({
      apiKey: 'rk_test_xyz',
      clawName: 'dev-claw',
    });

    // Should have written updated config
    const configCall = mocks.writeFile.mock.calls.find(
      (c: string[]) => c[0].endsWith('openclaw.json'),
    );
    expect(configCall).toBeDefined();
    const written = JSON.parse(configCall[1]);
    expect(written.mcpServers.relaycast).toBeDefined();
    expect(written.mcpServers.relaycast.env.RELAY_API_KEY).toBe('rk_test_xyz');
  });

  it('defaults claw name to my-claw', async () => {
    mocks.existsSync.mockImplementation((path: string) => {
      if (path === '/home/testuser/.openclaw') return true;
      return false;
    });

    await setupSkill({ apiKey: 'rk_test_abc' });

    const envCall = mocks.writeFile.mock.calls.find(
      (c: string[]) => c[0].endsWith('.env'),
    );
    expect(envCall[1]).toContain('my-claw');
  });
});
