import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildVaultSystemPrompt, hashVaultPrompt } from '@/ai/master/vault/prompt-builder';
import { FORBIDDEN_PATTERNS } from '@/ai/master/vault/__forbidden-patterns';

const BASE_INPUT = { vaultRoot: 'data/vault', campaignId: 'test', toolCount: 3 };

describe('buildVaultSystemPrompt — stability (REQ-022)', () => {
  it('1000 builds with identical input produce ONE unique SHA256', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(hashVaultPrompt(buildVaultSystemPrompt(BASE_INPUT)));
    }
    expect(hashes.size).toBe(1);
  });

  it('1000 builds with language: "it" produce ONE unique SHA256', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, language: 'it' })));
    }
    expect(hashes.size).toBe(1);
  });
});

describe('buildVaultSystemPrompt — sensitivity', () => {
  it('different campaignId → different hash', () => {
    const a = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, campaignId: 'a' }));
    const b = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, campaignId: 'b' }));
    expect(a).not.toBe(b);
  });

  it('different toolCount → different hash', () => {
    const a = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, toolCount: 3 }));
    const b = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, toolCount: 4 }));
    expect(a).not.toBe(b);
  });

  it('different vaultRoot → different hash', () => {
    const a = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, vaultRoot: 'data/vault' }));
    const b = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, vaultRoot: '/abs/vault' }));
    expect(a).not.toBe(b);
  });

  it('language presence changes hash', () => {
    const withLang = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, language: 'it' }));
    const without = hashVaultPrompt(buildVaultSystemPrompt(BASE_INPUT));
    expect(withLang).not.toBe(without);
  });

  it('empty language string is treated as no language (preserves hash)', () => {
    const empty = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, language: '' }));
    const without = hashVaultPrompt(buildVaultSystemPrompt(BASE_INPUT));
    expect(empty).toBe(without);
  });
});

describe('buildVaultSystemPrompt — content sanity', () => {
  it('includes the literal toolCount in the protocol line', () => {
    const prompt = buildVaultSystemPrompt({ ...BASE_INPUT, toolCount: 3 });
    expect(prompt).toContain('3 listed tools');
  });

  it('references /tools/index.md as discovery entry point (REQ-012)', () => {
    const prompt = buildVaultSystemPrompt(BASE_INPUT);
    expect(prompt).toContain('/tools/index.md');
  });

  it('language clause appears only when language is set', () => {
    const without = buildVaultSystemPrompt(BASE_INPUT);
    const withLang = buildVaultSystemPrompt({ ...BASE_INPUT, language: 'it' });
    expect(without).not.toContain('Respond in language');
    expect(withLang).toContain('Respond in language: it.');
  });

  it('matches the locked snapshot for a fixed input', () => {
    const prompt = buildVaultSystemPrompt({ vaultRoot: 'data/vault', campaignId: 'test-camp', toolCount: 3 });
    // Snapshot baseline locked in this PR. Any drift here surfaces in
    // code review as a deliberate change to the prefix-cache identity.
    expect(prompt).toBe([
      'You are an experienced D&D 5e Dungeon Master.',
      '',
      '## Knowledge layout',
      '',
      "Your knowledge lives in a markdown vault at root 'data/vault'.",
      '- Static knowledge: /handbook/<category>/<id>.md',
      '- Active campaign: /campaigns/test-camp/ (reserved — populated in a later release)',
      '',
      '## Tool usage protocol',
      '',
      "If you don't know what tools exist, your FIRST action is to read /tools/index.md.",
      'After that, use any of the 3 listed tools directly.',
      '',
      'Keep responses concise.',
    ].join('\n'));
  });
});

describe('buildVaultSystemPrompt — REQ-022 lint enforcement', () => {
  it('builder source contains no forbidden patterns', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/ai/master/vault/prompt-builder.ts'), 'utf8');
    const violations = FORBIDDEN_PATTERNS.filter(({ re }) => re.test(src)).map(({ name }) => name);
    expect(violations).toEqual([]);
  });
});

describe('hashVaultPrompt', () => {
  it('produces a 64-char hex SHA256', () => {
    const hash = hashVaultPrompt('test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
