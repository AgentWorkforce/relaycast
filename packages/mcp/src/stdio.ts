#!/usr/bin/env node
import { startStdio } from './transports.js';

const apiKey = process.env.RELAY_API_KEY;
if (!apiKey) {
  console.error('RELAY_API_KEY environment variable is required');
  process.exit(1);
}

startStdio({
  apiKey,
  baseUrl: process.env.RELAY_BASE_URL,
});
