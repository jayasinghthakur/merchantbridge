import { defineConfig } from 'drizzle-kit';

// Generate only (no credentials needed): `pnpm --filter @mb/db exec drizzle-kit generate`.
// Deploys apply the SQL with migratePostgres() from src/client.ts, not with drizzle-kit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
