import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/**
 * REQ-007 / T-02-04, T-02-05, T-02-07 — Per-campaign path resolver tests.
 *
 * The module under test reads `VAULT_CAMPAIGNS_ROOT` at module-load
 * (transitively, via `./path`). To exercise env-override behaviour the
 * tests use `vi.stubEnv` + `vi.resetModules()` + dynamic `import()` — the
 * same pattern Phase 01 inherits for any module-load env read.
 *
 * No DB / preferences imports: this test runs cleanly with DATABASE_URL
 * unset. The grep gate in plan 02-02 Task 2 enforces this.
 */

const VALID_UUID = '11111111-2222-3333-4444-555555555555';
const VALID_CHAR_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_VALID_UUID = '22222222-3333-4444-5555-666666666666';
const OTHER_CHAR_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

type CampaignPathsModule = typeof import('@/ai/master/vault/campaign-paths');

async function importWithRoot(root: string): Promise<CampaignPathsModule> {
  vi.stubEnv('VAULT_CAMPAIGNS_ROOT', root);
  vi.resetModules();
  return import('@/ai/master/vault/campaign-paths');
}

describe('campaign-paths', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'gsd-test-vault-'));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe('UUID_REGEX', () => {
    it('matches valid UUIDs', async () => {
      const { UUID_REGEX } = await importWithRoot(testRoot);
      expect(UUID_REGEX.test(VALID_UUID)).toBe(true);
      expect(UUID_REGEX.test('aabbccdd-eeff-0011-2233-445566778899')).toBe(true);
      // Case-insensitive: uppercase hex must also match (Postgres can return
      // uppercase UUIDs depending on encoding).
      expect(UUID_REGEX.test('AABBCCDD-EEFF-0011-2233-445566778899')).toBe(true);
    });

    it.each([
      ['not-a-uuid'],
      [''],
      ['../etc/passwd'],
      ['11111111-2222-3333-4444'], // truncated (missing last group)
      ['11111111-2222-3333-4444-5555555555550'], // too long (extra digit)
      ['11111111_2222_3333_4444_555555555555'], // wrong separator
      ['11111111-2222-3333-4444-55555555555g'], // non-hex char
      [' 11111111-2222-3333-4444-555555555555'], // leading space
    ])('rejects non-UUID input %j', async (input) => {
      const { UUID_REGEX } = await importWithRoot(testRoot);
      expect(UUID_REGEX.test(input)).toBe(false);
    });
  });

  describe('campaignDir', () => {
    it('returns absolute path under VAULT_CAMPAIGNS_ROOT', async () => {
      const { campaignDir } = await importWithRoot(testRoot);
      const result = campaignDir(VALID_UUID);
      expect(result.startsWith(testRoot)).toBe(true);
      expect(result.endsWith(VALID_UUID)).toBe(true);
      expect(result).toBe(join(testRoot, VALID_UUID));
    });

    it.each([
      ['not-a-uuid'],
      [''],
      ['../foo'],
      ['a-random-string-that-is-not-a-uuid-shape'],
    ])('throws on non-UUID input %j', async (input) => {
      const { campaignDir } = await importWithRoot(testRoot);
      expect(() => campaignDir(input)).toThrow(/UUID/);
    });

    it('produces deterministic paths for the same UUID', async () => {
      const { campaignDir } = await importWithRoot(testRoot);
      expect(campaignDir(VALID_UUID)).toBe(campaignDir(VALID_UUID));
    });

    it('produces different paths for different UUIDs', async () => {
      const { campaignDir } = await importWithRoot(testRoot);
      expect(campaignDir(VALID_UUID)).not.toBe(campaignDir(OTHER_VALID_UUID));
    });
  });

  describe('eventsPath', () => {
    it('returns campaignDir + /events.md', async () => {
      const { eventsPath, campaignDir } = await importWithRoot(testRoot);
      expect(eventsPath(VALID_UUID)).toBe(join(campaignDir(VALID_UUID), 'events.md'));
    });

    it('throws on non-UUID input via the campaignDir guard', async () => {
      const { eventsPath } = await importWithRoot(testRoot);
      expect(() => eventsPath('not-a-uuid')).toThrow(/UUID/);
    });

    it('returns an absolute path ending in events.md', async () => {
      const { eventsPath } = await importWithRoot(testRoot);
      const result = eventsPath(VALID_UUID);
      expect(result.startsWith('/')).toBe(true);
      expect(result.endsWith('/events.md')).toBe(true);
    });
  });

  describe('slugifyCharacterName', () => {
    it('lowercases ASCII names', async () => {
      const { slugifyCharacterName } = await importWithRoot(testRoot);
      expect(slugifyCharacterName('Aragorn')).toBe('aragorn');
    });

    it('strips diacritics via NFD normalize + combining-mark range', async () => {
      const { slugifyCharacterName } = await importWithRoot(testRoot);
      expect(slugifyCharacterName('Ára')).toBe('ara');
      expect(slugifyCharacterName('Élise')).toBe('elise');
      // Multiple diacritics in a single name (combining tilde + acute).
      expect(slugifyCharacterName('Mañana')).toBe('manana');
    });

    it('replaces non-alphanumeric runs with a single hyphen', async () => {
      const { slugifyCharacterName } = await importWithRoot(testRoot);
      expect(slugifyCharacterName('Sir Galahad the Pure')).toBe('sir-galahad-the-pure');
    });

    it('collapses repeated hyphens', async () => {
      const { slugifyCharacterName } = await importWithRoot(testRoot);
      expect(slugifyCharacterName('a---b')).toBe('a-b');
      expect(slugifyCharacterName('foo   bar')).toBe('foo-bar');
    });

    it('trims leading and trailing hyphens', async () => {
      const { slugifyCharacterName } = await importWithRoot(testRoot);
      expect(slugifyCharacterName('-aragorn-')).toBe('aragorn');
      expect(slugifyCharacterName('   spaces   ')).toBe('spaces');
    });

    it('handles traversal attempts safely (T-02-05 mitigation)', async () => {
      const { slugifyCharacterName } = await importWithRoot(testRoot);
      // The `..` and `/` all collapse to hyphens, then trim+dedup yields a
      // safe slug. The traversal sequence cannot survive slugification.
      expect(slugifyCharacterName('../etc/passwd')).toBe('etc-passwd');
      expect(slugifyCharacterName('../../../etc/passwd')).toBe('etc-passwd');
    });

    it.each([
      ['!!!'],
      [''],
      ['   '],
      ['---'],
      ['***'],
    ])('returns "unnamed" for all-non-alphanumeric input %j', async (input) => {
      const { slugifyCharacterName } = await importWithRoot(testRoot);
      expect(slugifyCharacterName(input)).toBe('unnamed');
    });

    it('preserves digits (numbers are valid filename chars)', async () => {
      const { slugifyCharacterName } = await importWithRoot(testRoot);
      expect(slugifyCharacterName('player1')).toBe('player1');
      expect(slugifyCharacterName('NPC-42')).toBe('npc-42');
    });
  });

  describe('characterViewPath', () => {
    it('builds <campaignDir>/characters/<slug>-<id8>.md', async () => {
      const { characterViewPath, campaignDir } = await importWithRoot(testRoot);
      const result = characterViewPath(VALID_UUID, 'Aragorn', VALID_CHAR_UUID);
      const expected = join(campaignDir(VALID_UUID), 'characters', `aragorn-${VALID_CHAR_UUID.slice(0, 8)}.md`);
      expect(result).toBe(expected);
    });

    it('uses the first 8 chars of the characterId as the suffix (Decision 10)', async () => {
      const { characterViewPath } = await importWithRoot(testRoot);
      const result = characterViewPath(VALID_UUID, 'Aragorn', VALID_CHAR_UUID);
      expect(result).toMatch(/\/characters\/aragorn-aaaaaaaa\.md$/);
    });

    it('throws on non-UUID campaignId', async () => {
      const { characterViewPath } = await importWithRoot(testRoot);
      expect(() => characterViewPath('not-uuid', 'Aragorn', VALID_CHAR_UUID)).toThrow(/UUID/);
    });

    it('throws on non-UUID characterId', async () => {
      const { characterViewPath } = await importWithRoot(testRoot);
      expect(() => characterViewPath(VALID_UUID, 'Aragorn', 'not-uuid')).toThrow(/UUID/);
    });

    it('rejects traversal via character name (T-02-05/T-02-07 path-prefix invariant)', async () => {
      const { characterViewPath, campaignDir } = await importWithRoot(testRoot);
      const result = characterViewPath(VALID_UUID, '../../../etc/passwd', VALID_CHAR_UUID);
      const charactersPrefix = campaignDir(VALID_UUID) + sep + 'characters' + sep;
      // The slug strips to 'etc-passwd', the id8 suffix is appended, and the
      // resulting path lives strictly under campaignDir/characters/.
      expect(result.startsWith(charactersPrefix)).toBe(true);
      expect(result).toMatch(/\/characters\/etc-passwd-aaaaaaaa\.md$/);
    });

    it('handles collision disambiguation via id8 (Decision 10)', async () => {
      const { characterViewPath } = await importWithRoot(testRoot);
      // Two characters whose names slugify identically still get distinct
      // paths because the id8 suffixes differ.
      const ara = characterViewPath(VALID_UUID, 'Ára', VALID_CHAR_UUID);
      const aras = characterViewPath(VALID_UUID, 'Ara', OTHER_CHAR_UUID);
      expect(ara).not.toBe(aras);
      expect(ara).toMatch(/\/characters\/ara-aaaaaaaa\.md$/);
      expect(aras).toMatch(/\/characters\/ara-bbbbbbbb\.md$/);
    });

    it('returns a path strictly under the campaign characters directory', async () => {
      const { characterViewPath, campaignDir } = await importWithRoot(testRoot);
      const result = characterViewPath(VALID_UUID, 'Aragorn', VALID_CHAR_UUID);
      const charactersPrefix = campaignDir(VALID_UUID) + sep + 'characters' + sep;
      expect(result.startsWith(charactersPrefix)).toBe(true);
    });
  });

  describe('assertSameVolumeForTempFiles', () => {
    it('does not throw under any conditions', async () => {
      const { assertSameVolumeForTempFiles } = await importWithRoot(testRoot);
      // testRoot lives under os.tmpdir() so the volume check passes silently
      // on the dev machine; the contract is "never throws".
      expect(() => assertSameVolumeForTempFiles()).not.toThrow();
    });

    it('returns silently when VAULT_CAMPAIGNS_ROOT does not exist', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // Use a path that's guaranteed not to exist on disk.
      const phantom = join(testRoot, 'nonexistent', 'path', 'that', 'should', 'not', 'exist');
      const { assertSameVolumeForTempFiles } = await importWithRoot(phantom);
      assertSameVolumeForTempFiles();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('is exported and callable', async () => {
      const mod = await importWithRoot(testRoot);
      expect(typeof mod.assertSameVolumeForTempFiles).toBe('function');
    });
  });
});
