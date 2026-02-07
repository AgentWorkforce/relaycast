import { Command } from 'commander';

import { loadConfig, saveConfig } from '../config.js';

type ConfigKey = 'api-key' | 'agent-token' | 'endpoint';

function setConfigValue(key: ConfigKey, value: string): void {
  const cfg = loadConfig();
  if (key === 'api-key') cfg.apiKey = value;
  if (key === 'agent-token') cfg.agentToken = value;
  if (key === 'endpoint') cfg.endpoint = value;
  saveConfig(cfg);
}

export function registerConfigCommands(program: Command): void {
  const cfg = program.command('config').description('CLI configuration');

  cfg.command('set <key> <value>')
    .description('Set a config value (api-key, agent-token, endpoint)')
    .action((key: string, value: string) => {
      if (key !== 'api-key' && key !== 'agent-token' && key !== 'endpoint') {
        throw new Error(`Invalid key: ${key}. Expected one of: api-key, agent-token, endpoint`);
      }
      setConfigValue(key, value);
    });
}

