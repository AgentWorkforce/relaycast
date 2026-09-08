// Scheduled integration coverage for the actual built self-host Docker image
// (not the entrypoint script in isolation -- see container-entrypoint.test.mjs
// for that). This builds the real Dockerfile, runs it as a real container
// against a persistent host-mounted volume, and drives it entirely over HTTP,
// the same way an operator would. It is the only place that proves:
//   - a workspace bootstrapped before a container restart is still recoverable
//     after the restart, using the same persisted volume and bootstrap secret
//     (relaycast#371/#379's crash-idempotency contract, exercised for real);
//   - a deployment with no bootstrap secret configured fails closed (503)
//     instead of accidentally falling back to something insecure;
//   - explicit invalid Authorization is rejected (401) rather than silently
//     downgrading to anonymous bootstrap;
//   - replaying an Idempotency-Key with a different request body is a
//     conflict (409), never a second workspace;
//   - the configured bootstrap secret never appears anywhere in `docker logs`
//     across the whole run.
//
// Requires a working `docker` CLI. Skips (not fails) the whole file if
// docker is unavailable, so this can still run on a machine without it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const IMAGE_TAG = 'relaycast-integration-test:local';
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Fixture value only: high-entropy enough to also exercise the
// relaycast#379 idempotency-key floor's companion secret, never a real
// deployment secret.
const BOOTSTRAP_SECRET = `integration-test-bootstrap-secret-${RUN_ID}`;
const PRIMARY_PORT = 18787;
const SECONDARY_PORT = 18788;
const PRIMARY_CONTAINER = `relaycast-it-primary-${RUN_ID}`;
const SECONDARY_CONTAINER = `relaycast-it-secondary-${RUN_ID}`;

function sh(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: repoRoot, ...options });
}

function dockerAvailable() {
  return sh('docker', ['version', '--format', '{{.Server.Version}}']).status === 0;
}

function removeContainerQuiet(name) {
  sh('docker', ['rm', '--force', name]);
}

function startContainer({ name, port, volumeDir, secret }) {
  removeContainerQuiet(name);
  const args = [
    'run', '-d',
    '--name', name,
    '-p', `127.0.0.1:${port}:8787`,
    '-v', `${volumeDir}:/data`,
  ];
  if (secret !== undefined) {
    args.push('-e', `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET=${secret}`);
  }
  args.push(IMAGE_TAG, '--base-url', 'https://relay.example.com');
  const result = sh('docker', args);
  assert.equal(result.status, 0, `docker run failed for ${name}: ${result.stderr}`);
}

function stopContainer(name) {
  const result = sh('docker', ['stop', '--time', '10', name]);
  assert.equal(result.status, 0, `docker stop failed for ${name}: ${result.stderr}`);
}

function startExistingContainer(name) {
  const result = sh('docker', ['start', name]);
  assert.equal(result.status, 0, `docker start failed for ${name}: ${result.stderr}`);
}

function containerLogs(name) {
  return sh('docker', ['logs', name]).stdout + sh('docker', ['logs', name]).stderr;
}

async function waitForHealth(port, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true) return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`container on port ${port} did not become healthy in time: ${lastError?.message ?? 'no response'}`);
}

async function createWorkspace(port, { name, idempotencyKey, secret, authorization }) {
  const headers = { 'content-type': 'application/json' };
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
  if (secret !== undefined) headers['X-Workspace-Bootstrap-Secret'] = secret;
  if (authorization !== undefined) headers.authorization = authorization;
  const response = await fetch(`http://127.0.0.1:${port}/v1/workspaces`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  });
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body };
}

// >=122-bit-entropy fixture key (relaycast#379's floor), not a real secret.
function freshIdempotencyKey(label) {
  return `${label}-${RUN_ID}-9f3a7c1e5b8d2f4a6c0e8b2d4f6a8c0e`;
}

const dockerOk = dockerAvailable();
const primaryVolume = dockerOk ? mkdtempSync(join(tmpdir(), 'relaycast-it-primary-')) : undefined;
const secondaryVolume = dockerOk ? mkdtempSync(join(tmpdir(), 'relaycast-it-secondary-')) : undefined;

function teardown() {
  if (!dockerOk) return;
  removeContainerQuiet(PRIMARY_CONTAINER);
  removeContainerQuiet(SECONDARY_CONTAINER);
  sh('docker', ['rmi', '--force', IMAGE_TAG]);
  if (primaryVolume) rmSync(primaryVolume, { recursive: true, force: true });
  if (secondaryVolume) rmSync(secondaryVolume, { recursive: true, force: true });
}

describe('self-host image integration (real docker build + real container)', { skip: !dockerOk && 'docker is not available' }, () => {
  before(async () => {
    // node:test does not run after() if before() throws, so a failure
    // partway through setup (e.g. the primary container started but the
    // secondary's health check times out) would otherwise leak a running
    // container, the built image, and the temp volume directories on every
    // retry -- costly on a runner this suite's own schedule reuses daily.
    // Best-effort tear down whatever was actually started before rethrowing.
    try {
      const build = sh('docker', ['build', '-f', 'Dockerfile', '-t', IMAGE_TAG, '.']);
      assert.equal(build.status, 0, `docker build failed: ${build.stderr}`);

      startContainer({ name: PRIMARY_CONTAINER, port: PRIMARY_PORT, volumeDir: primaryVolume, secret: BOOTSTRAP_SECRET });
      await waitForHealth(PRIMARY_PORT);

      startContainer({ name: SECONDARY_CONTAINER, port: SECONDARY_PORT, volumeDir: secondaryVolume, secret: undefined });
      await waitForHealth(SECONDARY_PORT);
    } catch (error) {
      teardown();
      throw error;
    }
  });

  after(teardown);

  test('a deployment with no bootstrap secret configured fails closed with 503', async () => {
    const key = freshIdempotencyKey('no-secret-configured');
    const { status, body } = await createWorkspace(SECONDARY_PORT, {
      name: 'no-secret-workspace',
      idempotencyKey: key,
      secret: BOOTSTRAP_SECRET, // caller presents a secret; the deployment has none configured
    });
    assert.equal(status, 503);
    assert.equal(body?.error?.code, 'workspace_create_idempotency_unavailable');
  });

  test('explicit invalid Authorization is rejected with 401, not downgraded to anonymous bootstrap', async () => {
    const key = freshIdempotencyKey('invalid-auth');
    const { status, body } = await createWorkspace(PRIMARY_PORT, {
      name: 'invalid-auth-workspace',
      idempotencyKey: key,
      authorization: 'Bearer rk_live_this_token_does_not_exist',
    });
    assert.equal(status, 401);
    assert.match(body?.error?.code ?? '', /unauthorized|invalid/);
  });

  test('replaying an Idempotency-Key with a different request body is a 409 conflict, not a second workspace', async () => {
    const key = freshIdempotencyKey('digest-conflict');
    const first = await createWorkspace(PRIMARY_PORT, {
      name: 'digest-conflict-original',
      idempotencyKey: key,
      secret: BOOTSTRAP_SECRET,
    });
    assert.equal(first.status, 201);

    const conflict = await createWorkspace(PRIMARY_PORT, {
      name: 'digest-conflict-different-name',
      idempotencyKey: key,
      secret: BOOTSTRAP_SECRET,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body?.error?.code, 'workspace_create_idempotency_conflict');
  });

  test('a workspace bootstrapped before a real container restart is recoverable after it, from the persistent volume', async () => {
    const key = freshIdempotencyKey('restart-replay');
    const before = await createWorkspace(PRIMARY_PORT, {
      name: 'restart-replay-workspace',
      idempotencyKey: key,
      secret: BOOTSTRAP_SECRET,
    });
    assert.equal(before.status, 201);
    assert.match(before.body?.data?.api_key ?? '', /^rk_live_/);

    stopContainer(PRIMARY_CONTAINER);
    startExistingContainer(PRIMARY_CONTAINER);
    await waitForHealth(PRIMARY_PORT);

    const after = await createWorkspace(PRIMARY_PORT, {
      name: 'restart-replay-workspace',
      idempotencyKey: key,
      secret: BOOTSTRAP_SECRET,
    });
    assert.equal(after.status, 200);
    assert.deepEqual(after.body?.data, before.body?.data);

    // Control: without the secret, even the same key can no longer recover
    // it after the restart -- the container did not silently widen access.
    const unproven = await createWorkspace(PRIMARY_PORT, {
      name: 'restart-replay-workspace',
      idempotencyKey: key,
    });
    assert.equal(unproven.status, 401);
  });

  test('the bootstrap secret never appears in captured container logs', () => {
    // Deliberately does not pass the raw log text into the assertion: if
    // this ever failed, assert.doesNotMatch would print the actual (leaked)
    // value in its own failure message, defeating the point of the test by
    // leaking the secret into the CI console. Assert on a boolean instead.
    for (const name of [PRIMARY_CONTAINER, SECONDARY_CONTAINER]) {
      const leaked = containerLogs(name).includes(BOOTSTRAP_SECRET);
      assert.equal(leaked, false, `container "${name}" logged the bootstrap secret (value redacted from this message)`);
    }
  });
});
