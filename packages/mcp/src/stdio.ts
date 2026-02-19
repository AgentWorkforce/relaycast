#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startStdio } from './transports.js';

/**
 * Resolve the Relaycast API key from (in order):
 *   1. RELAY_API_KEY env var
 *   2. {cwd}/.agent-relay/relaycast.json  (per-project credentials)
 *   3. ~/.agent-relay/relaycast.json       (global credentials)
 */
function resolveApiKey(): string | undefined {
  if (process.env.RELAY_API_KEY) {
    return process.env.RELAY_API_KEY;
  }

  const candidates = [
    join(process.cwd(), '.agent-relay', 'relaycast.json'),
    join(homedir(), '.agent-relay', 'relaycast.json'),
  ];

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const data = JSON.parse(raw);
      if (data.api_key) {
        return data.api_key;
      }
    } catch {
      // File not found or invalid — try next candidate
    }
  }

  return undefined;
}

startStdio({
  apiKey: resolveApiKey(),
  baseUrl: process.env.RELAY_BASE_URL,
});
