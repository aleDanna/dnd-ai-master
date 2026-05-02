import { config as loadEnv } from 'dotenv';
// Load .env.local first (Next.js convention, contains Vercel-pulled secrets),
// then fall back to .env.
loadEnv({ path: '.env.local' });
loadEnv();

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

/**
 * Lock sslmode=verify-full so we keep the current strict behavior before
 * pg-connection-string v3 / pg v9 change the default. Aliased modes
 * (prefer / require / verify-ca) currently behave like verify-full but emit
 * a deprecation warning at module load.
 */
function lockSslModeVerifyFull(url: string): string {
  try {
    const parsed = new URL(url);
    const current = parsed.searchParams.get('sslmode');
    if (!current || ['prefer', 'require', 'verify-ca'].includes(current)) {
      parsed.searchParams.set('sslmode', 'verify-full');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

declare global {
  var __dnd_pg_pool: Pool | undefined;
}

const pool =
  globalThis.__dnd_pg_pool ??
  new Pool({ connectionString: lockSslModeVerifyFull(connectionString), max: 10, idleTimeoutMillis: 30_000 });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__dnd_pg_pool = pool;
}

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { pool };
