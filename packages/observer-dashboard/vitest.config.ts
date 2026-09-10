import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Use the React automatic JSX runtime so component-level tests don't need
    // to `import React` at the top of every file. Next.js applies the same
    // transform in the app itself.
    jsx: 'automatic',
  },
  test: {
    globals: true,
  },
});
