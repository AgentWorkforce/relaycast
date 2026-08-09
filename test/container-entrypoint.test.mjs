import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  installPublicAuthorityMarker,
  isHelpRequest,
  validatedEngineArgs,
} from '../docker/entrypoint-core.mjs';

const entrypoint = fileURLToPath(
  new URL('../docker/entrypoint.mjs', import.meta.url),
);
const acceptedArgs = ['--base-url', 'https://relay.ratifyprotocol.com'];

function runAt(executable, args) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: 'utf8',
  });
}

function run(args) {
  return runAt(entrypoint, args);
}

function assertAccepted(args = acceptedArgs) {
  const normalized = validatedEngineArgs(args);
  assert.deepEqual(normalized, acceptedArgs);
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
  assertRefused(
    ['--base-url', 'https://relay.localhost'],
    /must not use localhost/,
  );
  assertRefused(['--base-url', 'https://127.0.0.1'], /loopback IP address/);
  assertRefused(
    ['--base-url', 'https://[::ffff:127.0.0.1]'],
    /loopback IP address/,
  );
  assertAccepted(); // Control: a non-loopback hostname succeeds.
});

test('refuses the special-use .local namespace', () => {
  assertRefused(
    ['--base-url', 'https://relay.local'],
    /special-use \.local namespace/,
  );
  assertAccepted(); // Control: a public DNS authority succeeds.
});

test('refuses IPv4 and IPv6 literal authorities', () => {
  assertRefused(
    ['--base-url', 'https://203.0.113.5'],
    /DNS name; IP literals are forbidden/,
  );
  assertRefused(
    ['--base-url', 'https://[2001:db8::1]'],
    /DNS name; IP literals are forbidden/,
  );
  assertAccepted(); // Control: a DNS authority succeeds.
});

test('refuses an invalid authority when invoked through a symlink', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relaycast-entrypoint-'));
  const symlink = join(directory, 'entrypoint.mjs');
  symlinkSync(entrypoint, symlink);
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const refused = runAt(symlink, [
    '--base-url',
    'http://relay.ratifyprotocol.com',
  ]);
  assert.equal(refused.status, 64, refused.stderr);
  assert.match(refused.stderr, /refused to start/);
  assert.match(refused.stderr, /must use https/);

  // Control: the same symlink runs the executable's successful help path.
  const accepted = runAt(symlink, ['--help']);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Required public HTTPS origin/);
});

test("accepts Ratify's HTTPS deployment authority", () => {
  assertAccepted();
  // Negative control: changing only the scheme makes the same authority fail.
  assertRefused(
    ['--base-url', 'http://relay.ratifyprotocol.com'],
    /must use https/,
  );
});

test('refuses duplicate --base-url options', () => {
  assertRefused(
    [
      '--base-url',
      'https://relay.ratifyprotocol.com',
      '--base-url=http://localhost:8787',
    ],
    /provided exactly once/,
  );
  assertAccepted(); // Control: the same production origin supplied once succeeds.
});

test('refuses an authority token consumed by another option', () => {
  for (const option of ['--db', '--port', '--env']) {
    assertRefused(
      [option, '--base-url', 'https://relay.ratifyprotocol.com'],
      new RegExp(`${option} requires a value`),
    );
  }
  assertAccepted(); // Control: the authority remains valid when it is not consumed.
});

test('shows help without requiring a deployment authority', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Required public HTTPS origin/);
  assertRefused([], /--base-url is required/); // Control: an actual start still refuses it.
});

test('recognizes help only when it is an option', () => {
  assert.equal(isHelpRequest(['--help']), true);
  // Negative control: -h is a legitimate value position, not a help option.
  assert.equal(isHelpRequest(['--db', '-h']), false);
  assert.equal(isHelpRequest(['--env', '-h', '--help']), true);
});

test('normalizes tunnel requests to the validated public HTTPS authority', () => {
  const observedOrigin = (installMarker) => {
    const server = new EventEmitter();
    let origin;
    server.on('request', (request) => {
      const scheme = request.socket.encrypted ? 'https' : 'http';
      const hostIndex = request.rawHeaders.findIndex(
        (header) => header.toLowerCase() === 'host',
      );
      origin = `${scheme}://${request.rawHeaders[hostIndex + 1]}`;
    });
    if (installMarker) {
      installPublicAuthorityMarker(server, 'https://relay.ratifyprotocol.com');
    }
    server.emit('request', {
      headers: { host: 'container:8787' },
      rawHeaders: ['Host', 'container:8787'],
      socket: { encrypted: false },
    });
    return origin;
  };

  // Negative control: the upstream Node adapter sees tunnel loopback as HTTP.
  assert.equal(observedOrigin(false), 'http://container:8787');
  assert.equal(observedOrigin(true), 'https://relay.ratifyprotocol.com');
});
