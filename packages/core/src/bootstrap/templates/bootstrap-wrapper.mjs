#!/usr/bin/env node
// Auto-generated bootstrap wrapper script — do not edit.

const env = process.env;
const CALLBACK_URL = env.CALLBACK_URL;
const CALLBACK_TOKEN = env.CALLBACK_TOKEN;
const RUN_ID = env.RUN_ID ?? 'unknown';
const CALLBACK_TIMEOUT_MS = 5_000;
const ERROR_BODY_LIMIT = 4_000;

function stringifyError(error) {
  if (error instanceof Error) {
    return error.stack || error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function truncateUtf8(value, byteLimit) {
  const text = String(value);
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) {
    return text;
  }

  let bytes = 0;
  let result = '';
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > byteLimit) {
      break;
    }
    bytes += charBytes;
    result += char;
  }
  return result;
}

async function reportStartupCrash(error) {
  const message = truncateUtf8(
    'bootstrap startup crash: ' + stringifyError(error),
    ERROR_BODY_LIMIT,
  );
  console.error('[bootstrap-wrapper] ' + message);

  if (!CALLBACK_URL || !CALLBACK_TOKEN || !RUN_ID) {
    console.error('[bootstrap-wrapper] Callback env missing; startup crash was not reported');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  try {
    const response = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-callback-token': CALLBACK_TOKEN,
      },
      body: JSON.stringify({
        runId: RUN_ID,
        callbackToken: CALLBACK_TOKEN,
        status: 'failed',
        error: message,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(
        '[bootstrap-wrapper] Callback failed: ' +
          response.status +
          ' ' +
          response.statusText +
          (body ? ' - ' + body.slice(0, 500) : ''),
      );
    }
  } catch (reportError) {
    console.error('[bootstrap-wrapper] Callback reporting failed:', reportError);
  } finally {
    clearTimeout(timeout);
  }
}

try {
  await import('./bootstrap-inner.mjs');
} catch (error) {
  await reportStartupCrash(error);
  process.exitCode = 1;
}