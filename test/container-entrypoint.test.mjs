import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  baseUrlPolicy,
  buildEngineConfig,
  installPublicAuthorityMarker,
  isHelpRequest,
  isPrivateHostname,
  validateBaseUrl,
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
  assert.match(
    result.stdout,
    /RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED\s+Set true to require bootstrap-secret proof for anonymous keyed creates/,
  );
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

test('makes bootstrap-secret proof enforcement an explicit opt-in', () => {
  assert.deepEqual(buildEngineConfig({
    RELAYCAST_ENV: 'production',
    RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'stable-container-secret-407',
  }), {
    environment: 'production',
    workspaceBootstrapSecret: 'stable-container-secret-407',
  });
  assert.deepEqual(buildEngineConfig({
    RELAYCAST_ENV: 'production',
    RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'stable-container-secret-407',
    RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true',
  }), {
    environment: 'production',
    workspaceBootstrapSecret: 'stable-container-secret-407',
    workspaceBootstrapProofRequired: true,
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

test('keeps http and private authorities refused unless explicitly opted in', () => {
  for (const url of ['http://127.0.0.1:19487', 'http://relaycast:8787', 'http://10.0.0.5']) {
    assert.throws(() => validateBaseUrl(url, { allowInsecure: false }), /refused to start/);
  }
  assert.throws(
    () => validatedEngineArgs(['--base-url', 'http://127.0.0.1:19487'], {}),
    /must use https/,
  );
});

test('accepts http base URLs on loopback/private hosts when RELAYCAST_ALLOW_INSECURE_BASE_URL=true', () => {
  const env = { RELAYCAST_ALLOW_INSECURE_BASE_URL: 'true' };
  for (const [input, origin] of [
    ['http://127.0.0.1:19487', 'http://127.0.0.1:19487'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
    ['http://10.1.2.3', 'http://10.1.2.3'],
    ['http://172.20.0.4:8787', 'http://172.20.0.4:8787'],
    ['http://192.168.1.10', 'http://192.168.1.10'],
    ['http://[fd00::1]', 'http://[fd00::1]'],
    ['http://relaycast:8787', 'http://relaycast:8787'],
    ['http://relaycast.relay.svc.cluster.local:8787', 'http://relaycast.relay.svc.cluster.local:8787'],
    ['http://cast.corp.internal', 'http://cast.corp.internal'],
  ]) {
    assert.deepEqual(validatedEngineArgs(['--base-url', input], env), ['--base-url', origin], input);
  }
  // The usual HTTPS public authority still works with the flag set.
  assert.deepEqual(validatedEngineArgs(acceptedArgs, env), acceptedArgs);
});

test('the insecure opt-in never relaxes public hosts or origin-only rules', () => {
  const env = { RELAYCAST_ALLOW_INSECURE_BASE_URL: 'true' };
  for (const url of [
    'http://relay.ratifyprotocol.com',
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://[2001:db8::1]',
  ]) {
    assert.throws(() => validatedEngineArgs(['--base-url', url], env), /must use https|IP literals/, url);
  }
  assert.throws(
    () => validatedEngineArgs(['--base-url', 'http://127.0.0.1:19487/path'], env),
    /origin only/,
  );
  assert.throws(
    () => validatedEngineArgs(['--base-url', 'ftp://127.0.0.1'], env),
    /http or https/,
  );
  // Only the exact string "true" opts in.
  assert.throws(
    () => validatedEngineArgs(['--base-url', 'http://127.0.0.1'], { RELAYCAST_ALLOW_INSECURE_BASE_URL: '1' }),
    /must use https/,
  );
  assert.equal(isPrivateHostname('relay.ratifyprotocol.com'), false);
});

const INLINE_SECRET = 'inline-secret-0123456789abcdef0123456789';
const FILE_SECRET = 'file-secret-0123456789abcdef0123456789ab';

test('reads secrets from env or a mounted file; a directly set variable wins (as in RelayAuth)', (t) => {
  assert.deepEqual(
    buildEngineConfig({ RELAYCAST_ENV: 'production', RELAYCAST_INTERNAL_SECRET: INLINE_SECRET }),
    { environment: 'production', internalSecret: INLINE_SECRET },
  );
  const dir = mkdtempSync(join(tmpdir(), 'relaycast-internal-secret-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'secret');
  writeFileSync(file, `${FILE_SECRET}\n`, { mode: 0o600 });
  assert.deepEqual(
    buildEngineConfig({ RELAYCAST_ENV: 'production', RELAYCAST_INTERNAL_SECRET_FILE: file }),
    { environment: 'production', internalSecret: FILE_SECRET },
  );
  assert.deepEqual(
    buildEngineConfig({
      RELAYCAST_ENV: 'production',
      RELAYCAST_INTERNAL_SECRET: INLINE_SECRET,
      RELAYCAST_INTERNAL_SECRET_FILE: file,
    }),
    { environment: 'production', internalSecret: INLINE_SECRET },
  );
  // A blank direct value falls through to the file.
  assert.deepEqual(
    buildEngineConfig({
      RELAYCAST_ENV: 'production',
      RELAYCAST_INTERNAL_SECRET: ' ',
      RELAYCAST_INTERNAL_SECRET_FILE: file,
    }),
    { environment: 'production', internalSecret: FILE_SECRET },
  );
  // The bootstrap secret has the same _FILE support.
  const bootstrapFile = join(dir, 'bootstrap');
  writeFileSync(bootstrapFile, 'stable-bootstrap-from-file\n', { mode: 0o600 });
  assert.deepEqual(
    buildEngineConfig({ RELAYCAST_ENV: 'production', RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE: bootstrapFile }),
    { environment: 'production', workspaceBootstrapSecret: 'stable-bootstrap-from-file' },
  );
  // Unset or blank leaves the admin API disabled.
  assert.deepEqual(buildEngineConfig({ RELAYCAST_ENV: 'production', RELAYCAST_INTERNAL_SECRET: '  ' }), {
    environment: 'production',
  });
});

test('keeps a directly set bootstrap secret verbatim; a _FILE loses one trailing newline', (t) => {
  // The bootstrap secret's exact bytes derive keyed-create replay keys, so a
  // value with surrounding whitespace must keep deriving the same keys it did
  // before _FILE support (when it was passed through unchanged).
  for (const secret of ['abc ', ' stable-bootstrap', 'tab\tsecret\t']) {
    assert.deepEqual(
      buildEngineConfig({ RELAYCAST_ENV: 'production', RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: secret }),
      { environment: 'production', workspaceBootstrapSecret: secret },
      JSON.stringify(secret),
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'relaycast-bootstrap-secret-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [
    ['stable-bootstrap\n', 'stable-bootstrap'],
    ['stable-bootstrap\r\n', 'stable-bootstrap'],
    ['stable-bootstrap', 'stable-bootstrap'],
    [' padded \n', ' padded '],
  ];
  for (const [index, [content, expected]] of cases.entries()) {
    const file = join(dir, `bootstrap-${index}`);
    writeFileSync(file, content, { mode: 0o600 });
    assert.deepEqual(
      buildEngineConfig({ RELAYCAST_ENV: 'production', RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE: file }),
      { environment: 'production', workspaceBootstrapSecret: expected },
      JSON.stringify(content),
    );
  }
  const newlineOnly = join(dir, 'bootstrap-empty');
  writeFileSync(newlineOnly, '\n', { mode: 0o600 });
  assert.deepEqual(
    buildEngineConfig({ RELAYCAST_ENV: 'production', RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE: newlineOnly }),
    { environment: 'production' },
  );
});

test('refuses (exit 64) a missing secret file and a short internal secret', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relaycast-secret-refusal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['RELAYCAST_INTERNAL_SECRET', 'RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET']) {
    assert.throws(
      () => buildEngineConfig({ [`${name}_FILE`]: join(dir, 'missing') }),
      (error) => error.code === 'unreadable_secret_file' && error.message.includes(`${name}_FILE`),
    );
  }
  assert.throws(
    () => buildEngineConfig({ RELAYCAST_INTERNAL_SECRET: 'too-short-secret' }),
    /at least 32 characters/,
  );

  const env = { ...process.env, RELAYCAST_INTERNAL_SECRET: '', RELAYCAST_INTERNAL_SECRET_FILE: join(dir, 'missing') };
  const missing = spawnSync(process.execPath, [entrypoint, ...acceptedArgs], { encoding: 'utf8', env });
  assert.equal(missing.status, 64, missing.stderr);
  assert.match(missing.stderr, /RELAYCAST_INTERNAL_SECRET_FILE points at an unreadable file/);
  const weak = spawnSync(process.execPath, [entrypoint, ...acceptedArgs], {
    encoding: 'utf8',
    env: { ...process.env, RELAYCAST_INTERNAL_SECRET: 'short' },
  });
  assert.equal(weak.status, 64, weak.stderr);
  assert.doesNotMatch(weak.stderr + weak.stdout, /\bshort\b/);
});

test('RELAYCAST_PUBLIC_WORKSPACE_CREATE=false disables public creates; other values are refused', () => {
  assert.deepEqual(buildEngineConfig({ RELAYCAST_ENV: 'production', RELAYCAST_PUBLIC_WORKSPACE_CREATE: 'false' }), {
    environment: 'production',
    publicWorkspaceCreate: false,
  });
  assert.deepEqual(buildEngineConfig({ RELAYCAST_ENV: 'production', RELAYCAST_PUBLIC_WORKSPACE_CREATE: 'true' }), {
    environment: 'production',
  });
  assert.throws(
    () => buildEngineConfig({ RELAYCAST_PUBLIC_WORKSPACE_CREATE: 'no' }),
    (error) => error.code === 'invalid_public_workspace_create',
  );
});

test('Kubernetes service names (.svc, .svc.cluster.local) are private with the insecure opt-in', () => {
  const env = { RELAYCAST_ALLOW_INSECURE_BASE_URL: 'true' };
  for (const url of [
    'http://relaycast.relaycast.svc:8787',
    'http://relaycast.relaycast.svc.cluster.local:8787',
  ]) {
    assert.deepEqual(validatedEngineArgs(['--base-url', url], env), ['--base-url', url], url);
    assert.throws(() => validatedEngineArgs(['--base-url', url], {}), /must use https/, url);
  }
  // <svc>.<ns> without .svc is not private by default...
  assert.throws(
    () => validatedEngineArgs(['--base-url', 'http://relaycast.relaycast:8787'], env),
    /must use https/,
  );
  // ...but can be allowlisted exactly.
  const hostsEnv = { ...env, RELAYCAST_INSECURE_BASE_URL_HOSTS: 'relaycast.relaycast, other.ns' };
  assert.deepEqual(
    validatedEngineArgs(['--base-url', 'http://relaycast.relaycast:8787'], hostsEnv),
    ['--base-url', 'http://relaycast.relaycast:8787'],
  );
  // Exact means exact: a different host under the same "namespace" stays refused.
  assert.throws(
    () => validatedEngineArgs(['--base-url', 'http://evil.relaycast:8787'], hostsEnv),
    /must use https/,
  );
  // Allowlists have no effect without the opt-in.
  assert.throws(
    () => validatedEngineArgs(['--base-url', 'http://relaycast.relaycast:8787'], {
      RELAYCAST_INSECURE_BASE_URL_HOSTS: 'relaycast.relaycast',
    }),
    /must use https/,
  );
});

test('custom clusterDomain suffixes via RELAYCAST_PRIVATE_DNS_SUFFIXES', () => {
  const env = {
    RELAYCAST_ALLOW_INSECURE_BASE_URL: 'true',
    RELAYCAST_PRIVATE_DNS_SUFFIXES: '.svc.corp, svc.k8s.lab',
  };
  for (const url of ['http://relaycast.ns.svc.corp:8787', 'http://relaycast.ns.svc.k8s.lab']) {
    assert.deepEqual(validatedEngineArgs(['--base-url', url], env), ['--base-url', url], url);
  }
  assert.deepEqual(baseUrlPolicy(env).extraSuffixes, ['.svc.corp', '.svc.k8s.lab']);
  // A suffix only matches on a label boundary.
  assert.throws(
    () => validatedEngineArgs(['--base-url', 'http://relaycast.svccorp:8787'], env),
    /must use https/,
  );
});

test('allowlists never accept public names, single labels, or IP literals', () => {
  const base = { RELAYCAST_ALLOW_INSECURE_BASE_URL: 'true' };
  for (const suffix of [
    '.com', 'example.com', '.co.uk', '.corp', 'bad_suffix.x',
    // Public zones under TLDs missing from any fixed list are refused too:
    // a suffix must sit under a private zone or be a .svc.<domain> zone.
    '.example.shop', 'corp.example.museum', '.example.zone', '.svc.example.shop',
  ]) {
    assert.throws(
      () => validatedEngineArgs(['--base-url', 'http://relaycast.svc:8787'], {
        ...base,
        RELAYCAST_PRIVATE_DNS_SUFFIXES: suffix,
      }),
      (error) => error.code === 'invalid_private_dns_suffix',
      suffix,
    );
  }
  for (const host of [
    'relay.example.com', 'relay.ratifyprotocol.com', '8.8.8.8', '0x08080808', 'bad host',
    // Longer than <svc>.<ns> and not under a private zone: refused whatever the TLD.
    'relay.example.shop', 'relay.example.museum', 'a.b.c',
    'relay.shop',
  ]) {
    assert.throws(
      () => validatedEngineArgs(['--base-url', 'http://relaycast.svc:8787'], {
        ...base,
        RELAYCAST_INSECURE_BASE_URL_HOSTS: host,
      }),
      (error) => error.code === 'invalid_insecure_base_url_host',
      host,
    );
  }
  // The real entrypoint maps these refusals to exit 64.
  const result = spawnSync(process.execPath, [entrypoint, '--base-url', 'http://relaycast.svc:8787'], {
    encoding: 'utf8',
    env: { ...process.env, ...base, RELAYCAST_INSECURE_BASE_URL_HOSTS: 'relay.example.com' },
  });
  assert.equal(result.status, 64, result.stderr);
});

test('allowlists accept private-zone names and <svc>.<ns> short names', () => {
  const env = {
    RELAYCAST_ALLOW_INSECURE_BASE_URL: 'true',
    RELAYCAST_PRIVATE_DNS_SUFFIXES: '.corp.internal, lab.home.arpa, .svc.k8s.lab',
    RELAYCAST_INSECURE_BASE_URL_HOSTS: 'relaycast.relaycast, relay.ns.svc.k8s.internal, relay.lab.lan',
  };
  const policy = baseUrlPolicy(env);
  assert.deepEqual(policy.extraSuffixes, ['.corp.internal', '.lab.home.arpa', '.svc.k8s.lab']);
  assert.deepEqual(policy.exactHosts, ['relaycast.relaycast', 'relay.ns.svc.k8s.internal', 'relay.lab.lan']);
});

test('keeps plaintext private base URLs unmarked as TLS', () => {
  const server = new EventEmitter();
  let encrypted;
  server.on('request', (request) => { encrypted = request.socket.encrypted; });
  installPublicAuthorityMarker(server, 'http://127.0.0.1:19487');
  server.emit('request', {
    headers: { host: 'container:8787' },
    rawHeaders: ['Host', 'container:8787'],
    socket: { encrypted: false },
  });
  assert.equal(encrypted, false);
});
