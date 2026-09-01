import { defineConfig } from 'drizzle-kit';

/*
 * Migrations are generated, reviewed, then applied — never pushed straight to a
 * database. `drizzle-kit push` is convenient and will happily drop a column it
 * thinks is unused; on a table holding subscription state that is an outage and
 * a support incident. `generate` produces SQL you can read first.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
