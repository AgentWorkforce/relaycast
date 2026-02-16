import { Command } from 'commander';
import { RelayCast } from '@relaycast/sdk';
import { loadConfig } from '../config.js';

function getAgent() {
  const config = loadConfig();
  if (!config.apiKey) {
    throw new Error('No API key configured. Run: relay config set api-key <key>');
  }
  if (!config.agentToken) {
    throw new Error('No agent token configured. Run: relay config set agent-token <token>');
  }
  const relay = new RelayCast({ apiKey: config.apiKey, baseUrl: config.endpoint });
  return relay.as(config.agentToken);
}

export function registerSearchCommands(program: Command): void {
  program
    .command('search <query>')
    .description('Search messages')
    .option('--channel <channel>', 'Filter by channel')
    .action(async (query: string, opts: { channel?: string }) => {
      const agent = getAgent();
      const results = await agent.search(query, { channel: opts.channel });
      if (results.length === 0) {
        console.log('No results.');
        return;
      }
      for (const r of results) {
        console.log(JSON.stringify(r));
      }
    });
}
