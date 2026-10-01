import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next compiles JSX with the automatic runtime; tests must match, or a
  // component that (correctly) never imports React fails only under vitest.
  esbuild: { jsx: 'automatic' },
  test: {
    globals: true,
  },
});
