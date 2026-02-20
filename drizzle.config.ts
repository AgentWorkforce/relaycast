import type { Config } from 'drizzle-kit';

export default {
  schema: './packages/server/src/db/schema.ts',
  out: './packages/server/src/db/migrations',
  dialect: 'sqlite',
  verbose: true,
  strict: true,
} satisfies Config;
