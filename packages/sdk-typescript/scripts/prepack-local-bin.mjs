import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.env.RELAYCAST_LOCAL_REPO || 'AgentWorkforce/relaycast';
const tag = process.env.RELAYCAST_LOCAL_RELEASE_TAG || 'local-v0.1.0';
const force = process.env.RELAYCAST_LOCAL_BIN_FORCE === '1';

const assets = [
  'local-darwin-arm64',
  'local-darwin-x64',
  'local-linux-x64',
  'local-windows-x64.exe',
];

const binDir = join(process.cwd(), 'bin');
mkdirSync(binDir, { recursive: true });

for (const asset of assets) {
  const out = join(binDir, asset);
  if (!force && existsSync(out)) {
    continue;
  }

  const url = `https://github.com/${repo}/releases/download/${tag}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(out, bytes);
  if (!asset.endsWith('.exe')) {
    chmodSync(out, 0o755);
  }
}
