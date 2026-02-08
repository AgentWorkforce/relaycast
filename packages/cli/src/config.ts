import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RelayConfig {
  apiKey?: string;
  agentToken?: string;
  endpoint?: string;
}

export function getConfigPath(): string {
  return path.join(os.homedir(), '.relay', 'config.json');
}

export function loadConfig(): RelayConfig {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as RelayConfig;
    return {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return {};
    throw err;
  }
}

export function saveConfig(config: RelayConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

