import { AgentClient, HttpClient } from '@relaycast/sdk';
import { ZodError } from 'zod';
import { BuzzRoomBridge, type RelayPort } from './bridge.js';
import { BuzzSocket } from './buzz-socket.js';
import { parseConfig } from './config.js';
import { StateStore } from './state.js';

export async function runBuzzBridge(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config;
  try { config = parseConfig(env); }
  catch (error) {
    if (error instanceof ZodError) throw new Error(`Invalid bridge configuration: ${error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
    throw error;
  }
  const state = await StateStore.open(config.stateFile);
  const agent = new AgentClient(new HttpClient({ apiKey: config.relayToken, baseUrl: config.relayBaseUrl }));
  const me = await agent.me();
  if (me.name === config.targetAgent) throw new Error('The bridge identity and target agent must be different.');
  await state.bind(JSON.stringify([config.buzzUrl, config.channelId, config.pubkey, config.relayBaseUrl, config.targetAgent, me.id]));

  const relay: RelayPort = {
    dm: (to, text, options) => agent.dm(to, text, options),
    message: async (id) => {
      const value = await agent.message(id);
      return { id: value.id, agentName: value.agentName, text: value.text, threadId: value.threadId };
    },
    messages: async (conversationId, options) => {
      const values = await agent.dms.messages(conversationId, options);
      return values.map((value) => ({ id: value.id, agentName: value.agentName, text: value.text }));
    },
  };
  const buzz = new BuzzSocket(config.buzzUrl, config.channelId, config.secretKey, () => state.data.since);
  const bridge = new BuzzRoomBridge(config, state, relay, buzz);
  const stop = new AbortController();
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try { await bridge.replayPending(); await bridge.catchUp(); }
    finally { reconciling = false; }
  };
  const relayReply = (id: string) => {
    void bridge.receiveRelay(id).catch((error) => console.error(`Relay reply ${id}: ${String(error)}`));
  };
  agent.subscribe(['@self'], (event) => {
    if (event.message.agentName === config.targetAgent) relayReply(event.message.id);
  });
  agent.on.threadReply((event) => {
    if (event.message.agentName === config.targetAgent) relayReply(event.message.id);
  });
  agent.on.resynced(() => { void reconcile().catch((error) => console.error(`Relay reconciliation: ${String(error)}`)); });
  const timer = setInterval(() => {
    void reconcile().catch((error) => console.error(`Relay reconciliation: ${String(error)}`));
  }, 15_000);
  const stopNow = () => { stop.abort(); buzz.close(); };
  process.once('SIGINT', stopNow);
  process.once('SIGTERM', stopNow);

  console.log(`Buzz bridge ready: ${me.name} ↔ ${config.targetAgent} in room ${config.channelId}; bot ${config.pubkey}`);
  try {
    await buzz.run(stop.signal, (event) => bridge.receiveBuzz(event), reconcile);
  } finally {
    clearInterval(timer);
    await agent.disconnect();
  }
}
