// Run after the normal build; each fixture gets its own retained result file.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const resultsDir = process.env.ENGINE_REGRESSION_RESULTS_DIR
  ? resolve(process.env.ENGINE_REGRESSION_RESULTS_DIR)
  : mkdtempSync(join(tmpdir(), 'engine-regressions-'));
mkdirSync(resultsDir, { recursive: true });
console.log(`ENGINE regression results: ${resultsDir}`);

for (const name of [
  'capacity-http-regression',
  'pending-retention-regression',
  'a2a-lifecycle-regression',
  'public-consumer-compile',
]) {
  console.log(`Running ${name}`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`${name}.mjs`, import.meta.url))], {
    stdio: 'inherit',
    env: { ...process.env, CAPACITY_RESULTS: join(resultsDir, `${name}.json`) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`${name} failed (${result.signal ?? result.status})`);
    process.exit(result.status ?? 1);
  }
}
