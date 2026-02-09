#!/usr/bin/env node
import { startStdio } from './transports.js';

const apiKey = process.env.RELAY_API_KEY;

startStdio({
  apiKey,
  baseUrl: process.env.RELAY_BASE_URL,
});
