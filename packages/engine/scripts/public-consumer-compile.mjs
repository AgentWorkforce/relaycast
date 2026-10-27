// Verify the actual packed public declarations, with strict contextual typing.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
// Keep normal dependency lookup within this checkout, overriding only ENGINE.
const temp = mkdtempSync(join(root, '.public-consumer-'));
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }));
  const destination = join(temp, 'node_modules/@relaycast/engine');
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', join(temp, packed.filename), '-C', destination, '--strip-components=1']);
  assert.equal(existsSync(join(destination, 'dist/ports/workspaceDelivery.consumer.js')), false);
  assert.ok(!readFileSync(join(destination, 'dist/ports/index.d.ts'), 'utf8').includes('../engine/workspaceDeliveryPolicy'));
  writeFileSync(join(temp, 'consumer.mts'), `
import type { EngineConfig } from '@relaycast/engine';
import type { EngineConfig as PortConfig, WorkspaceDeliveryPolicyConfig } from '@relaycast/engine/ports';
const policy: WorkspaceDeliveryPolicyConfig = { cap: 10 }; void policy;
const config = {
  workspaceDelivery: {
    resolve: async (workspace) => {
      const id: string = workspace.id;
      const plan: string = workspace.plan;
      await Promise.resolve();
      return id && plan === 'enterprise' ? { cap: 5000, reserve: 0 } : undefined;
    },
  },
} satisfies EngineConfig;
const port: PortConfig = config;
void port;
`);
  execFileSync(process.execPath, [fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', join(temp, 'consumer.mts')], { cwd: root, stdio: 'inherit' });
  console.log('PASS packed @relaycast/engine and /ports async resolver consumer compile');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
