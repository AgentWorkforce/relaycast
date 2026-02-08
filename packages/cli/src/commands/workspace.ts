import { Command } from 'commander';
import { Relay } from '@agent-relay/sdk';

import { loadConfig } from '../config.js';

function createRelay(): Relay {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    throw new Error('Missing API key. Run: relay config set api-key <value>');
  }
  return new Relay({ apiKey: cfg.apiKey, baseUrl: cfg.endpoint });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function registerWorkspaceCommands(program: Command): void {
  const ws = program.command('workspace').description('Workspace management');

  ws.command('create <name>')
    .description('Create workspace (updates current workspace name)')
    .action(async (name: string) => {
      const relay = createRelay();
      const workspace = await relay.workspace.update({ name });
      printJson(workspace);
    });

  ws.command('info')
    .description('Show workspace info')
    .action(async () => {
      const relay = createRelay();
      const workspace = await relay.workspace.info();
      printJson(workspace);
    });

  ws.command('delete')
    .description('Delete workspace')
    .action(() => {
      console.log('Workspace deletion must be done via the dashboard.');
    });
}

