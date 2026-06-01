import './_env-loader';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { campaigns } from '@/db/schema';

// Operator script — flip sourceOfTruth on a campaign (pattern from _set-campaign-model.ts).
// Usage: pnpm tsx scripts/_set-source-of-truth.ts <campaign-id-prefix> <vault|postgres>
async function main() {
  const [prefix, value] = process.argv.slice(2);
  if (!prefix || !value) {
    console.error('Usage: tsx scripts/_set-source-of-truth.ts <campaign-id-prefix> <vault|postgres>');
    process.exit(2);
  }
  if (value !== 'vault' && value !== 'postgres') {
    console.error(`Invalid value "${value}" — must be 'vault' or 'postgres'`);
    process.exit(2);
  }
  const sourceOfTruth = value as 'vault' | 'postgres';
  const rows = (await db.execute<{ id: string; name: string; settings: Record<string, unknown> }>(sql`
    SELECT id::text AS id, name, settings FROM campaigns WHERE id::text LIKE ${prefix + '%'} AND deleted_at IS NULL LIMIT 2
  `)).rows;
  if (rows.length === 0) { console.error(`No campaign matches prefix ${prefix}`); process.exit(2); }
  if (rows.length > 1) { console.error(`Ambiguous prefix ${prefix} — matches ${rows.length}`); process.exit(2); }
  const row = rows[0]!;
  const prev = (row.settings as { sourceOfTruth?: string }).sourceOfTruth ?? '(unset)';
  const next = { ...row.settings, sourceOfTruth };
  await db.update(campaigns).set({ settings: next, updatedAt: new Date() }).where(eq(campaigns.id, row.id));
  console.log(`✓ ${row.name} (${row.id.slice(0, 8)}) sourceOfTruth: ${prev} → ${sourceOfTruth}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
