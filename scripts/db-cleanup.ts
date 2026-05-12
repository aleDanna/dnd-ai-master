/**
 * DB cleanup tool.
 *
 * Defaults to dry-run (counts only, no writes). Pass --apply to commit.
 *
 * Categories (combine freely):
 *   --soft-deleted-sessions   Hard-delete sessions where deleted_at IS NOT NULL (cascade to messages/state/etc).
 *   --test-users              Delete users matching the test-user pattern (cascade).
 *   --orphan-characters       Delete characters not referenced by any session.
 *   --all-tts                 Wipe tts_cache entirely (frees audio bytea).
 *   --orphan-tts              Delete tts_cache rows whose message no longer exists (normally cascade handles this).
 *   --all                     Shorthand for: --soft-deleted-sessions --test-users --orphan-characters --orphan-tts
 *
 * Options:
 *   --apply                   Actually execute (default is dry-run).
 *   --vacuum                  Run VACUUM FULL on affected tables after COMMIT.
 *   --test-user-pattern=...   Override the regex for test users (POSIX, used in `id ~ pattern`).
 *
 * Examples:
 *   pnpm db:cleanup --soft-deleted-sessions
 *   pnpm db:cleanup --all --apply --vacuum
 */

import { loadDbEnv, normalizeSslMode } from '../src/db/connection-url';
loadDbEnv();

import { Pool, PoolClient } from 'pg';

const DEFAULT_TEST_USER_RE = '^user_(app|history|test)_[0-9]+$';

type Flags = {
  apply: boolean;
  vacuum: boolean;
  softDeleted: boolean;
  testUsers: boolean;
  orphanChars: boolean;
  allTts: boolean;
  orphanTts: boolean;
  testUserPattern: string;
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    apply: false,
    vacuum: false,
    softDeleted: false,
    testUsers: false,
    orphanChars: false,
    allTts: false,
    orphanTts: false,
    testUserPattern: DEFAULT_TEST_USER_RE,
  };
  for (const a of argv) {
    if (a === '--apply') f.apply = true;
    else if (a === '--vacuum') f.vacuum = true;
    else if (a === '--soft-deleted-sessions') f.softDeleted = true;
    else if (a === '--test-users') f.testUsers = true;
    else if (a === '--orphan-characters') f.orphanChars = true;
    else if (a === '--all-tts') f.allTts = true;
    else if (a === '--orphan-tts') f.orphanTts = true;
    else if (a === '--all') {
      f.softDeleted = true;
      f.testUsers = true;
      f.orphanChars = true;
      f.orphanTts = true;
    } else if (a.startsWith('--test-user-pattern=')) {
      f.testUserPattern = a.slice('--test-user-pattern='.length);
    } else if (a === '--help' || a === '-h') {
      console.log(headerHelp());
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}\n${headerHelp()}`);
      process.exit(2);
    }
  }
  return f;
}

function headerHelp(): string {
  return [
    'Usage: tsx scripts/db-cleanup.ts [flags]',
    '',
    'Categories:',
    '  --soft-deleted-sessions   Hard-delete sessions with deleted_at IS NOT NULL (cascade).',
    '  --test-users              Delete users matching the test-user regex (cascade).',
    '  --orphan-characters       Delete characters not referenced by any session.',
    '  --all-tts                 Wipe tts_cache entirely.',
    '  --orphan-tts              Delete tts_cache rows whose message no longer exists.',
    '  --all                     Soft-deleted + test-users + orphan-characters + orphan-tts.',
    '',
    'Options:',
    '  --apply                   Execute (default: dry-run).',
    '  --vacuum                  VACUUM FULL affected tables after COMMIT.',
    '  --test-user-pattern=RE    Override regex (default: ' + DEFAULT_TEST_USER_RE + ')',
  ].join('\n');
}

async function preview(c: PoolClient, flags: Flags) {
  const out: Array<{ category: string; count: number; note?: string }> = [];

  if (flags.softDeleted) {
    const r = await c.query(`SELECT count(*)::int AS n FROM sessions WHERE deleted_at IS NOT NULL`);
    out.push({ category: 'soft-deleted-sessions', count: r.rows[0].n, note: 'cascades to messages/state/chapters/dice/codex/combat/inventory' });
  }
  if (flags.testUsers) {
    const r = await c.query(`SELECT count(*)::int AS n FROM users WHERE id ~ $1`, [flags.testUserPattern]);
    out.push({ category: 'test-users', count: r.rows[0].n, note: `pattern=${flags.testUserPattern}, cascades to characters/sessions` });
  }
  if (flags.orphanChars) {
    const r = await c.query(`
      SELECT count(*)::int AS n FROM characters c
      WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.character_id = c.id)
    `);
    out.push({ category: 'orphan-characters', count: r.rows[0].n, note: 'characters with zero session references' });
  }
  if (flags.allTts) {
    const r = await c.query(`SELECT count(*)::int AS n FROM tts_cache`);
    out.push({ category: 'all-tts', count: r.rows[0].n, note: 'wipes entire tts_cache' });
  } else if (flags.orphanTts) {
    const r = await c.query(`
      SELECT count(*)::int AS n FROM tts_cache t
      LEFT JOIN session_messages m ON m.id = t.message_id WHERE m.id IS NULL
    `);
    out.push({ category: 'orphan-tts', count: r.rows[0].n });
  }
  return out;
}

async function dbSize(c: PoolClient): Promise<string> {
  const r = await c.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS v`);
  return r.rows[0].v;
}

async function runDeletes(c: PoolClient, flags: Flags) {
  const sessionIdsToDelete = new Set<string>();
  if (flags.softDeleted) {
    const r = await c.query(`SELECT id FROM sessions WHERE deleted_at IS NOT NULL`);
    for (const row of r.rows) sessionIdsToDelete.add(row.id);
  }
  if (flags.testUsers) {
    const r = await c.query(`SELECT id FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id ~ $1)`, [flags.testUserPattern]);
    for (const row of r.rows) sessionIdsToDelete.add(row.id);
  }

  // ai_usage has FK SET NULL on session_id, so we must purge those rows BEFORE the sessions disappear
  // (otherwise they survive as session_id=NULL and look like legit "no_session" rows).
  if (sessionIdsToDelete.size > 0) {
    const r = await c.query(
      `DELETE FROM ai_usage WHERE session_id = ANY($1::uuid[])`,
      [Array.from(sessionIdsToDelete)]
    );
    console.log(`  ai_usage (sessions about to drop): -${r.rowCount}`);
  }

  if (flags.allTts) {
    const r = await c.query(`DELETE FROM tts_cache`);
    console.log(`  tts_cache (all): -${r.rowCount}`);
  } else if (flags.orphanTts) {
    const r = await c.query(`
      DELETE FROM tts_cache
      WHERE message_id NOT IN (SELECT id FROM session_messages)
    `);
    console.log(`  tts_cache (orphan): -${r.rowCount}`);
  }

  if (flags.testUsers) {
    const r = await c.query(`DELETE FROM users WHERE id ~ $1`, [flags.testUserPattern]);
    console.log(`  users (test): -${r.rowCount}`);
  }

  if (flags.softDeleted) {
    const r = await c.query(`DELETE FROM sessions WHERE deleted_at IS NOT NULL`);
    console.log(`  sessions (soft-deleted): -${r.rowCount}`);
  }

  if (flags.orphanChars) {
    const r = await c.query(`
      DELETE FROM characters c
      WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.character_id = c.id)
    `);
    console.log(`  characters (orphan): -${r.rowCount}`);
  }
}

async function vacuumFull(c: PoolClient) {
  const tables = [
    'tts_cache', 'session_state', 'session_messages', 'session_chapters',
    'dice_log', 'codex_entities', 'combat_actors', 'inventory_grants',
    'ai_usage', 'sessions', 'characters', 'users',
  ];
  for (const t of tables) {
    const before = await c.query(`SELECT pg_size_pretty(pg_total_relation_size($1)) AS v`, [t]);
    try {
      await c.query(`VACUUM FULL "${t}"`);
      const after = await c.query(`SELECT pg_size_pretty(pg_total_relation_size($1)) AS v`, [t]);
      console.log(`  ✓ ${t.padEnd(20)} ${before.rows[0].v.padStart(10)} → ${after.rows[0].v.padStart(10)}`);
    } catch (e) {
      console.log(`  ✗ ${t}: ${(e as Error).message}`);
    }
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const nothingSelected = !flags.softDeleted && !flags.testUsers && !flags.orphanChars && !flags.allTts && !flags.orphanTts;
  if (nothingSelected) {
    console.log(headerHelp());
    console.log('\nNo category selected. Exiting without doing anything.');
    return;
  }

  const pool = new Pool({ connectionString: normalizeSslMode(process.env.DATABASE_URL!), max: 2 });
  const c = await pool.connect();

  try {
    console.log(`DB size before: ${await dbSize(c)}\n`);

    console.log('=== DRY-RUN PREVIEW ===');
    const plan = await preview(c, flags);
    console.table(plan);

    if (!flags.apply) {
      console.log('\nDry-run only (pass --apply to execute).');
      return;
    }

    console.log('\n=== APPLYING (transaction) ===');
    await c.query('BEGIN');
    await runDeletes(c, flags);
    await c.query('COMMIT');
    console.log('COMMIT ok.');

    console.log(`\nDB size after deletes (pre-vacuum): ${await dbSize(c)}`);

    if (flags.vacuum) {
      console.log('\n=== VACUUM FULL ===');
      await vacuumFull(c);
      console.log(`\nDB size after vacuum: ${await dbSize(c)}`);
    } else {
      console.log('\nTip: pass --vacuum to reclaim disk space immediately.');
    }
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    console.error('\nERROR (rolled back):', e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

main();
