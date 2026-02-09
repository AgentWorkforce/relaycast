import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

describe('mcp-install', () => {
  let tmpDir: string;
  let prevHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'relay-mcp-test-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpDir;
    prevCwd = process.cwd();
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /* ------------------------------------------------------------------ */
  /*  detectInstalledTools                                               */
  /* ------------------------------------------------------------------ */

  describe('detectInstalledTools', () => {
    it('returns empty when no tool directories exist', async () => {
      const { detectInstalledTools } = await import('../mcp-install.js');
      expect(detectInstalledTools()).toEqual([]);
    });

    it('detects Claude Code when ~/.claude exists', async () => {
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      const { detectInstalledTools } = await import('../mcp-install.js');
      const detected = detectInstalledTools();
      expect(detected.some((a) => a.id === 'claude')).toBe(true);
    });

    it('detects Cursor when ~/.cursor exists', async () => {
      fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
      const { detectInstalledTools } = await import('../mcp-install.js');
      const detected = detectInstalledTools();
      expect(detected.some((a) => a.id === 'cursor')).toBe(true);
    });

    it('detects Codex CLI when ~/.codex exists', async () => {
      fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
      const { detectInstalledTools } = await import('../mcp-install.js');
      const detected = detectInstalledTools();
      expect(detected.some((a) => a.id === 'codex')).toBe(true);
    });

    it('detects Gemini CLI when ~/.gemini exists', async () => {
      fs.mkdirSync(path.join(tmpDir, '.gemini'), { recursive: true });
      const { detectInstalledTools } = await import('../mcp-install.js');
      const detected = detectInstalledTools();
      expect(detected.some((a) => a.id === 'gemini')).toBe(true);
    });

    it('detects Windsurf when ~/.codeium/windsurf exists', async () => {
      fs.mkdirSync(path.join(tmpDir, '.codeium', 'windsurf'), { recursive: true });
      const { detectInstalledTools } = await import('../mcp-install.js');
      const detected = detectInstalledTools();
      expect(detected.some((a) => a.id === 'windsurf')).toBe(true);
    });

    it('detects Windsurf when ~/.windsurf exists', async () => {
      fs.mkdirSync(path.join(tmpDir, '.windsurf'), { recursive: true });
      const { detectInstalledTools } = await import('../mcp-install.js');
      const detected = detectInstalledTools();
      expect(detected.some((a) => a.id === 'windsurf')).toBe(true);
    });

    it('detects multiple tools at once', async () => {
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
      const { detectInstalledTools } = await import('../mcp-install.js');
      const detected = detectInstalledTools();
      expect(detected.length).toBe(3);
      const ids = detected.map((a) => a.id);
      expect(ids).toContain('claude');
      expect(ids).toContain('cursor');
      expect(ids).toContain('codex');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  installForTool                                                     */
  /* ------------------------------------------------------------------ */

  describe('installForTool', () => {
    it('installs Claude Code config at user scope', async () => {
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('claude')!;
      const result = installForTool(adapter, { apiKey: 'rk_test_abc' });

      expect(result.status).toBe('installed');
      expect(result.configPath).toContain('.claude');

      const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
      expect(config.mcpServers.relaycast).toEqual({
        command: 'npx',
        args: ['-y', '@relaycast/mcp'],
        env: { RELAY_API_KEY: 'rk_test_abc' },
      });
    });

    it('installs Cursor config', async () => {
      fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('cursor')!;
      const result = installForTool(adapter, { apiKey: 'rk_test_abc' });

      expect(result.status).toBe('installed');
      const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
      expect(config.mcpServers.relaycast.command).toBe('npx');
    });

    it('installs Codex CLI config', async () => {
      fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('codex')!;
      const result = installForTool(adapter, { apiKey: 'rk_test_abc' });

      expect(result.status).toBe('installed');
      const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
      expect(config.mcpServers.relaycast.env.RELAY_API_KEY).toBe('rk_test_abc');
    });

    it('installs Gemini CLI config', async () => {
      fs.mkdirSync(path.join(tmpDir, '.gemini'), { recursive: true });
      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('gemini')!;
      const result = installForTool(adapter, { apiKey: 'rk_test_abc' });

      expect(result.status).toBe('installed');
      const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
      expect(config.mcpServers.relaycast).toBeDefined();
    });

    it('includes baseUrl in env when provided', async () => {
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('claude')!;
      const result = installForTool(adapter, {
        apiKey: 'rk_test_abc',
        baseUrl: 'https://custom.example.com',
      });

      expect(result.status).toBe('installed');
      const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
      expect(config.mcpServers.relaycast.env.RELAY_BASE_URL).toBe(
        'https://custom.example.com',
      );
    });

    it('preserves existing config keys when merging', async () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const configPath = path.join(claudeDir, 'settings.local.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { other: { command: 'other-cmd', args: [] } },
          customKey: true,
        }),
      );

      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('claude')!;
      const result = installForTool(adapter, { apiKey: 'rk_test_abc' });

      expect(result.status).toBe('installed');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.mcpServers.relaycast).toBeDefined();
      expect(config.mcpServers.other.command).toBe('other-cmd');
      expect(config.customKey).toBe(true);
    });

    it('returns already-configured when relaycast entry exists', async () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const configPath = path.join(claudeDir, 'settings.local.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { relaycast: { command: 'npx', args: ['@relaycast/mcp'] } },
        }),
      );

      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('claude')!;
      const result = installForTool(adapter, { apiKey: 'rk_test_abc' });

      expect(result.status).toBe('already-configured');
    });

    it('installs at project scope', async () => {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      process.chdir(projectDir);

      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('claude')!;
      const result = installForTool(adapter, {
        apiKey: 'rk_test_abc',
        scope: 'project',
      });

      expect(result.status).toBe('installed');
      expect(result.configPath).toContain(projectDir);
      expect(fs.existsSync(result.configPath)).toBe(true);
    });

    it('creates parent directories if missing', async () => {
      // Don't pre-create ~/.codex — installForTool should create the config dir
      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('codex')!;
      const result = installForTool(adapter, { apiKey: 'rk_test_abc' });

      expect(result.status).toBe('installed');
      expect(fs.existsSync(result.configPath)).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  VS Code adapter specifics                                         */
  /* ------------------------------------------------------------------ */

  describe('VS Code adapter', () => {
    it('uses "servers" key with type: "stdio"', async () => {
      // Create the VS Code user dir for detection
      const platform = process.platform;
      let vsDir: string;
      if (platform === 'darwin') {
        vsDir = path.join(tmpDir, 'Library', 'Application Support', 'Code', 'User');
      } else {
        vsDir = path.join(tmpDir, '.config', 'Code', 'User');
      }
      fs.mkdirSync(vsDir, { recursive: true });

      const { installForTool, getAdapterById } = await import('../mcp-install.js');
      const adapter = getAdapterById('vscode')!;
      const result = installForTool(adapter, { apiKey: 'rk_test_abc' });

      expect(result.status).toBe('installed');
      const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
      expect(config.servers.relaycast.type).toBe('stdio');
      expect(config.servers.relaycast.command).toBe('npx');
      expect(config.servers.relaycast.env.RELAY_API_KEY).toBe('rk_test_abc');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  installMcp (orchestrator)                                         */
  /* ------------------------------------------------------------------ */

  describe('installMcp', () => {
    it('installs for all detected tools', async () => {
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
      const { installMcp } = await import('../mcp-install.js');

      const results = installMcp({ apiKey: 'rk_test_abc' });
      expect(results.length).toBe(2);
      expect(results.every((r) => r.status === 'installed')).toBe(true);
    });

    it('returns error when no tools detected and no tool specified', async () => {
      const { installMcp } = await import('../mcp-install.js');
      const results = installMcp({ apiKey: 'rk_test_abc' });
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('error');
      expect(results[0].message).toContain('No supported AI tools detected');
    });

    it('installs for a specific tool even if not detected', async () => {
      const { installMcp } = await import('../mcp-install.js');
      const results = installMcp({ apiKey: 'rk_test_abc', tool: 'claude' });
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('installed');
    });

    it('returns error for unknown tool name', async () => {
      const { installMcp } = await import('../mcp-install.js');
      const results = installMcp({ apiKey: 'rk_test_abc', tool: 'unknown' });
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('error');
      expect(results[0].message).toContain('Unknown tool');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  CLI command                                                        */
  /* ------------------------------------------------------------------ */

  describe('mcp command', () => {
    it('registers install and status subcommands', async () => {
      const { registerMcpCommands } = await import('../commands/mcp.js');
      const program = new Command().exitOverride();
      registerMcpCommands(program);

      const mcpCmd = program.commands.find((c) => c.name() === 'mcp');
      expect(mcpCmd).toBeDefined();

      const subNames = mcpCmd!.commands.map((c) => c.name());
      expect(subNames).toContain('install');
      expect(subNames).toContain('status');
    });

    it('mcp install requires an API key', async () => {
      const { registerMcpCommands } = await import('../commands/mcp.js');
      const program = new Command().exitOverride();
      registerMcpCommands(program);

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await program.parseAsync(['mcp', 'install'], { from: 'user' });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('Missing API key'),
      );
      spy.mockRestore();
    });

    it('mcp install --key installs for detected tools', async () => {
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      const { registerMcpCommands } = await import('../commands/mcp.js');
      const program = new Command().exitOverride();
      registerMcpCommands(program);

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['mcp', 'install', '--key', 'rk_test_abc'], {
        from: 'user',
      });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Claude Code'));
      spy.mockRestore();
    });

    it('mcp status lists detected tools', async () => {
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
      const { registerMcpCommands } = await import('../commands/mcp.js');
      const program = new Command().exitOverride();
      registerMcpCommands(program);

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await program.parseAsync(['mcp', 'status'], { from: 'user' });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Claude Code'));
      spy.mockRestore();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  getAdapterById                                                     */
  /* ------------------------------------------------------------------ */

  describe('getAdapterById', () => {
    it('returns adapter for valid id', async () => {
      const { getAdapterById } = await import('../mcp-install.js');
      expect(getAdapterById('claude')?.displayName).toBe('Claude Code');
      expect(getAdapterById('cursor')?.displayName).toBe('Cursor');
      expect(getAdapterById('codex')?.displayName).toBe('Codex CLI');
      expect(getAdapterById('gemini')?.displayName).toBe('Gemini CLI');
      expect(getAdapterById('windsurf')?.displayName).toBe('Windsurf');
      expect(getAdapterById('vscode')?.displayName).toBe('VS Code');
    });

    it('returns undefined for unknown id', async () => {
      const { getAdapterById } = await import('../mcp-install.js');
      expect(getAdapterById('unknown')).toBeUndefined();
    });
  });
});
