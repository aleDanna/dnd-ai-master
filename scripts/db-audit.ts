import { loadDbEnv, normalizeSslMode } from '../src/db/connection-url';
loadDbEnv();

import { Pool } from 'pg';

const TEST_USER_RE = "^user_(app|history|test)_[0-9]+$";

async function main() {
  const pool = new Pool({ connectionString: normalizeSslMode(process.env.DATABASE_URL!), max: 2 });

  const dbSize = await pool.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty,
            pg_database_size(current_database())::bigint AS bytes`
  );
  console.log('=== DB SIZE ===');
  console.table(dbSize.rows);

  const tables = await pool.query(`
    SELECT relname AS "table",
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
           pg_size_pretty(pg_relation_size(c.oid))       AS heap,
           pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS idx_toast
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `);
  console.log('\n=== TABLES BY TOTAL SIZE ===');
  console.table(tables.rows);

  console.log('\n=== ROW COUNTS ===');
  const counts: Record<string, number> = {};
  for (const t of tables.rows.map((r) => r.table as string)) {
    try {
      const r = await pool.query(`SELECT count(*)::int AS n FROM "${t}"`);
      counts[t] = r.rows[0].n;
    } catch {
      counts[t] = -1;
    }
  }
  console.table(counts);

  console.log('\n=== USERS (test pattern vs other) ===');
  const userBuckets = await pool.query(
    `SELECT CASE WHEN id ~ $1 THEN 'test' ELSE 'real' END AS bucket,
            count(*)::int AS n
     FROM users GROUP BY 1 ORDER BY 1`,
    [TEST_USER_RE]
  );
  console.table(userBuckets.rows);

  console.log('\n=== SESSIONS (alive vs soft-deleted) ===');
  const sessBuckets = await pool.query(`
    SELECT CASE WHEN deleted_at IS NULL THEN 'alive' ELSE 'soft_deleted' END AS bucket,
           count(*)::int AS n
    FROM sessions GROUP BY 1 ORDER BY 1
  `);
  console.table(sessBuckets.rows);

  const alive = await pool.query(`
    SELECT s.id, s.user_id, s.character_id, left(s.premise, 60) AS premise_preview,
           (SELECT count(*) FROM session_messages m WHERE m.session_id = s.id)::int AS msgs,
           (SELECT count(*) FROM tts_cache t JOIN session_messages m ON m.id = t.message_id WHERE m.session_id = s.id)::int AS tts_rows
    FROM sessions s WHERE s.deleted_at IS NULL
    ORDER BY s.updated_at DESC NULLS LAST
  `);
  console.log('\nAlive sessions:');
  console.table(alive.rows);

  console.log('\n=== CHARACTERS (orphan check) ===');
  const chars = await pool.query(`
    SELECT c.id, c.name, c.level, c.user_id,
           (SELECT count(*) FROM sessions s WHERE s.character_id = c.id AND s.deleted_at IS NULL)::int AS alive_sessions,
           (SELECT count(*) FROM sessions s WHERE s.character_id = c.id AND s.deleted_at IS NOT NULL)::int AS dead_sessions
    FROM characters c
    ORDER BY c.user_id, c.updated_at DESC
  `);
  console.table(chars.rows);

  console.log('\n=== TTS CACHE breakdown ===');
  const ttsTotal = await pool.query(`
    SELECT count(*)::int AS rows,
           pg_size_pretty(coalesce(sum(octet_length(audio_mp3)),0)) AS audio_total,
           min(created_at) AS oldest, max(created_at) AS newest
    FROM tts_cache
  `);
  console.table(ttsTotal.rows);

  if (ttsTotal.rows[0].rows > 0) {
    const ttsBySession = await pool.query(`
      SELECT s.id AS session_id,
             s.deleted_at IS NOT NULL AS deleted,
             count(t.*)::int AS tts_rows,
             pg_size_pretty(sum(octet_length(t.audio_mp3))) AS audio
      FROM tts_cache t
      JOIN session_messages m ON m.id = t.message_id
      JOIN sessions s ON s.id = m.session_id
      GROUP BY s.id, s.deleted_at
      ORDER BY sum(octet_length(t.audio_mp3)) DESC
    `);
    console.log('TTS by session:');
    console.table(ttsBySession.rows);
  }

  console.log('\n=== AI_USAGE by session liveness ===');
  const ai = await pool.query(`
    SELECT CASE WHEN a.session_id IS NULL THEN 'no_session'
                WHEN s.id IS NULL THEN 'dangling'
                WHEN s.deleted_at IS NOT NULL THEN 'soft_deleted_session'
                ELSE 'alive_session' END AS bucket,
           count(*)::int AS n
    FROM ai_usage a LEFT JOIN sessions s ON s.id = a.session_id
    GROUP BY 1 ORDER BY 2 DESC
  `);
  console.table(ai.rows);

  console.log('\n=== FK DELETE RULES ===');
  const fks = await pool.query(`
    SELECT tc.table_name AS child, kcu.column_name AS child_col,
           ccu.table_name AS parent, ccu.column_name AS parent_col,
           rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    ORDER BY tc.table_name, kcu.column_name
  `);
  console.table(fks.rows);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
