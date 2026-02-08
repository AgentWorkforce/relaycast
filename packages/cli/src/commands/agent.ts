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

function agentsTable(agents: Array<{ name: string; status?: string; persona?: string | null }>): string {
  const header = ['NAME', 'STATUS', 'PERSONA'].join('\t');
  const rows = agents.map((a) => [a.name, a.status ?? '', a.persona ?? ''].join('\t'));
  return [header, ...rows].join('\n');
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command('agent').description('Agent management');

  agent
    .command('register <name>')
    .description('Register a new agent')
    .option('--persona <persona>', 'Agent persona')
    .action(async (name: string, options: { persona?: string }) => {
      const relay = createRelay();
      const res = await relay.agents.register({ name, ...(options.persona ? { persona: options.persona } : {}) });
      console.log(res.token);
    });

  agent
    .command('list')
    .description('List agents')
    .action(async () => {
      const relay = createRelay();
      const agents = await relay.agents.list();
      console.log(agentsTable(agents));
    });

  agent
    .command('status <name> <status>')
    .description('Show current agent status (status updates not supported)')
    .action(async (name: string) => {
      const relay = createRelay();
      const a = await relay.agents.get(name);
      console.log(`${a.name}: ${a.status}`);
    });
}

