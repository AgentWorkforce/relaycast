import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// docker/start.sh sizes the V8 heap from the cgroup memory limit and execs
// the entrypoint. A stub `node` on PATH reports what it was given.
const START = fileURLToPath(new URL('../docker/start.sh', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'relaycast-start-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const bin = join(scratch, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf "NODE_OPTIONS=%s\\n" "${NODE_OPTIONS:-}"\nprintf "ARGS=%s\\n" "$*"\n');
chmodSync(join(bin, 'node'), 0o755);

let n = 0;
function run({ v2, v1, nodeOptions, args = ['migrate'] } = {}) {
  const root = join(scratch, `cg${n += 1}`);
  mkdirSync(join(root, 'memory'), { recursive: true });
  if (v2 !== undefined) writeFileSync(join(root, 'memory.max'), `${v2}\n`);
  if (v1 !== undefined) writeFileSync(join(root, 'memory', 'memory.limit_in_bytes'), `${v1}\n`);
  const env = { PATH: `${bin}:/usr/bin:/bin`, RELAYCAST_CGROUP_ROOT: root };
  if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
  const result = spawnSync('/bin/sh', [START, ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
  return out;
}

const GiB = 1024 ** 3;

test('sets the heap to 75 % of a cgroup v2 limit and passes the arguments through', () => {
  const out = run({ v2: GiB, args: ['--port', '9000'] });
  assert.equal(out.NODE_OPTIONS, '--max-old-space-size=768');
  assert.equal(out.ARGS, '/opt/relaycast/entrypoint.mjs --port 9000');
});

test('reads a cgroup v1 limit and keeps other NODE_OPTIONS', () => {
  const out = run({ v1: 4 * GiB, nodeOptions: '--enable-source-maps' });
  assert.equal(out.NODE_OPTIONS, '--max-old-space-size=3072 --enable-source-maps');
});

test('an operator-supplied heap size wins', () => {
  const out = run({ v2: GiB, nodeOptions: '--max-old-space-size=300' });
  assert.equal(out.NODE_OPTIONS, '--max-old-space-size=300');
});

test('no limit, an unlimited v1 value, or nothing readable leaves the default', () => {
  assert.equal(run({ v2: 'max' }).NODE_OPTIONS, '');
  assert.equal(run({ v1: '9223372036854771712' }).NODE_OPTIONS, '');
  assert.equal(run({}).NODE_OPTIONS, '');
});
