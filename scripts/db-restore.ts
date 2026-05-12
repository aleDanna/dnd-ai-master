/**
 * Restore a .dump file from .snapshots/ into the local Postgres.
 *
 * Uses a Docker container with pg_restore so no host install is required. By default it
 * targets LOCAL_DATABASE_URL or postgresql://postgres:postgres@localhost:5432/dnd_ai.
 *
 * Usage:
 *   pnpm db:restore                              # restores the newest .dump in .snapshots/
 *   pnpm db:restore .snapshots/dnd-...dump       # specific file
 *   LOCAL_DATABASE_URL=... pnpm db:restore       # override target
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { loadDbEnv } from '../src/db/connection-url';

loadDbEnv();

const PG_IMAGE = 'postgres:17';
const SNAPSHOT_DIR = resolve(process.cwd(), '.snapshots');
const DEFAULT_LOCAL_URL = 'postgresql://postgres:postgres@localhost:5433/dnd_ai';

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

function pickNewestDump(): string | null {
  if (!existsSync(SNAPSHOT_DIR)) return null;
  const entries = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.endsWith('.dump'))
    .map((f) => ({ name: f, mtime: statSync(resolve(SNAPSHOT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.name ?? null;
}

function main() {
  const argFile = process.argv[2];
  let filename: string;
  if (argFile) {
    const abs = isAbsolute(argFile) ? argFile : resolve(process.cwd(), argFile);
    if (!existsSync(abs)) { console.error(`File not found: ${argFile}`); process.exit(2); }
    filename = basename(abs);
    if (resolve(abs, '..') !== SNAPSHOT_DIR) {
      console.error(`Snapshot must live under .snapshots/ (got ${abs}).`);
      process.exit(2);
    }
  } else {
    const newest = pickNewestDump();
    if (!newest) { console.error('No .dump found in .snapshots/. Run `pnpm db:snapshot` first.'); process.exit(2); }
    filename = newest;
  }

  const target = process.env.LOCAL_DATABASE_URL || DEFAULT_LOCAL_URL;
  const dockerUrl = rewriteHostForDocker(target);

  const targetHostname = (() => { try { return new URL(target).hostname; } catch { return '<invalid>'; } })();
  console.log(`Restoring .snapshots/${filename} → ${targetHostname}`);

  const r = spawnSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${SNAPSHOT_DIR}:/snapshots:ro`,
      '-e', `PG_URL=${dockerUrl}`,
      PG_IMAGE,
      'sh', '-c',
      // --clean --if-exists wipes the existing schema before restoring (idempotent).
      `pg_restore --clean --if-exists --no-owner --no-privileges -d "$PG_URL" /snapshots/${filename}`,
    ],
    { stdio: 'inherit' }
  );

  // pg_restore exits with 1 if any error was encountered, even non-fatal ones (e.g. role
  // doesn't exist on the target). We treat 1 as "completed with warnings" and let the caller
  // judge; only fail outright on status >= 2.
  if (r.status === null || r.status > 1) {
    console.error(`pg_restore exited with status ${r.status}`);
    process.exit(r.status ?? 1);
  }
  if (r.status === 1) {
    console.warn('pg_restore completed with warnings (status 1). Review output above.');
  } else {
    console.log('✓ Restore complete.');
  }
}

main();
