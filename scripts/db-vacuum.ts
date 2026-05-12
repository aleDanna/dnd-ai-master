/**
 * Run VACUUM FULL on a list of tables (default: all public tables) and report
 * how much disk each one freed.
 *
 * Usage:
 *   pnpm db:vacuum                  # vacuums all public tables
 *   pnpm db:vacuum tts_cache ai_usage    # vacuums only the listed tables
 */

import { loadDbEnv, normalizeSslMode } from '../src/db/connection-url';
loadDbEnv();

import { Client } from 'pg';

async function main() {
  const arg = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const client = new Client({ connectionString: normalizeSslMode(process.env.DATABASE_URL!) });
  await client.connect();

  let tables: string[] = arg;
  if (tables.length === 0) {
    const r = await client.query(`
      SELECT relname AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC
    `);
    tables = r.rows.map((row) => row.t as string);
  }

  const before = (await client.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS v, pg_database_size(current_database())::bigint AS b`
  )).rows[0];
  console.log('Before:', before);

  for (const t of tables) {
    const t0 = Date.now();
    try {
      const sb = await client.query(`SELECT pg_size_pretty(pg_total_relation_size($1)) AS v`, [t]);
      await client.query(`VACUUM FULL "${t}"`);
      const sa = await client.query(`SELECT pg_size_pretty(pg_total_relation_size($1)) AS v`, [t]);
      console.log(
        `  ✓ ${t.padEnd(22)} ${sb.rows[0].v.padStart(10)} → ${sa.rows[0].v.padStart(10)}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`
      );
    } catch (e) {
      console.log(`  ✗ ${t}: ${(e as Error).message}`);
    }
  }

  const after = (await client.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS v, pg_database_size(current_database())::bigint AS b`
  )).rows[0];
  console.log('\nAfter: ', after);
  const saved = Number(before.b) - Number(after.b);
  console.log(
    `Saved ≈ ${(saved / 1024 / 1024).toFixed(1)} MB (${((saved / Number(before.b)) * 100).toFixed(1)}%)`
  );

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
