import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client';

async function main() {
  console.log('[migrate] applying migrations from ./drizzle');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[migrate] done');
  await pool.end();
}

main().catch(async (err) => {
  console.error('[migrate] failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
