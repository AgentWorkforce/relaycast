import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@relaycast/sdk/internal', replacement: resolve(rootDir, '../sdk-typescript/src/internal.ts') },
      { find: '@relaycast/sdk', replacement: resolve(rootDir, '../sdk-typescript/src/index.ts') },
      { find: '@relaycast/types', replacement: resolve(rootDir, '../types/src/index.ts') },
    ],
  },
  test: {
    globals: true,
  },
});
