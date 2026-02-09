import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface McpInstallOptions {
  apiKey: string;
  baseUrl?: string;
  /** Install for a specific tool only. */
  tool?: string;
  /** 'project' (default) or 'user'. */
  scope?: 'user' | 'project';
}

export interface InstallResult {
  tool: string;
  configPath: string;
  status: 'installed' | 'already-configured' | 'error';
  message: string;
}

interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ToolAdapter {
  /** Short identifier (e.g. 'claude', 'cursor'). */
  id: string;
  /** Human-readable name. */
  displayName: string;
  /** Check if the tool appears to be installed. */
  detect(): boolean;
  /** Config file path for the given scope. */
  configPath(scope: 'user' | 'project'): string;
  /** Read existing config, merge in the relaycast server, return the full object. */
  mergeConfig(existing: Record<string, unknown>, entry: McpServerEntry): Record<string, unknown>;
  /** Check whether relaycast is already configured. */
  isConfigured(existing: Record<string, unknown>): boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return {};
    throw err;
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function buildServerEntry(options: McpInstallOptions): McpServerEntry {
  const env: Record<string, string> = { RELAY_API_KEY: options.apiKey };
  if (options.baseUrl) {
    env.RELAY_BASE_URL = options.baseUrl;
  }
  return { command: 'npx', args: ['-y', '@relaycast/mcp'], env };
}

function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Standard mcpServers adapter (shared by most tools)                 */
/* ------------------------------------------------------------------ */

function mcpServersMerge(
  existing: Record<string, unknown>,
  entry: McpServerEntry,
): Record<string, unknown> {
  const servers = (existing.mcpServers as Record<string, unknown>) ?? {};
  return { ...existing, mcpServers: { ...servers, relaycast: entry } };
}

function mcpServersConfigured(existing: Record<string, unknown>): boolean {
  const servers = existing.mcpServers as Record<string, unknown> | undefined;
  return !!servers && 'relaycast' in servers;
}

/* ------------------------------------------------------------------ */
/*  Tool adapters                                                      */
/* ------------------------------------------------------------------ */

const home = os.homedir();

const claudeAdapter: ToolAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  detect: () => dirExists(path.join(home, '.claude')),
  configPath: (scope) =>
    scope === 'project'
      ? path.join(process.cwd(), '.claude', 'settings.local.json')
      : path.join(home, '.claude', 'settings.local.json'),
  mergeConfig: mcpServersMerge,
  isConfigured: mcpServersConfigured,
};

const cursorAdapter: ToolAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  detect: () => dirExists(path.join(home, '.cursor')),
  configPath: (scope) =>
    scope === 'project'
      ? path.join(process.cwd(), '.cursor', 'mcp.json')
      : path.join(home, '.cursor', 'mcp.json'),
  mergeConfig: mcpServersMerge,
  isConfigured: mcpServersConfigured,
};

const windsurf: ToolAdapter = {
  id: 'windsurf',
  displayName: 'Windsurf',
  detect: () =>
    dirExists(path.join(home, '.codeium', 'windsurf')) ||
    dirExists(path.join(home, '.windsurf')),
  configPath: (scope) => {
    if (scope === 'project') {
      return path.join(process.cwd(), '.windsurf', 'mcp.json');
    }
    // Prefer newer ~/.windsurf location, fall back to ~/.codeium/windsurf
    if (dirExists(path.join(home, '.windsurf'))) {
      return path.join(home, '.windsurf', 'mcp.json');
    }
    return path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
  },
  mergeConfig: mcpServersMerge,
  isConfigured: mcpServersConfigured,
};

const codexAdapter: ToolAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  detect: () => dirExists(path.join(home, '.codex')),
  configPath: (scope) =>
    scope === 'project'
      ? path.join(process.cwd(), '.codex', 'mcp.json')
      : path.join(home, '.codex', 'mcp.json'),
  mergeConfig: mcpServersMerge,
  isConfigured: mcpServersConfigured,
};

const geminiAdapter: ToolAdapter = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  detect: () => dirExists(path.join(home, '.gemini')),
  configPath: (scope) =>
    scope === 'project'
      ? path.join(process.cwd(), '.gemini', 'settings.json')
      : path.join(home, '.gemini', 'settings.json'),
  mergeConfig: mcpServersMerge,
  isConfigured: mcpServersConfigured,
};

function getVSCodeUserDir(): string | null {
  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  if (platform === 'linux') {
    return path.join(home, '.config', 'Code', 'User');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'Code', 'User');
  }
  return null;
}

const vscodeAdapter: ToolAdapter = {
  id: 'vscode',
  displayName: 'VS Code',
  detect: () => {
    const userDir = getVSCodeUserDir();
    return !!userDir && dirExists(userDir);
  },
  configPath: (scope) => {
    if (scope === 'project') {
      return path.join(process.cwd(), '.vscode', 'mcp.json');
    }
    const userDir = getVSCodeUserDir();
    if (userDir) return path.join(userDir, 'mcp.json');
    // Fallback: project-level
    return path.join(process.cwd(), '.vscode', 'mcp.json');
  },
  mergeConfig: (existing, entry) => {
    const servers = (existing.servers as Record<string, unknown>) ?? {};
    return {
      ...existing,
      servers: { ...servers, relaycast: { type: 'stdio', ...entry } },
    };
  },
  isConfigured: (existing) => {
    const servers = existing.servers as Record<string, unknown> | undefined;
    return !!servers && 'relaycast' in servers;
  },
};

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

export const TOOL_ADAPTERS: ToolAdapter[] = [
  claudeAdapter,
  cursorAdapter,
  windsurf,
  codexAdapter,
  geminiAdapter,
  vscodeAdapter,
];

export function getAdapterById(id: string): ToolAdapter | undefined {
  return TOOL_ADAPTERS.find((a) => a.id === id);
}

/* ------------------------------------------------------------------ */
/*  Core install logic                                                 */
/* ------------------------------------------------------------------ */

export function detectInstalledTools(): ToolAdapter[] {
  return TOOL_ADAPTERS.filter((a) => a.detect());
}

export function installForTool(
  adapter: ToolAdapter,
  options: McpInstallOptions,
): InstallResult {
  const scope = options.scope ?? 'project';
  const configPath = adapter.configPath(scope);
  const entry = buildServerEntry(options);

  try {
    const existing = readJsonFile(configPath);

    if (adapter.isConfigured(existing)) {
      return {
        tool: adapter.displayName,
        configPath,
        status: 'already-configured',
        message: `Relaycast already configured in ${configPath}`,
      };
    }

    const merged = adapter.mergeConfig(existing, entry);
    writeJsonFile(configPath, merged);

    return {
      tool: adapter.displayName,
      configPath,
      status: 'installed',
      message: `Relaycast MCP server added to ${configPath}`,
    };
  } catch (err) {
    return {
      tool: adapter.displayName,
      configPath,
      status: 'error',
      message: `Failed to configure ${adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function installMcp(options: McpInstallOptions): InstallResult[] {
  const scope = options.scope ?? 'project';
  const results: InstallResult[] = [];

  // If a specific tool is requested, use only that adapter
  if (options.tool) {
    const adapter = getAdapterById(options.tool);
    if (!adapter) {
      return [
        {
          tool: options.tool,
          configPath: '',
          status: 'error',
          message: `Unknown tool "${options.tool}". Available: ${TOOL_ADAPTERS.map((a) => a.id).join(', ')}`,
        },
      ];
    }
    results.push(installForTool(adapter, { ...options, scope }));
    return results;
  }

  // Auto-detect installed tools
  const detected = detectInstalledTools();
  if (detected.length === 0) {
    return [
      {
        tool: 'none',
        configPath: '',
        status: 'error',
        message:
          'No supported AI tools detected. Install one of: Claude Code, Cursor, Windsurf, Codex CLI, Gemini CLI, VS Code',
      },
    ];
  }

  for (const adapter of detected) {
    results.push(installForTool(adapter, { ...options, scope }));
  }

  return results;
}
