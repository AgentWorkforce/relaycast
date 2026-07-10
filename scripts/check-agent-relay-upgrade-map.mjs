#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

const manifests = new Map([
  ['package.json', readJson('package.json')],
  ['packages/core/package.json', readJson('packages/core/package.json')],
  ['packages/web/package.json', readJson('packages/web/package.json')],
  ['packages/credential-proxy/package.json', readJson('packages/credential-proxy/package.json')],
  ['packages/relaycast/package.json', readJson('packages/relaycast/package.json')],
  ['packages/specialist-worker/package.json', readJson('packages/specialist-worker/package.json')],
  ['services/agent-gateway/package.json', readJson('services/agent-gateway/package.json')],
]);
const lock = readJson('package-lock.json');
const failures = [];

function fail(message) {
  failures.push(message);
}

function dependencyVersion(manifestPath, name) {
  const manifest = manifests.get(manifestPath);
  return manifest?.dependencies?.[name] ?? manifest?.devDependencies?.[name];
}

function assertManifest(manifestPath, name, expected) {
  const actual = dependencyVersion(manifestPath, name);
  if (actual !== expected) {
    fail(`${manifestPath}: expected ${name}@${expected}, found ${actual ?? 'missing'}`);
  }
}

function lockEntry(path) {
  const entry = lock.packages?.[path];
  if (!entry) {
    fail(`package-lock.json: missing ${path}`);
  }
  return entry;
}

function assertLock(path, expectedName, expectedVersion) {
  const entry = lockEntry(path);
  if (!entry) return;
  const actualName = lockPackageName(path, entry);
  if (actualName !== expectedName) {
    fail(`package-lock.json: ${path} expected name ${expectedName}, found ${actualName ?? 'missing'}`);
  }
  if (entry.version !== expectedVersion) {
    fail(`package-lock.json: ${path} expected ${expectedVersion}, found ${entry.version ?? 'missing'}`);
  }
}

function lockPackageName(path, entry) {
  if (entry.name) return entry.name;
  if (!path.startsWith('node_modules/') && !path.includes('/node_modules/')) return undefined;
  const parts = path.split('/node_modules/');
  const tail = parts[parts.length - 1].replace(/^node_modules\//, '');
  if (tail.startsWith('@')) {
    const [scope, pkg] = tail.split('/');
    return pkg ? `${scope}/${pkg}` : tail;
  }
  return tail.split('/')[0];
}

const manifestExpectations = [
  ['package.json', '@agent-relay/agent', '7.1.1'],
  ['package.json', '@agent-relay/config', '9.1.4'],
  ['package.json', '@agent-relay/credential-proxy', '7.1.1'],
  ['package.json', '@agent-relay/events', '7.1.1'],
  ['package.json', '@agent-relay/sdk', '9.1.4'],
  ['package.json', '@relaycast/engine', '5.0.5'],
  ['package.json', '@relaycast/sdk', '5.0.5'],
  ['packages/core/package.json', '@agent-relay/config', '9.1.4'],
  ['packages/core/package.json', '@agent-relay/credential-proxy', '7.1.1'],
  ['packages/core/package.json', '@agent-relay/sdk', '9.1.4'],
  ['packages/core/package.json', '@relayflows/core', '1.0.1'],
  ['packages/core/package.json', 'agent-relay', '9.1.4'],
  ['packages/web/package.json', '@agent-relay/agent', '7.1.1'],
  ['packages/web/package.json', '@agent-relay/config', '9.1.4'],
  ['packages/web/package.json', '@agent-relay/events', '7.1.1'],
  ['packages/web/package.json', '@relayflows/core', '1.0.1'],
  ['packages/credential-proxy/package.json', '@agent-relay/credential-proxy', '7.1.1'],
  ['packages/relaycast/package.json', '@relaycast/a2a', '5.0.5'],
  ['packages/relaycast/package.json', '@relaycast/engine', '5.0.5'],
  ['packages/relaycast/package.json', '@relaycast/types', '5.0.5'],
  ['packages/specialist-worker/package.json', '@relaycast/a2a', '5.0.5'],
  ['services/agent-gateway/package.json', '@agent-relay/events', '7.1.1'],
];

for (const expectation of manifestExpectations) {
  assertManifest(...expectation);
}

const lockExpectations = [
  ['node_modules/@agent-relay/agent', '@agent-relay/agent', '7.1.1'],
  ['node_modules/@agent-relay/config', '@agent-relay/config', '9.1.4'],
  ['node_modules/@agent-relay/credential-proxy', '@agent-relay/credential-proxy', '7.1.1'],
  ['node_modules/@agent-relay/events', '@agent-relay/events', '7.1.1'],
  ['node_modules/@agent-relay/sdk', '@agent-relay/sdk', '9.1.4'],
  ['node_modules/agent-relay', 'agent-relay', '9.1.4'],
  ['node_modules/@relaycast/engine', '@relaycast/engine', '5.0.5'],
  ['node_modules/@relaycast/sdk', '@relaycast/sdk', '5.0.5'],
  ['node_modules/@relaycast/sdk/node_modules/@relaycast/types', '@relaycast/types', '5.0.5'],
  ['packages/relaycast/node_modules/@relaycast/a2a', '@relaycast/a2a', '5.0.5'],
  ['packages/relaycast/node_modules/@relaycast/types', '@relaycast/types', '5.0.5'],
  ['packages/specialist-worker/node_modules/@relaycast/a2a', '@relaycast/a2a', '5.0.5'],
  ['node_modules/@relayflows/core', '@relayflows/core', '1.0.1'],
];

for (const expectation of lockExpectations) {
  assertLock(...expectation);
}

// The Relaycast Cloudflare Worker is bundled by SST, which hashes the handler
// source rather than node_modules. A bare dependency bump can therefore reuse
// the previous bundle and keep running the old engine in production. The
// entrypoint carries a `bundled @relaycast/engine: <version>` marker comment
// that must be bumped on every engine change to force a re-bundle; verify it
// tracks the pinned @relaycast/engine version.
function assertCloudflareEngineMarker(expectedVersion) {
  const markerPath = 'packages/relaycast/src/entrypoints/cloudflare.ts';
  const source = readFileSync(join(root, markerPath), 'utf8');
  const match = source.match(/bundled @relaycast\/engine:\s*([^\s]+)/);
  if (!match) {
    fail(`${markerPath}: missing "bundled @relaycast/engine: <version>" marker`);
    return;
  }
  if (match[1] !== expectedVersion) {
    fail(
      `${markerPath}: bundled @relaycast/engine marker is ${match[1]}, expected ${expectedVersion} (bump it to force an SST re-bundle)`,
    );
  }
}

assertCloudflareEngineMarker('5.0.5');

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  const name = lockPackageName(path, entry);
  if (!name) continue;

  if (
    ['@agent-relay/agent', '@agent-relay/events', '@agent-relay/credential-proxy'].includes(name) &&
    String(entry.version ?? '').startsWith('8.')
  ) {
    fail(`package-lock.json: ${path} resolves ${name}@${entry.version}; protocol/client packages must stay on 7.1.1`);
  }

  if (name === '@agent-relay/harness-driver') {
    // A transitive copy may be pulled by agent-relay/@relayflows, but Cloud must not
    // rely on it for broker resolution or promote it to a managed direct dependency.
    for (const [manifestPath] of manifests) {
      if (dependencyVersion(manifestPath, name)) {
        fail(`${manifestPath}: ${name} must not be a direct dependency for the 8.x Cloud upgrade`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log('Agent Relay upgrade package map OK');
