import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

describe('config helpers and config command', () => {
  let homeDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    homeDir = fs.mkdtempSync(path.join(process.cwd(), 'relay-cli-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env.HOME = prevHome;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('loadConfig returns {} when missing, and saveConfig persists config', async () => {
    const { loadConfig, saveConfig, getConfigPath } = await import('../config.js');

    expect(loadConfig()).toEqual({});

    saveConfig({ apiKey: 'rk_test', endpoint: 'https://example.test' });
    expect(fs.existsSync(getConfigPath())).toBe(true);
    expect(loadConfig()).toEqual({ apiKey: 'rk_test', endpoint: 'https://example.test' });
  });

  it('relay config set <key> <value> writes to ~/.relay/config.json', async () => {
    const { registerConfigCommands } = await import('../commands/config.js');
    const { loadConfig, getConfigPath } = await import('../config.js');

    const program = new Command().exitOverride();
    registerConfigCommands(program);

    await program.parseAsync(['config', 'set', 'api-key', 'rk_test'], { from: 'user' });
    await program.parseAsync(['config', 'set', 'endpoint', 'https://example.test'], {
      from: 'user',
    });

    expect(fs.existsSync(getConfigPath())).toBe(true);
    expect(loadConfig()).toEqual({ apiKey: 'rk_test', endpoint: 'https://example.test' });

    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    expect(raw).toContain('"apiKey": "rk_test"');
  });
});
