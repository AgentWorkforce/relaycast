import type { Config } from 'drizzle-kit';

export default {
  schema: './packages/server/src/db/schema.ts',
  out: './packages/server/src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://relay:relay@localhost:5432/relay',
  },
  verbose: true,
  strict: true,
} satisfies Config;
