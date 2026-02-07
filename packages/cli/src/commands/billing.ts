import { Command } from 'commander';
import { Relay } from '@agent-relay/sdk';
import { loadConfig } from '../config.js';

function getRelay(): Relay {
  const config = loadConfig();
  if (!config.apiKey) {
    throw new Error('No API key configured. Run: relay config set api-key <key>');
  }
  return new Relay({ apiKey: config.apiKey, baseUrl: config.endpoint });
}

export function registerBillingCommands(program: Command): void {
  const billing = program.command('billing').description('Billing management');

  billing
    .command('usage')
    .description('Show usage info')
    .action(async () => {
      const relay = getRelay();
      const usage = await relay.billing.usage();
      console.log(JSON.stringify(usage, null, 2));
    });

  billing
    .command('subscription')
    .description('Show subscription info')
    .action(async () => {
      const relay = getRelay();
      const sub = await relay.billing.subscription();
      console.log(JSON.stringify(sub, null, 2));
    });

  billing
    .command('portal')
    .description('Get billing portal URL')
    .action(async () => {
      const relay = getRelay();
      const result = await relay.billing.portal();
      console.log(`Billing portal: ${result.url}`);
    });
}
