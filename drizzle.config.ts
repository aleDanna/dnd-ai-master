import { defineConfig } from 'drizzle-kit';
import { loadDbEnv, normalizeSslMode } from './src/db/connection-url';

loadDbEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required for drizzle-kit');
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: normalizeSslMode(url) },
  strict: true,
  verbose: true,
});
