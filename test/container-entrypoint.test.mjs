import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entrypoint = fileURLToPath(
  new URL('../docker/entrypoint.mjs', import.meta.url),
);
const acceptedArgs = ['--base-url', 'https://relay.ratifyprotocol.com'];

function run(args) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // The tests cover the wrapper boundary. A successful validation hands
      // off to a harmless process; a refusal must never reach it.
      RELAYCAST_ENGINE_BIN: '/usr/bin/true',
    },
  });
}

function assertAccepted(args = acceptedArgs) {
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
}

function assertRefused(args, message) {
  const result = run(args);
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, message);
  assert.match(result.stderr, /refused to start/);
}

test('refuses a missing --base-url before engine handoff', () => {
  assertRefused([], /--base-url is required/);
  assertAccepted(); // Control: adding the required production origin succeeds.
});

test('refuses a non-HTTPS --base-url', () => {
  assertRefused(
    ['--base-url', 'http://relay.ratifyprotocol.com'],
    /must use https/,
  );
  assertAccepted(); // Control: the same public authority over HTTPS succeeds.
});

test('refuses a single-label --base-url hostname', () => {
  assertRefused(['--base-url', 'https://relay'], /at least two DNS labels/);
  assertAccepted(); // Control: a multi-label hostname succeeds.
});

test('refuses a loopback --base-url', () => {
  assertRefused(['--base-url', 'https://127.0.0.1'], /loopback IP address/);
  assertRefused(['--base-url', 'https://[::ffff:127.0.0.1]'], /loopback IP address/);
  assertAccepted(); // Control: a non-loopback hostname succeeds.
});

test('accepts Ratify\'s HTTPS deployment authority', () => {
  assertAccepted();
  // Negative control: changing only the scheme makes the same authority fail.
  assertRefused(
    ['--base-url', 'http://relay.ratifyprotocol.com'],
    /must use https/,
  );
});
