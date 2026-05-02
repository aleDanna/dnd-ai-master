import { config as loadEnv } from 'dotenv';
// Load .env.local first (Next.js convention, contains Vercel-pulled secrets),
// then fall back to .env for any keys not defined in .env.local.
loadEnv({ path: '.env.local' });
loadEnv();

import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required for drizzle-kit');
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
