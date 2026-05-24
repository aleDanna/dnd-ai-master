import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { safeVaultPath, readVaultFile, listVaultDir, VAULT_ROOT, VAULT_CAMPAIGNS_ROOT } from '@/ai/master/vault/path';

describe('vault/path', () => {
  let root: string;
  let outsideTarget: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-path-test-'));
    root = join(dir, 'vault');
    outsideTarget = join(dir, 'outside-target.txt');
    await mkdir(root, { recursive: true });
    await mkdir(join(root, 'handbook', 'spells'), { recursive: true });
    await mkdir(join(root, 'handbook', 'lore'), { recursive: true });
    await mkdir(join(root, 'tools'), { recursive: true });
    await writeFile(join(root, 'handbook', 'spells', 'fireball.md'), 'Fireball deals 8d6 fire damage.', 'utf8');
    await writeFile(join(root, 'tools', 'index.md'), '# Tools index', 'utf8');
    await writeFile(outsideTarget, 'top secret', 'utf8');
  });

  afterAll(async () => {
    await rm(resolve(root, '..'), { recursive: true, force: true });
  });

  describe('safeVaultPath — accepts well-formed paths', () => {
    it('accepts leading-slash form', async () => {
      const result = await safeVaultPath('/handbook/spells/fireball.md', root);
      expect(result).toBe(join(root, 'handbook', 'spells', 'fireball.md'));
    });

    it('accepts no-leading-slash form', async () => {
      const result = await safeVaultPath('handbook/spells/fireball.md', root);
      expect(result).toBe(join(root, 'handbook', 'spells', 'fireball.md'));
    });

    it('accepts a tools/ path', async () => {
      const result = await safeVaultPath('tools/index.md', root);
      expect(result).toBe(join(root, 'tools', 'index.md'));
    });

    it('accepts deeply-nested existing file', async () => {
      const result = await safeVaultPath('/handbook/lore', root);
      expect(result).toBe(join(root, 'handbook', 'lore'));
    });

    it('accepts a path that does not exist yet (lexical check passes)', async () => {
      const result = await safeVaultPath('handbook/monsters/goblin.md', root);
      expect(result).toBe(join(root, 'handbook', 'monsters', 'goblin.md'));
    });
  });

  describe('safeVaultPath — rejects traversal', () => {
    it.each([
      ['../etc/passwd'],
      ['/handbook/../../etc/passwd'],
      ['/handbook/spells/../../../../etc/passwd'],
      ['./../../secret'],
      ['../'],
    ])('rejects %s', async (input) => {
      const result = await safeVaultPath(input, root);
      expect(result).toBeNull();
    });

    it('rejects empty string', async () => {
      const result = await safeVaultPath('', root);
      expect(result).toBeNull();
    });

    it('rejects null-byte injection', async () => {
      const result = await safeVaultPath('handbook/spells/fireball.md\0.txt', root);
      expect(result).toBeNull();
    });
  });

  describe('safeVaultPath — symlink escape', () => {
    it('rejects symlink pointing outside vault root', async () => {
      const linkPath = join(root, 'escape');
      try {
        await symlink(outsideTarget, linkPath);
      } catch {
        // Skip on hosts forbidding symlink creation (Windows CI without privilege).
        return;
      }
      const result = await safeVaultPath('escape', root);
      expect(result).toBeNull();
      await rm(linkPath, { force: true });
    });
  });

  describe('readVaultFile', () => {
    it('returns content for an existing file', async () => {
      const content = await readVaultFile('/handbook/spells/fireball.md', root);
      expect(content).toBe('Fireball deals 8d6 fire damage.');
    });

    it('returns the literal error marker for unsafe path', async () => {
      const content = await readVaultFile('../etc/passwd', root);
      expect(content).toBe('ERROR: path outside vault');
    });

    it('returns the literal error marker for missing file', async () => {
      const content = await readVaultFile('handbook/missing.md', root);
      expect(content).toBe('ERROR: file not found at handbook/missing.md');
    });

    it('does not throw on read errors', async () => {
      await expect(readVaultFile('handbook/missing.md', root)).resolves.toBeTypeOf('string');
    });
  });

  describe('listVaultDir', () => {
    it('returns sorted children for existing directory', async () => {
      const entries = await listVaultDir('/handbook', root);
      expect(entries).toEqual(['lore', 'spells']);
    });

    it('returns [] for missing directory', async () => {
      const entries = await listVaultDir('/does/not/exist', root);
      expect(entries).toEqual([]);
    });

    it('returns [] for unsafe path', async () => {
      const entries = await listVaultDir('../', root);
      expect(entries).toEqual([]);
    });
  });

  describe('purity guard — narrower after REQ-007', () => {
    // path.ts legitimately reads `process.env.VAULT_CAMPAIGNS_ROOT` per
    // REQ-007 (campaign data root is operator-configurable). The strict
    // purity rule applies to `prompt-builder.ts` only (REQ-022, enforced
    // by tests/ai/master/vault/prompt-builder.test.ts).

    it('source file contains no Date.now / Math.random calls', async () => {
      const src = await readFile(resolve(process.cwd(), 'src/ai/master/vault/path.ts'), 'utf8');
      expect(src).not.toMatch(/Date\.now\(/);
      expect(src).not.toMatch(/Math\.random\(/);
    });
  });

  describe('VAULT_ROOT', () => {
    it('points at data/vault under the project root', () => {
      expect(VAULT_ROOT).toBe(resolve(process.cwd(), 'data/vault'));
    });
  });

  describe('VAULT_CAMPAIGNS_ROOT (REQ-007 — out-of-repo campaign data)', () => {
    it('resolves to an absolute path', () => {
      expect(VAULT_CAMPAIGNS_ROOT.startsWith('/')).toBe(true);
    });

    it('is NOT under the project cwd by default (campaigns live outside the repo)', () => {
      // The default is ~/.dnd-ai-master/vault/campaigns/ which sits under
      // home, not under the project. If a developer's HOME is inexplicably
      // the project root, this assertion is meaningless — skip in that case.
      if (process.cwd() === process.env.HOME) return;
      // Honour env override if set at test time (CI may stub VAULT_CAMPAIGNS_ROOT).
      if (process.env.VAULT_CAMPAIGNS_ROOT) return;
      expect(VAULT_CAMPAIGNS_ROOT.startsWith(process.cwd() + '/')).toBe(false);
    });

    it('is distinct from VAULT_ROOT', () => {
      expect(VAULT_CAMPAIGNS_ROOT).not.toBe(VAULT_ROOT);
    });
  });
});
