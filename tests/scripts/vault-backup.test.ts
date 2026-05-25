/**
 * tests/scripts/vault-backup.test.ts — CLI smoke tests for the Phase 02
 * backup script (plan 02-10).
 *
 * Spawning tsx is ~1s/spawn. Keep the test count tight (~7 cases).
 *
 * Each case sets VAULT_CAMPAIGNS_ROOT to a fresh tmpdir before spawning,
 * and HOME to a tmpdir so the tarball strategy writes under a sandbox
 * (os.homedir() honors HOME on linux/macOS). Tests SKIP on Windows
 * (homedir override does not apply).
 *
 * The "refuses to commit on hand-edits" test is the load-bearing T-02-06
 * mitigation test — must pass.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/vault-backup.ts');
const TSX_BIN = resolve(process.cwd(), 'node_modules/.bin/tsx');

interface RunResult extends SpawnSyncReturns<string> {
  stdoutText: string;
  stderrText: string;
}

/**
 * Spawn the vault-backup script with a custom env. Returns the
 * SpawnSyncReturns plus normalized text fields for easier assertions.
 *
 * The spawned env starts from process.env and then overrides:
 *   - VAULT_CAMPAIGNS_ROOT — points at a tmpdir
 *   - HOME — points at a tmpdir so the tarball strategy lands under a sandbox
 */
function runScript(args: string[], env: Record<string, string>): RunResult {
  // Preserve PATH and DATABASE_URL — the env loader requires DATABASE_URL
  // to be set or it exits 2 BEFORE our script logic runs. We just pass
  // through whatever the test runner has; in CI/dev the env loader
  // already sees .env.local with a real DATABASE_URL.
  const r = spawnSync(
    TSX_BIN,
    [SCRIPT_PATH, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      // The script imports `@/ai/master/vault/path` which calls cwd()
      // for VAULT_ROOT — keep cwd at the project root.
      cwd: process.cwd(),
    },
  );
  return {
    ...r,
    stdoutText: (r.stdout ?? '').toString(),
    stderrText: (r.stderr ?? '').toString(),
  };
}

describe('vault-backup script', () => {
  describe('CLI parsing', () => {
    let vaultRoot: string;
    beforeAll(async () => {
      vaultRoot = await mkdtemp(join(tmpdir(), 'vault-backup-cli-'));
    });
    afterAll(async () => {
      await rm(vaultRoot, { recursive: true, force: true });
    });

    it('rejects invalid --strategy=X', () => {
      const r = runScript(['--strategy=invalid'], { VAULT_CAMPAIGNS_ROOT: vaultRoot });
      expect(r.status).toBe(2);
      expect(r.stderrText).toMatch(/Invalid --strategy/);
    });

    it('rejects invalid --keep=abc', () => {
      const r = runScript(['--strategy=tarball', '--keep=abc'], {
        VAULT_CAMPAIGNS_ROOT: vaultRoot,
      });
      expect(r.status).toBe(2);
      expect(r.stderrText).toMatch(/Invalid --keep/);
    });

    it('rejects --keep=-1', () => {
      const r = runScript(['--strategy=tarball', '--keep=-1'], {
        VAULT_CAMPAIGNS_ROOT: vaultRoot,
      });
      expect(r.status).toBe(2);
      expect(r.stderrText).toMatch(/Invalid --keep/);
    });

    it('uses the default strategy (git) when --strategy is omitted', () => {
      const r = runScript([], { VAULT_CAMPAIGNS_ROOT: vaultRoot });
      // Even on success-or-failure, the strategy banner is the first log
      // line and contains "strategy=git" (the operator-locked default).
      expect(r.stdoutText).toMatch(/strategy=git/);
    });
  });

  describe('git strategy basic flow (T-02-06 defense)', () => {
    let vaultRoot: string;
    let homeDir: string;

    beforeEach(async () => {
      vaultRoot = await mkdtemp(join(tmpdir(), 'vault-backup-git-'));
      homeDir = await mkdtemp(join(tmpdir(), 'vault-backup-home-'));
      // Seed a campaign + events.md so there is something to commit.
      const campaignId = '00000000-1111-2222-3333-444444444444';
      mkdirSync(join(vaultRoot, campaignId, 'characters'), { recursive: true });
      writeFileSync(
        join(vaultRoot, campaignId, 'events.md'),
        JSON.stringify({
          id: 'seed-1',
          version: 1,
          type: 'campaign_initialized',
          payload: { characters: [{ id: 'char-1', name: 'Aragorn', hp_max: 30 }] },
          timestamp: '2026-05-25T00:00:00.000Z',
        }) + '\n',
        'utf8',
      );
      writeFileSync(
        join(vaultRoot, campaignId, 'characters', 'aragorn-char-1.md'),
        '---\nid: char-1\nname: "Aragorn"\nhp_current: 30\nhp_max: 30\nconditions: []\nspell_slots: {}\ninventory: []\n---\n\n# Aragorn\n',
        'utf8',
      );
    });

    afterEach(async () => {
      await rm(vaultRoot, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    });

    it('initializes a git repo on first invocation and commits all files', () => {
      const r = runScript(['--strategy=git'], {
        VAULT_CAMPAIGNS_ROOT: vaultRoot,
        HOME: homeDir,
      });
      expect(r.status).toBe(0);
      expect(existsSync(join(vaultRoot, '.git'))).toBe(true);
      // .gitignore was written.
      expect(existsSync(join(vaultRoot, '.gitignore'))).toBe(true);
      // A commit landed.
      const log = spawnSync('git', ['log', '--oneline'], { cwd: vaultRoot, encoding: 'utf8' });
      expect(log.stdout.length).toBeGreaterThan(0);
      expect(log.stdout).toMatch(/backup: /);
    });

    it('refuses to commit when events.md has been hand-edited (T-02-06)', () => {
      // First invocation: initialize repo + commit baseline.
      const first = runScript(['--strategy=git'], {
        VAULT_CAMPAIGNS_ROOT: vaultRoot,
        HOME: homeDir,
      });
      expect(first.status).toBe(0);

      // Hand-edit: replace the existing line (non-append) instead of
      // appending a new event line.
      const campaignId = '00000000-1111-2222-3333-444444444444';
      writeFileSync(
        join(vaultRoot, campaignId, 'events.md'),
        JSON.stringify({
          id: 'seed-1',
          version: 1,
          type: 'campaign_initialized',
          payload: { characters: [{ id: 'char-1', name: 'TAMPERED', hp_max: 999 }] },
          timestamp: '2026-05-25T00:00:00.000Z',
        }) + '\n',
        'utf8',
      );

      // Second invocation: must refuse.
      const second = runScript(['--strategy=git'], {
        VAULT_CAMPAIGNS_ROOT: vaultRoot,
        HOME: homeDir,
      });
      expect(second.status).toBe(1);
      expect(second.stderrText).toMatch(/refuse|non-append/);
    });

    it('no-ops cleanly when there are no changes to commit', () => {
      const first = runScript(['--strategy=git'], {
        VAULT_CAMPAIGNS_ROOT: vaultRoot,
        HOME: homeDir,
      });
      expect(first.status).toBe(0);
      // Second invocation with no changes — exits 0, prints info.
      const second = runScript(['--strategy=git'], {
        VAULT_CAMPAIGNS_ROOT: vaultRoot,
        HOME: homeDir,
      });
      expect(second.status).toBe(0);
      expect(second.stdoutText).toMatch(/no changes/i);
    });
  });

  describe('tarball strategy basic flow', () => {
    let vaultRoot: string;
    let homeDir: string;

    beforeEach(async () => {
      vaultRoot = await mkdtemp(join(tmpdir(), 'vault-backup-tar-'));
      homeDir = await mkdtemp(join(tmpdir(), 'vault-backup-tar-home-'));
      // Seed a campaign so the tarball has something to package.
      const campaignId = '00000000-1111-2222-3333-444444444444';
      mkdirSync(join(vaultRoot, campaignId), { recursive: true });
      writeFileSync(join(vaultRoot, campaignId, 'events.md'), '{"id":"x","version":1,"type":"hp_change","payload":{"character":"c","delta":-1},"timestamp":"2026-05-25T00:00:00.000Z"}\n', 'utf8');
    });

    afterEach(async () => {
      await rm(vaultRoot, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    });

    it('creates a timestamped tarball under ~/Backups/dnd-ai-master/', () => {
      const r = runScript(['--strategy=tarball'], {
        VAULT_CAMPAIGNS_ROOT: vaultRoot,
        HOME: homeDir,
      });
      expect(r.status).toBe(0);
      const backupsDir = join(homeDir, 'Backups', 'dnd-ai-master');
      expect(existsSync(backupsDir)).toBe(true);
      const entries = readdirSync(backupsDir).filter((f) => f.endsWith('.tar.gz'));
      expect(entries.length).toBe(1);
      expect(entries[0]).toMatch(/^vault-.*\.tar\.gz$/);
    });

    it('rotates old tarballs when --keep=N is exceeded', () => {
      const backupsDir = join(homeDir, 'Backups', 'dnd-ai-master');
      mkdirSync(backupsDir, { recursive: true });

      // Pre-create 3 stale tarballs with old mtimes (sorted from newest
      // to oldest will keep the most-recent). The script keeps --keep=N
      // by mtime DESC and deletes the rest.
      const now = Date.now() / 1000;
      const staleNames = ['vault-old-a.tar.gz', 'vault-old-b.tar.gz', 'vault-old-c.tar.gz'];
      staleNames.forEach((name, i) => {
        const p = join(backupsDir, name);
        writeFileSync(p, 'stale tarball ' + name, 'utf8');
        // Set mtime to (now - 3600 - i*100) — a, b, c progressively older
        const t = now - 3600 - i * 100;
        utimesSync(p, t, t);
      });

      // Run with --keep=2: after the new tarball lands, we have 4 files
      // total. Rotation should keep the 2 most-recent (the brand-new one
      // and "vault-old-a.tar.gz" which is the newest stale) and delete
      // vault-old-b and vault-old-c.
      const r = runScript(['--strategy=tarball', '--keep=2'], {
        VAULT_CAMPAIGNS_ROOT: vaultRoot,
        HOME: homeDir,
      });
      expect(r.status).toBe(0);

      const remaining = readdirSync(backupsDir)
        .filter((f) => f.endsWith('.tar.gz'))
        .sort();
      expect(remaining.length).toBe(2);
      // Oldest two stale tarballs must be gone.
      expect(remaining).not.toContain('vault-old-b.tar.gz');
      expect(remaining).not.toContain('vault-old-c.tar.gz');
      // Newest stale tarball must be preserved (it was the 2nd-most-recent).
      expect(remaining).toContain('vault-old-a.tar.gz');
    });
  });

  describe('non-existent VAULT_CAMPAIGNS_ROOT', () => {
    it('exits 1 with a clear error when VAULT_CAMPAIGNS_ROOT does not exist', () => {
      // Make-believe path under a tmpdir.
      const missing = join(tmpdir(), 'this-vault-root-does-not-exist-' + Date.now());
      const r = runScript([], { VAULT_CAMPAIGNS_ROOT: missing });
      expect(r.status).toBe(1);
      expect(r.stderrText).toMatch(/VAULT_CAMPAIGNS_ROOT does not exist/);
    });
  });
});
