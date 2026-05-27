import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  BAKED_PREFIX,
  isBakedModel,
  getBakedBaseModel,
  getBakedModelName,
  computeMasterPromptHash,
  readBakedModelHash,
  warnIfBakedModelStale,
  _clearStaleWarningCache,
  TIER_NAMES,
} from '@/ai/master/baked-models';

describe('isBakedModel', () => {
  it('recognises dnd-master- prefix', () => {
    expect(isBakedModel('dnd-master-qwen3-30b')).toBe(true);
    expect(isBakedModel('dnd-master-gpt-oss-20b')).toBe(true);
  });

  it('rejects raw base models', () => {
    expect(isBakedModel('qwen3:30b')).toBe(false);
    expect(isBakedModel('gpt-oss:20b')).toBe(false);
    expect(isBakedModel('claude-sonnet-4-5')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isBakedModel('')).toBe(false);
  });

  it('rejects accidental prefix subset', () => {
    expect(isBakedModel('dnd-master')).toBe(false); // missing trailing -
    expect(isBakedModel('dnd-mast')).toBe(false);
  });
});

describe('getBakedBaseModel', () => {
  it('strips prefix and turns first dash back into colon', () => {
    expect(getBakedBaseModel('dnd-master-qwen3-30b')).toBe('qwen3:30b');
    expect(getBakedBaseModel('dnd-master-qwen3-14b')).toBe('qwen3:14b');
  });

  it('preserves later dashes in the tag', () => {
    expect(getBakedBaseModel('dnd-master-qwen3-30b-a3b')).toBe('qwen3:30b-a3b');
  });

  it('handles base names that contain a dash', () => {
    // The first dash AFTER the prefix is the separator that was originally `:`.
    expect(getBakedBaseModel('dnd-master-gpt-oss-20b')).toBe('gpt:oss-20b');
  });

  it('returns null for raw base models', () => {
    expect(getBakedBaseModel('qwen3:30b')).toBeNull();
  });

  it('returns null for prefix with nothing after', () => {
    expect(getBakedBaseModel('dnd-master-')).toBeNull();
  });
});

describe('getBakedModelName', () => {
  it('returns dnd-master-plus for the gpt-oss:20b curated tier (Phase 03 baseline)', () => {
    expect(getBakedModelName('gpt-oss:20b')).toBe('dnd-master-plus');
    expect(getBakedModelName('gpt-oss:20b-q4_K_M')).toBe('dnd-master-plus');
    expect(getBakedModelName('gpt-oss:20b-q8_0')).toBe('dnd-master-plus');
  });

  it('falls back to legacy slug-derived naming for Phase 03 retired tier bases', () => {
    // mistral-small3.2:24b (legacy Max) and qwen3:30b-a3b-instruct-2507
    // (legacy Max 2) are NO LONGER in TIER_NAMES — they fall through to the
    // legacy slug-derived format. They remain selectable as raw BASE slugs
    // in Settings via the vault path (REQ-031 / REQ-032).
    expect(getBakedModelName('mistral-small3.2:24b')).toBe('dnd-master-mistral-small3.2-24b');
    expect(getBakedModelName('qwen3:30b-a3b-instruct-2507')).toBe('dnd-master-qwen3-30b-a3b-instruct-2507');
    expect(getBakedModelName('qwen3:30b-a3b')).toBe('dnd-master-qwen3-30b-a3b');
    expect(getBakedModelName('llama3.2:3b')).toBe('dnd-master-llama3.2-3b');
  });

  it('falls back to slug-derived naming for non-tier bases', () => {
    expect(getBakedModelName('qwen3:30b')).toBe('dnd-master-qwen3-30b');
    expect(getBakedModelName('qwen3:14b')).toBe('dnd-master-qwen3-14b');
    expect(getBakedModelName('qwen3:4b')).toBe('dnd-master-qwen3-4b');
    expect(getBakedModelName('gemma2:2b')).toBe('dnd-master-gemma2-2b');
  });

  it('returns null for slugs without a colon and not in tier map', () => {
    expect(getBakedModelName('qwen3-30b')).toBeNull();
  });
});

describe('getBakedBaseModel — tier name reverse map', () => {
  it('recovers the base from the dnd-master-plus tier (the only Phase 03 baseline)', () => {
    expect(getBakedBaseModel('dnd-master-plus:latest')).toBe('gpt-oss:20b');
    expect(getBakedBaseModel('dnd-master-plus')).toBe('gpt-oss:20b');
  });

  it('returns null for Phase 03 retired tier names (no reverse entry, no dash after prefix)', () => {
    // After the Phase 03 strip TIER_NAMES no longer maps dnd-master-{lite,max,
    // max2,max3} to their bases, so the reverse-map lookup misses; the legacy
    // inverse-prefix path also fails because there's no `-` after the prefix
    // in `dnd-master-max` (the prefix consumes the full `dnd-master-` segment).
    // Stale userPrefs values pointing at these tier names degrade gracefully —
    // the plan 03-C-05 migration cleans them up to the production primary slug.
    expect(getBakedBaseModel('dnd-master-max')).toBeNull();
    expect(getBakedBaseModel('dnd-master-max2')).toBeNull();
    expect(getBakedBaseModel('dnd-master-max3')).toBeNull();
    expect(getBakedBaseModel('dnd-master-lite')).toBeNull();
    expect(getBakedBaseModel('dnd-master-max2:latest')).toBeNull();
  });

  it('falls back to legacy parse for non-tier baked variants', () => {
    expect(getBakedBaseModel('dnd-master-qwen3-30b')).toBe('qwen3:30b');
    expect(getBakedBaseModel('dnd-master-gpt-oss-20b')).toBe('gpt:oss-20b'); // legacy quirk
  });
});

describe('BAKED_PREFIX', () => {
  it('is the literal value used throughout', () => {
    expect(BAKED_PREFIX).toBe('dnd-master-');
  });
});

describe('computeMasterPromptHash', () => {
  it('is deterministic for the same inputs', async () => {
    const a = await computeMasterPromptHash('hello world', 1);
    const b = await computeMasterPromptHash('hello world', 1);
    expect(a).toBe(b);
  });

  it('returns 16 hex characters', async () => {
    const h = await computeMasterPromptHash('hello world', 1);
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });

  it('changes when content changes', async () => {
    const a = await computeMasterPromptHash('hello world', 1);
    const b = await computeMasterPromptHash('hello WORLD', 1);
    expect(a).not.toBe(b);
  });

  it('changes when version changes (even with identical content)', async () => {
    const a = await computeMasterPromptHash('hello world', 1);
    const b = await computeMasterPromptHash('hello world', 2);
    expect(a).not.toBe(b);
  });

  it('hash is bound to the v<N> prefix not just concatenation', async () => {
    // computeMasterPromptHash uses sha256("v1\n" + content). Verify that
    // v=1 with content="..." doesn't collide with v=2 with content="v1\n...".
    const a = await computeMasterPromptHash('foo', 1);
    const b = await computeMasterPromptHash('v1\nfoo', 2);
    // Both end up hashing "v1\nfoo" + "v2\n..." → different inputs.
    expect(a).not.toBe(b);
  });
});

describe('readBakedModelHash', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    _clearStaleWarningCache();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('extracts the hash from a Modelfile comment', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        modelfile: `# Generated\n# Source content hash: abc123def456abcd\n# More\nFROM qwen3:30b\n`,
      }),
    }) as never;
    const hash = await readBakedModelHash('dnd-master-qwen3-30b', 'http://localhost:11434');
    expect(hash).toBe('abc123def456abcd');
  });

  it('returns null when /api/show fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as never;
    const hash = await readBakedModelHash('dnd-master-qwen3-30b', 'http://localhost:11434');
    expect(hash).toBeNull();
  });

  it('returns null when modelfile is missing', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
    const hash = await readBakedModelHash('dnd-master-qwen3-30b', 'http://localhost:11434');
    expect(hash).toBeNull();
  });

  it('returns null when hash comment is missing', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ modelfile: 'FROM qwen3:30b\nSYSTEM "..."' }),
    }) as never;
    const hash = await readBakedModelHash('dnd-master-qwen3-30b', 'http://localhost:11434');
    expect(hash).toBeNull();
  });

  it('returns null on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed')) as never;
    const hash = await readBakedModelHash('dnd-master-qwen3-30b', 'http://localhost:11434');
    expect(hash).toBeNull();
  });
});

describe('warnIfBakedModelStale', () => {
  const originalFetch = global.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _clearStaleWarningCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it('does not warn when hashes match', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ modelfile: `# Source content hash: 1234567890abcdef\n` }),
    }) as never;
    const result = await warnIfBakedModelStale({
      modelName: 'dnd-master-qwen3-30b',
      ollamaBase: 'http://localhost:11434',
      runtimeHash: '1234567890abcdef',
    });
    expect(result?.stale).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once when hashes differ', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ modelfile: `# Source content hash: 0123456789abcdef\n` }),
    }) as never;
    const result = await warnIfBakedModelStale({
      modelName: 'dnd-master-qwen3-30b',
      ollamaBase: 'http://localhost:11434',
      runtimeHash: 'fedcba9876543210',
    });
    expect(result?.stale).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/stale/);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/pnpm build-local-models/);
  });

  it('memoises and only warns once per (model, modelHash, runtimeHash) tuple', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ modelfile: `# Source content hash: 0123456789abcdef\n` }),
    }) as never;
    const args = {
      modelName: 'dnd-master-qwen3-30b',
      ollamaBase: 'http://localhost:11434',
      runtimeHash: 'fedcba9876543210',
    };
    await warnIfBakedModelStale(args);
    await warnIfBakedModelStale(args);
    await warnIfBakedModelStale(args);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null-like result and does not warn when modelfile is unreadable', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as never;
    const result = await warnIfBakedModelStale({
      modelName: 'dnd-master-qwen3-30b',
      ollamaBase: 'http://localhost:11434',
      runtimeHash: 'fedcba9876543210',
    });
    expect(result?.stale).toBe(false);
    expect(result?.modelHash).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('baked-models — Phase 03 TIER_NAMES strip (REQ-033 / Decision 8)', () => {
  it('TIER_NAMES contains only dnd-master-plus values', () => {
    const tiers = new Set(Object.values(TIER_NAMES));
    expect(tiers).toEqual(new Set(['dnd-master-plus']));
  });

  it('TIER_NAMES has exactly 3 base slugs (gpt-oss:20b + 2 quantizations)', () => {
    const bases = Object.keys(TIER_NAMES);
    expect(bases).toHaveLength(3);
    expect(bases.every((b) => b.startsWith('gpt-oss:20b'))).toBe(true);
  });

  it('retired tier slugs are NOT in TIER_NAMES.values()', () => {
    const tiers = Object.values(TIER_NAMES);
    expect(tiers).not.toContain('dnd-master-lite');
    expect(tiers).not.toContain('dnd-master-max');
    expect(tiers).not.toContain('dnd-master-max2');
    expect(tiers).not.toContain('dnd-master-max3');
  });

  it('retired base slugs are NOT in TIER_NAMES.keys()', () => {
    const bases = Object.keys(TIER_NAMES);
    expect(bases).not.toContain('mistral-small3.2:24b');
    expect(bases).not.toContain('qwen3:30b-a3b-instruct-2507');
    expect(bases).not.toContain('qwen3:30b-a3b-instruct-2507-q4_K_M');
    expect(bases).not.toContain('qwen3:30b-a3b');
    expect(bases).not.toContain('llama3.2:3b');
  });

  it('isBakedModel still recognises the dnd-master- prefix for graceful degradation', () => {
    // Stale userPrefs.aiMasterModel values that point at retired tiers
    // still match the prefix predicate — the value is treated as a baked
    // variant by the turn route, and the userPrefs migration (plan
    // 03-C-05) is what cleans up the stored string. The prefix check
    // never depends on TIER_NAMES being populated.
    expect(isBakedModel('dnd-master-plus')).toBe(true);
    expect(isBakedModel('dnd-master-max2')).toBe(true); // historically baked
    expect(isBakedModel('dnd-master-lite')).toBe(true); // historically baked
    expect(isBakedModel('qwen3:30b-a3b-instruct-2507-q4_K_M')).toBe(false); // raw base slug
  });

  it('getBakedBaseModel returns the gpt-oss base for dnd-master-plus', () => {
    expect(getBakedBaseModel('dnd-master-plus')).toBe('gpt-oss:20b');
  });
});
