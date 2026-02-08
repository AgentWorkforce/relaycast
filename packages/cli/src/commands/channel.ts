import { Command } from 'commander';
import { Relay } from '@relaycast/sdk';
import { loadConfig } from '../config.js';

function getAgent() {
  const config = loadConfig();
  if (!config.apiKey) {
    throw new Error('No API key configured. Run: relay config set api-key <key>');
  }
  if (!config.agentToken) {
    throw new Error('No agent token configured. Run: relay config set agent-token <token>');
  }
  const relay = new Relay({ apiKey: config.apiKey, baseUrl: config.endpoint });
  return relay.as(config.agentToken);
}

export function registerChannelCommands(program: Command): void {
  const ch = program.command('channel').description('Channel management');

  ch.command('create <name>')
    .description('Create a channel')
    .option('--topic <topic>', 'Channel topic')
    .action(async (name: string, opts: { topic?: string }) => {
      const agent = getAgent();
      const channel = await agent.channels.create({ name, topic: opts.topic });
      console.log(`Channel created: #${channel.name}`);
    });

  ch.command('list')
    .description('List channels')
    .action(async () => {
      const agent = getAgent();
      const channels = await agent.channels.list();
      if (channels.length === 0) {
        console.log('No channels.');
        return;
      }
      for (const c of channels) {
        const topic = c.topic ? ` — ${c.topic}` : '';
        console.log(`#${c.name}${topic}`);
      }
    });

  ch.command('join <name>')
    .description('Join a channel')
    .action(async (name: string) => {
      const agent = getAgent();
      await agent.channels.join(name);
      console.log(`Joined #${name}`);
    });

  ch.command('leave <name>')
    .description('Leave a channel')
    .action(async (name: string) => {
      const agent = getAgent();
      await agent.channels.leave(name);
      console.log(`Left #${name}`);
    });

  ch.command('topic <name> <topic>')
    .description('Set channel topic')
    .action(async (name: string, topic: string) => {
      const agent = getAgent();
      await agent.channels.setTopic(name, topic);
      console.log(`Topic set for #${name}: ${topic}`);
    });

  ch.command('archive <name>')
    .description('Archive a channel')
    .action(async (name: string) => {
      const agent = getAgent();
      await agent.channels.archive(name);
      console.log(`Archived #${name}`);
    });
}
