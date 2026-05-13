/**
 * Dump a Postgres database into .snapshots/dnd-<timestamp>.dump using pg_dump (custom format).
 *
 * Uses a Docker container so no host pg_dump install is required. Defaults to dumping
 * SOURCE_DATABASE_URL (or DATABASE_URL if not set) — typically your Supabase instance.
 *
 * Usage:
 *   pnpm db:snapshot                          # dumps $DATABASE_URL
 *   SOURCE_DATABASE_URL=... pnpm db:snapshot  # explicit source
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDbEnv } from '../src/db/connection-url';

loadDbEnv();

const PG_IMAGE = 'postgres:17';
const SNAPSHOT_DIR = resolve(process.cwd(), '.snapshots');

function rewriteHostForDocker(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      u.hostname = 'host.docker.internal';
    }
    return u.toString();
  } catch {
    return url;
  }
}

function main() {
  const source = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
  if (!source) {
    console.error('Set SOURCE_DATABASE_URL (or DATABASE_URL) before running.');
    process.exit(2);
  }
  if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const filename = `dnd-${ts}.dump`;
  const dockerUrl = rewriteHostForDocker(source);

  const sourceHost = (() => {
    try { return new URL(source).hostname; } catch { return '<invalid url>'; }
  })();
  console.log(`Dumping from ${sourceHost} → .snapshots/${filename}`);

  const r = spawnSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${SNAPSHOT_DIR}:/snapshots`,
      '-e', `PG_URL=${dockerUrl}`,
      PG_IMAGE,
      'sh', '-c', `pg_dump -Fc --no-owner --no-privileges -d "$PG_URL" -f /snapshots/${filename}`,
    ],
    { stdio: 'inherit' }
  );

  if (r.status !== 0) {
    console.error(`pg_dump exited with status ${r.status}`);
    process.exit(r.status ?? 1);
  }
  console.log(`✓ Snapshot saved: .snapshots/${filename}`);
}

main();
