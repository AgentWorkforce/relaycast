import { nip19, getPublicKey } from 'nostr-tools';
import { z } from 'zod';

const uuid = z.string().uuid();
const envSchema = z.object({
  BUZZ_RELAY_URL: z.string().url(),
  BUZZ_CHANNEL_ID: uuid,
  BUZZ_PRIVATE_KEY: z.string().min(1),
  BUZZ_BOT_NAME: z.string().min(1).optional(),
  RELAYCAST_AGENT_TOKEN: z.string().min(1),
  RELAYCAST_TARGET_AGENT: z.string().min(1),
  RELAYCAST_BASE_URL: z.string().url().optional(),
  BUZZ_BRIDGE_STATE_FILE: z.string().min(1).optional(),
});

export interface BridgeConfig {
  buzzUrl: string;
  channelId: string;
  secretKey: Uint8Array;
  pubkey: string;
  botName?: string;
  relayToken: string;
  targetAgent: string;
  relayBaseUrl: string;
  stateFile: string;
}

export function parseSecretKey(value: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return new Uint8Array(Buffer.from(value, 'hex'));
  if (value.startsWith('nsec1')) {
    const decoded = nip19.decode(value);
    if (decoded.type === 'nsec') return decoded.data;
  }
  throw new Error('BUZZ_PRIVATE_KEY must be a 32-byte hex key or nsec.');
}

export function parseConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const value = envSchema.parse(env);
  const relayUrl = new URL(value.BUZZ_RELAY_URL);
  if (relayUrl.protocol === 'http:') relayUrl.protocol = 'ws:';
  if (relayUrl.protocol === 'https:') relayUrl.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(relayUrl.protocol) || relayUrl.username || relayUrl.password || relayUrl.search || relayUrl.hash) {
    throw new Error('BUZZ_RELAY_URL must be a ws(s) or http(s) relay URL without credentials, query, or fragment.');
  }
  const secretKey = parseSecretKey(value.BUZZ_PRIVATE_KEY);
  return {
    buzzUrl: relayUrl.toString(),
    channelId: value.BUZZ_CHANNEL_ID,
    secretKey,
    pubkey: getPublicKey(secretKey),
    botName: value.BUZZ_BOT_NAME,
    relayToken: value.RELAYCAST_AGENT_TOKEN,
    targetAgent: value.RELAYCAST_TARGET_AGENT,
    relayBaseUrl: value.RELAYCAST_BASE_URL ?? 'https://cast.agentrelay.com',
    stateFile: value.BUZZ_BRIDGE_STATE_FILE ?? './buzz-bridge-state.json',
  };
}
