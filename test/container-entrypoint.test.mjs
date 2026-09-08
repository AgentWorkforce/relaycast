import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildEngineConfig,
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

test('refuses disguised loopback IPv4 spellings that node:net.isIP does not recognize', () => {
  // node:net's isIP() only recognizes the strict 4-decimal-octet form, so a
  // short, octal, or hex spelling would otherwise pass through DNS-hostname
  // validation looking like an ordinary label -- curl, browsers, and glibc's
  // resolver all still parse each of these as 127.0.0.1.
  for (const baseUrl of [
    'https://127.1', // short form: last part absorbs the remaining bits
    'https://127.0.1',
    'https://0177.0.0.1', // octal first octet (0177 = 127)
    'https://0x7f.0.0.1', // hex first octet (0x7f = 127)
  ]) {
    assertRefused(['--base-url', baseUrl], /loopback IP address/);
  }
  assertAccepted(); // Control: a non-loopback hostname succeeds.
});

test('refuses disguised non-loopback IPv4 spellings as IP literals', () => {
  for (const baseUrl of [
    'https://10.1', // short form for 10.0.0.1
    'https://0x0a000001', // single hex integer for 10.0.0.1
  ]) {
    assertRefused(['--base-url', baseUrl], /DNS name; IP literals are forbidden/);
  }
  assertAccepted(); // Control: an ordinary DNS authority succeeds.
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

test('refuses malformed DNS labels', () => {
  for (const baseUrl of [
    'https://a..example',
    'https://-relay.example',
    'https://relay-.example',
    `https://${'a'.repeat(64)}.example`,
  ]) {
    assertRefused(['--base-url', baseUrl], /must contain valid DNS labels/);
  }
  assertAccepted(); // Control: valid, bounded DNS labels succeed.
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

test('forwards the bootstrap secret without exposing it in container output', () => {
  const secret = 'stable-container-secret-379';
  const config = buildEngineConfig({
    RELAYCAST_ENV: 'production',
    RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: secret,
  });
  assert.deepEqual(config, {
    environment: 'production',
    workspaceBootstrapSecret: secret,
  });
});

test('never writes the bootstrap secret to stdout or stderr on the real entrypoint path', async () => {
  // A shallow assertion on buildEngineConfig's return value (above) proves
  // the secret reaches the engine config object, but not that it is kept
  // out of anything actually written to the container's captured output.
  // This drives the real main() -> launchPinnedEngine() -> buildEngineConfig
  // path end to end (an unopenable --db forces a fast, deterministic startup
  // failure instead of binding a real server) and inspects every byte
  // written to stdout/stderr for the secret.
  const secret = 'super-secret-container-value-xyz-379';
  const previousSecret = process.env.RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET;
  process.env.RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET = secret;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stdout.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return true;
  };

  try {
    const { main } = await import('../docker/entrypoint-core.mjs');
    await main([
      '--base-url', 'https://relay.ratifyprotocol.com',
      '--db', '/relaycast-entrypoint-test-nonexistent-dir/relaycast.db',
    ]);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (previousSecret === undefined) delete process.env.RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET;
    else process.env.RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET = previousSecret;
    process.exitCode = 0;
  }

  const output = captured.join('');
  assert.doesNotMatch(output, new RegExp(secret));
  // Control: the failure path actually ran and produced output to inspect --
  // an empty capture would make the assertion above vacuous.
  assert.match(output, /failed to start/);
});

test('omits an unset bootstrap secret so the engine can fail closed', () => {
  const config = buildEngineConfig({ RELAYCAST_ENV: 'production' });
  assert.deepEqual(config, { environment: 'production' });
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
