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

export function registerReadCommands(program: Command): void {
  program
    .command('messages <channel>')
    .description('List messages in a channel')
    .option('--limit <n>', 'Message limit', '50')
    .action(async (channel: string, opts: { limit: string }) => {
      const agent = getAgent();
      const msgs = await agent.messages(channel, { limit: parseInt(opts.limit, 10) });
      if (msgs.length === 0) {
        console.log('No messages.');
        return;
      }
      for (const m of msgs) {
        console.log(`[${m.id}] ${m.agent_name}: ${m.text}`);
      }
    });

  program
    .command('thread <msg_id>')
    .description('Show thread for a message')
    .action(async (msgId: string) => {
      const agent = getAgent();
      const result = await agent.thread(msgId);
      console.log(`[${result.parent.id}] ${result.parent.agent_name}: ${result.parent.text}`);
      for (const r of result.replies) {
        console.log(`  [${r.id}] ${r.agent_name}: ${r.text}`);
      }
    });

  program
    .command('inbox')
    .description('Show inbox')
    .action(async () => {
      const agent = getAgent();
      const inbox = await agent.inbox();
      console.log(JSON.stringify(inbox, null, 2));
    });

  program
    .command('dms <agent>')
    .description('Show DMs with an agent')
    .action(async (agentName: string) => {
      const agent = getAgent();
      const convos = await agent.dms.conversations();
      const convo = convos.find(
        (c) => c.participants?.some((p) => p === agentName) ?? false,
      );
      if (!convo) {
        console.log(`No DM conversation found with ${agentName}`);
        return;
      }
      const msgs = await agent.dms.messages(convo.id);
      for (const m of msgs) {
        console.log(`[${m.id}] ${m.agent_name}: ${m.text}`);
      }
    });

  program
    .command('readers <msg_id>')
    .description('Show who read a message')
    .action(async (msgId: string) => {
      const agent = getAgent();
      const readers = await agent.readers(msgId);
      if (readers.length === 0) {
        console.log('No readers yet.');
        return;
      }
      for (const r of readers) {
        console.log(`${r.agent_name} — read at ${r.read_at}`);
      }
    });
}
