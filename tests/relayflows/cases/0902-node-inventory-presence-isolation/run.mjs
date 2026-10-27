#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '0902-node-inventory-presence-isolation';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const caseDir = path.dirname(fileURLToPath(import.meta.url));

if ((arm !== 'base' && arm !== 'head') || !targetDir || !resultPath) {
  throw new Error('RelayFlow proof environment is incomplete');
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
}

const vitestEntry = path.join(targetDir, 'node_modules', 'vitest', 'vitest.mjs');
if (!(await pathExists(vitestEntry))) {
  run('npm', ['ci', '--no-audit', '--no-fund'], targetDir);
}
const tscEntry = path.join(targetDir, 'node_modules', 'typescript', 'bin', 'tsc');
run(process.execPath, [tscEntry, '-p', 'packages/types/tsconfig.json'], targetDir);
run(process.execPath, [tscEntry, '-p', 'packages/a2a/tsconfig.json'], targetDir);

const proofDir = path.join(targetDir, '.relay-pr-proof');
const probePath = path.join(
  targetDir,
  'packages/engine/src/__tests__/conformance/.relayflow-node-inventory-presence.test.ts'
);
const configPath = path.join(proofDir, 'vitest.config.mts');

try {
  // Setup lives inside the try so the finally below always removes the probe
  // test and .relay-pr-proof/ from the target checkout, even when a later
  // setup step throws after an earlier one already created files.
  await mkdir(proofDir, { recursive: true });
  await copyFile(path.join(caseDir, 'probe.test.ts'), probePath);
  await writeFile(
    configPath,
    `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { environment: 'node', include: ['packages/engine/src/__tests__/conformance/.relayflow-node-inventory-presence.test.ts'] } });\n`
  );
  run(process.execPath, [vitestEntry, 'run', '--config', configPath, '--reporter=verbose'], targetDir);
} finally {
  await Promise.allSettled([rm(probePath, { force: true }), rm(proofDir, { recursive: true, force: true })]);
}

const observation = arm === 'base'
  ? {
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome: 'bug',
      signature: 'one_inventory_conflict_expires_node_and_queues_deliveries',
      details:
        'The healthy control renewed and drained. On the poisoned node, one conflicting name rejected the authoritative batch; both valid siblings read offline and each retained one pending delivery.',
    }
  : {
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome: 'fixed',
      signature: 'inventory_conflict_isolated_healthy_siblings_deliver',
      details:
        'The healthy control and poisoned node both renewed valid siblings; the conflicting member was rejected, both deliveries were acknowledged, and authenticated agent reads reported active with empty pending queues.',
    };

await writeFile(resultPath, `${JSON.stringify(observation, null, 2)}\n`);
