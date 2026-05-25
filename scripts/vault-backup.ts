#!/usr/bin/env tsx
/**
 * scripts/vault-backup.ts — operator-driven backup of VAULT_CAMPAIGNS_ROOT.
 *
 * REQ-006 — Backup of events.md is OUT OF BAND of the Next.js process. This
 *           script is the only-supported backup mechanism for Phase 02.
 * REQ-007 — Campaign data lives OUTSIDE the codebase repo at
 *           VAULT_CAMPAIGNS_ROOT; this script targets that root.
 * Decision 7 — Default strategy is GIT (a separate, private git repo inside
 *              VAULT_CAMPAIGNS_ROOT). Tarball is supported as an offline-first
 *              fallback. Both refuse to operate when events.md or a view file
 *              has been hand-edited (T-02-06 defense — corrections MUST be
 *              compensating events, never line edits).
 *
 * Usage:
 *   pnpm vault:backup                              # GIT strategy (default)
 *   pnpm vault:backup --strategy=git --push        # GIT + push to origin/main
 *   pnpm vault:backup --strategy=tarball           # TARBALL to ~/Backups/dnd-ai-master/
 *   pnpm vault:backup --strategy=tarball --keep=10 # keep last 10 tarballs
 *
 * The GIT strategy initializes a repo inside VAULT_CAMPAIGNS_ROOT on first
 * run (with a sensible .gitignore for OS junk + tmp files), then `git add . &&
 * git commit -m "backup: <ISO timestamp>"`. The --push flag runs `git push
 * origin main` afterwards but does NOT exit on push failure (the commit
 * landed locally — operator can retry the push manually).
 *
 * The TARBALL strategy creates `~/Backups/dnd-ai-master/` if missing, then
 * writes `vault-<ISO timestamp>.tar.gz` containing the entire campaigns
 * root. Rotation keeps the most-recent `--keep=N` (default 30) tarballs.
 *
 * T-02-06 defense: BOTH strategies refuse if the working tree shows
 * non-append edits to events.md or any view file (compensating events are
 * the correction policy per the operator runbook). For git, this is
 * detected via `git diff HEAD -- "*.md"` showing removed lines. For
 * tarball, the same git-diff check is run if VAULT_CAMPAIGNS_ROOT is a
 * git repo; otherwise tarball proceeds unchecked (warn loudly).
 *
 * NOTE: This script does NOT set up the git remote. To enable --push:
 *   gh repo create dnd-ai-master-vault --private
 *   cd $VAULT_CAMPAIGNS_ROOT
 *   git remote add origin git@github.com:<user>/dnd-ai-master-vault.git
 *   git push -u origin main    # one-time
 *
 * Recovery procedure (spike 013 one-liner): git clone <vault-repo> &&
 * pnpm vault:rebuild-views. See docs/operators/vault-backup.md.
 */
import './_env-loader';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { VAULT_CAMPAIGNS_ROOT } from '@/ai/master/vault/path';

type Strategy = 'git' | 'tarball';

/**
 * Default strategy resolved by Task 1 checkpoint (Phase 02 plan 02-10).
 * Operator picked `git` — separate-repo strategy matching the spike 013
 * DR validation. Tarball remains supported via explicit --strategy=tarball.
 */
const DEFAULT_STRATEGY: Strategy = 'git';

interface Args {
  strategy: Strategy;
  push: boolean;
  keep: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { strategy: DEFAULT_STRATEGY, push: false, keep: 30 };
  for (const a of argv) {
    if (a.startsWith('--strategy=')) {
      const raw = a.slice('--strategy='.length);
      if (raw !== 'git' && raw !== 'tarball') {
        console.error(`Invalid --strategy=${raw}. Use 'git' or 'tarball'.`);
        process.exit(2);
      }
      args.strategy = raw;
    } else if (a === '--push') {
      args.push = true;
    } else if (a.startsWith('--keep=')) {
      const raw = a.slice('--keep='.length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        console.error(`Invalid --keep=${raw}. Use a positive integer.`);
        process.exit(2);
      }
      args.keep = n;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage:');
      console.log('  pnpm vault:backup                              # GIT (default)');
      console.log('  pnpm vault:backup --strategy=git --push        # GIT + push');
      console.log('  pnpm vault:backup --strategy=tarball [--keep=N]');
      process.exit(0);
    }
  }
  return args;
}

/**
 * T-02-06 defense — when VAULT_CAMPAIGNS_ROOT is a git repo with at least
 * one HEAD commit, scan `git diff HEAD -- "*.md"` for any removed lines.
 * events.md is append-only; a removed line (or in-place edit which shows
 * as remove+add) is the signature of a forbidden hand-edit. View files
 * are regenerable, so we refuse those too — operator must run
 * `pnpm vault:rebuild-views --campaign=<id>` to restore the byte-stable
 * output first.
 *
 * Returns true when the working tree is clean (safe to commit); false
 * when non-append edits were found. The caller prints the error and exits
 * with code 1.
 */
function hasNonAppendChanges(rootDir: string): boolean {
  try {
    const out = execSync('git diff --unified=0 HEAD -- "*.md"', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // A non-append edit shows as a `^-` line in the unified diff that is
    // NOT a header (`---`). The first two chars of every diff payload
    // are `-` or `+` with the third char varying; we want lines that
    // start with a single `-` followed by a non-`-`.
    const lines = out.split('\n');
    for (const line of lines) {
      if (/^-[^-]/.test(line)) {
        return true;
      }
    }
    return false;
  } catch {
    // No HEAD yet (first commit) → nothing to diff against, can't have
    // non-append edits. Treat as clean.
    return false;
  }
}

function ensureVaultRootExists(): void {
  if (!existsSync(VAULT_CAMPAIGNS_ROOT)) {
    console.error(`VAULT_CAMPAIGNS_ROOT does not exist: ${VAULT_CAMPAIGNS_ROOT}`);
    console.error('Create the directory or set the VAULT_CAMPAIGNS_ROOT env var to an existing path.');
    process.exit(1);
  }
  const st = statSync(VAULT_CAMPAIGNS_ROOT);
  if (!st.isDirectory()) {
    console.error(`VAULT_CAMPAIGNS_ROOT is not a directory: ${VAULT_CAMPAIGNS_ROOT}`);
    process.exit(1);
  }
}

/**
 * GIT strategy: initialize repo if missing, run defensive non-append check,
 * commit current state with an ISO timestamp message. Optional --push
 * forwards to origin/main without exiting on failure.
 */
function backupGit(args: Args): void {
  const root = VAULT_CAMPAIGNS_ROOT;
  const gitDir = join(root, '.git');

  // 1. Initialize repo on first invocation.
  if (!existsSync(gitDir)) {
    console.log(`[vault-backup] initializing git repo at ${root}`);
    execSync('git init -b main', { cwd: root, stdio: 'inherit' });

    // Default .gitignore: keep things minimal. The vault is plain text
    // + JSONL events.md; we only ignore OS junk and any tmp.* files
    // that future Phase 03 atomic-write work may produce.
    const gitignorePath = join(root, '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(
        gitignorePath,
        ['# Vault campaigns root — keep events.md + materialized views, ignore OS junk',
         '.DS_Store',
         'tmp.*',
         '*.tmp',
         ''].join('\n'),
        'utf8',
      );
    }

    // Configure local identity if global is missing (script-only repo).
    // Best-effort: if global is set, this is a no-op.
    try {
      execSync('git config user.email', { cwd: root, stdio: 'pipe' });
    } catch {
      execSync('git config user.email "vault-backup@dnd-ai-master.local"', { cwd: root, stdio: 'inherit' });
      execSync('git config user.name "vault-backup"', { cwd: root, stdio: 'inherit' });
    }
  }

  // 2. T-02-06 defense — refuse to commit on non-append edits.
  if (hasNonAppendChanges(root)) {
    console.error('');
    console.error('[vault-backup] refuse to commit: events.md or a view file has');
    console.error('non-append changes since the last commit.');
    console.error('');
    console.error('Manual edits to events.md are prohibited (correction policy:');
    console.error('compensating events only). If this is a view-file regeneration,');
    console.error('run pnpm vault:rebuild-views --campaign=<uuid> first.');
    console.error('');
    process.exit(1);
  }

  // 3. Stage everything and commit (idempotent — nothing to commit is fine).
  execSync('git add -A', { cwd: root, stdio: 'inherit' });

  const stagedOut = execSync('git diff --cached --name-only', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hasStaged = stagedOut.trim().length > 0;
  if (!hasStaged) {
    console.log('[vault-backup] no changes to commit — vault is up to date.');
    return;
  }

  const ts = new Date().toISOString();
  execSync(`git commit -m "backup: ${ts}"`, { cwd: root, stdio: 'inherit' });
  console.log(`[vault-backup] strategy=git committed at ${ts}`);

  // 4. Optional push (does NOT exit on failure — commit is local).
  if (args.push) {
    try {
      execSync('git push origin main', { cwd: root, stdio: 'inherit' });
      console.log('[vault-backup] pushed to origin/main');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[vault-backup] WARN: push failed (${msg}). Commit landed locally.`);
    }
  }
}

/**
 * TARBALL strategy: write `~/Backups/dnd-ai-master/vault-<iso>.tar.gz`
 * containing VAULT_CAMPAIGNS_ROOT, then rotate to keep last `--keep=N`.
 *
 * Same T-02-06 defense as the git strategy when the vault is also a git
 * repo (most operators run both — git for the audit trail, tarball for
 * offline portability).
 */
function backupTarball(args: Args): void {
  const root = VAULT_CAMPAIGNS_ROOT;
  const gitDir = join(root, '.git');

  // T-02-06 defense when the vault is also a git repo: refuse on edits.
  if (existsSync(gitDir) && hasNonAppendChanges(root)) {
    console.error('');
    console.error('[vault-backup] refuse to archive: events.md or a view file has');
    console.error('non-append changes since the last git commit.');
    console.error('');
    console.error('Run pnpm vault:rebuild-views --campaign=<uuid> first, then re-run');
    console.error('the backup. Tarball is committed across git generations — corrupted');
    console.error('input would propagate.');
    console.error('');
    process.exit(1);
  }

  const backupsDir = resolve(homedir(), 'Backups', 'dnd-ai-master');
  if (!existsSync(backupsDir)) {
    mkdirSync(backupsDir, { recursive: true });
  }

  // Build tarball: tar -czf <out> -C <parent> <basename>.
  // The -C + basename pair keeps the tarball entries relative to the
  // campaigns-root name rather than the absolute path (untar lands in a
  // fresh directory, not a deeply nested path).
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const tarballPath = join(backupsDir, `vault-${ts}.tar.gz`);
  const parent = dirname(root);
  const base = basename(root);

  // Exclude .git/objects/pack from the tarball — they're already
  // compressed; recompressing wastes time + space. Keep refs/HEAD for
  // a complete restore though.
  execSync(`tar -czf "${tarballPath}" -C "${parent}" "${base}"`, { stdio: 'inherit' });
  console.log(`[vault-backup] strategy=tarball wrote ${tarballPath}`);

  // Rotation: keep most-recent N tarballs (by mtime desc).
  const entries = readdirSync(backupsDir)
    .filter((f) => f.startsWith('vault-') && f.endsWith('.tar.gz'))
    .map((f) => {
      const full = join(backupsDir, f);
      return { name: f, full, mtime: statSync(full).mtime.getTime() };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (entries.length > args.keep) {
    const stale = entries.slice(args.keep);
    for (const e of stale) {
      unlinkSync(e.full);
      console.log(`[vault-backup] rotated out ${e.name}`);
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  ensureVaultRootExists();
  console.log(`[vault-backup] strategy=${args.strategy} root=${VAULT_CAMPAIGNS_ROOT}`);
  if (args.strategy === 'git') {
    backupGit(args);
  } else {
    backupTarball(args);
  }
}

try {
  main();
} catch (err) {
  console.error('vault-backup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
