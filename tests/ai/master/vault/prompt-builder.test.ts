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

  it('different toolCount (with matching vaultMutations) → different hash', () => {
    // Phase 02 — toolCount is now coupled to vaultMutations via the
    // consistency assertion. We sweep the (vaultMutations, toolCount)
    // pair together: read-only (false, 3) vs read-write (true, 4).
    const a = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, toolCount: 3, vaultMutations: false }));
    const b = hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, toolCount: 4, vaultMutations: true }));
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

  it('matches the locked snapshot hash for a fixed input', () => {
    const prompt = buildVaultSystemPrompt({ vaultRoot: 'data/vault', campaignId: 'test-camp', toolCount: 3 });
    // Locked prefix-cache identity. Any drift to the prompt bytes changes this
    // SHA256 → surfaces in code review as a deliberate change. Switched from a
    // hand-maintained array literal to a hash during the Phase 04 anti-railroading
    // reinforcement: the literal repeatedly drifted on em-dash (U+2014) / ellipsis
    // (U+2026) retyping. The hash gives the same drift-detection without the
    // unicode-retype fragility; structural sanity assertions below keep it
    // readable in review.
    expect(hashVaultPrompt(prompt)).toBe(
      '60e56767b9c63ae936741fc6812a3958c6be346662736a455bed75510c54b14e',
    );
    expect(prompt).toContain('## Your role');
    expect(prompt).toContain('## Knowledge layout');
    expect(prompt).toContain('## Tool usage protocol');
    expect(prompt).toContain('CRITICAL — POINT OF VIEW');
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

// Phase 04 — anti-railroading `## Your role` block (REQ-035).
// The block is UNCONDITIONAL (present whether vaultMutations is true or false)
// and STATIC (no per-input variation → preserves REQ-022 byte-stability). The
// content is LOCKED in 04-CONTEXT.md §"Exact block content". These assertions
// pin the load-bearing tokens; the byte-exact reproduction is enforced by the
// regenerated locked-snapshot test in `content sanity`.
describe('buildVaultSystemPrompt — Phase 04 anti-railroading (REQ-035)', () => {
  const READ_WRITE = { vaultRoot: 'data/vault', campaignId: 'test', toolCount: 4, vaultMutations: true };

  it('read-only prompt contains the "## Your role" block', () => {
    const prompt = buildVaultSystemPrompt(BASE_INPUT);
    expect(prompt).toContain('## Your role');
  });

  it('read-write prompt (vaultMutations:true) ALSO contains "## Your role" (unconditional)', () => {
    const prompt = buildVaultSystemPrompt(READ_WRITE);
    expect(prompt).toContain('## Your role');
  });

  it('instructs second-person narration', () => {
    const prompt = buildVaultSystemPrompt(BASE_INPUT);
    // Newline-tolerant: the reinforced block wraps "second\nperson" across lines.
    expect(prompt).toMatch(/second\s+person/);
  });

  it('carries the reinforced CRITICAL point-of-view rule (3rd-person ban)', () => {
    // Reinforced 2026-05-28 after gemma4 + qwen3 kept narrating "Luffy ..." in
    // third person despite the original soft block. The rule now explicitly
    // forbids the PC's name as the subject of an action/thought/speech.
    const prompt = buildVaultSystemPrompt(BASE_INPUT);
    expect(prompt).toContain('CRITICAL — POINT OF VIEW');
    expect(prompt).toContain('forbidden third-person narration');
    expect(prompt).toMatch(/NEVER use a player character's NAME as the\s+subject/);
  });

  it('forbids inventing the PC\'s actions', () => {
    const prompt = buildVaultSystemPrompt(BASE_INPUT);
    expect(prompt).toContain('never invent actions');
  });

  it('includes the GOOD/BAD worked example markers', () => {
    const prompt = buildVaultSystemPrompt(BASE_INPUT);
    expect(prompt).toContain('GOOD:');
    expect(prompt).toContain('BAD:');
  });

  it('tells the master to address the next character BY NAME (multiplayer hand-off)', () => {
    const prompt = buildVaultSystemPrompt(BASE_INPUT);
    expect(prompt).toContain('BY NAME');
  });

  it('vault prompt stays under 2048 bytes for BASE_INPUT', () => {
    const prompt = buildVaultSystemPrompt(BASE_INPUT);
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(2048);
  });
});

describe('buildVaultSystemPrompt — Phase 02 vaultMutations gate', () => {
  // The Phase 02 contract: vaultMutations:true ⇒ toolCount:4 (apply_event
  // advertised); vaultMutations !== true ⇒ toolCount:3 (read-only). Pairs
  // are validated by the consistency assertion at the top of the builder.
  const READ_ONLY = { vaultRoot: 'data/vault', campaignId: 'test', toolCount: 3 };
  const READ_WRITE = { vaultRoot: 'data/vault', campaignId: 'test', toolCount: 4, vaultMutations: true };

  it('vaultMutations:true with toolCount:4 produces a prompt that mentions apply_event', () => {
    const prompt = buildVaultSystemPrompt(READ_WRITE);
    expect(prompt).toContain('apply_event');
  });

  it('vaultMutations:true mentions character UUID (NIT 1 — not character name)', () => {
    const prompt = buildVaultSystemPrompt(READ_WRITE);
    expect(prompt).toContain('character UUID');
  });

  it('vaultMutations:false (omitted) produces a prompt that does NOT mention apply_event', () => {
    const prompt = buildVaultSystemPrompt(READ_ONLY);
    expect(prompt).not.toContain('apply_event');
  });

  it('vaultMutations:false (explicit) produces a prompt that does NOT mention apply_event', () => {
    const prompt = buildVaultSystemPrompt({ ...READ_ONLY, vaultMutations: false });
    expect(prompt).not.toContain('apply_event');
  });

  it('consistency assertion — vaultMutations:true with toolCount:3 throws', () => {
    expect(() =>
      buildVaultSystemPrompt({ ...READ_ONLY, vaultMutations: true }),
    ).toThrow(/vaultMutations:true requires toolCount:4/);
  });

  it('consistency assertion — vaultMutations:false with toolCount:4 throws', () => {
    expect(() =>
      buildVaultSystemPrompt({ vaultRoot: 'data/vault', campaignId: 'test', toolCount: 4, vaultMutations: false }),
    ).toThrow(/requires toolCount:3/);
  });

  it('consistency assertion — toolCount:4 without vaultMutations (undefined) throws', () => {
    expect(() =>
      buildVaultSystemPrompt({ vaultRoot: 'data/vault', campaignId: 'test', toolCount: 4 }),
    ).toThrow(/requires toolCount:3/);
  });

  it('natural hash divergence — read-only prompt vs read-write prompt produce different hashes (Change 4 claim)', () => {
    const promptReadOnly = buildVaultSystemPrompt(READ_ONLY);
    const promptReadWrite = buildVaultSystemPrompt(READ_WRITE);
    expect(hashVaultPrompt(promptReadOnly)).not.toBe(hashVaultPrompt(promptReadWrite));
  });

  it('vaultMutations:true 1000 builds produce ONE unique SHA256 (stability preserved)', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(hashVaultPrompt(buildVaultSystemPrompt(READ_WRITE)));
    }
    expect(hashes.size).toBe(1);
  });
});

// Phase 02.1 — character roster injection (smoke 2026-05-26 follow-up).
// Smoke testing revealed qwen3:30b cannot deduce character UUIDs from the
// dispatcher error marker; it just invents ids. Injecting the roster
// directly into the system prompt closes the gap.
describe('buildVaultSystemPrompt — Phase 02.1 character roster injection', () => {
  const baseRW = {
    vaultRoot: 'data/vault',
    campaignId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    toolCount: 4,
    vaultMutations: true as const,
  };
  const ROSTER = [
    { id: '25158592-15cf-41c8-99b2-44dde5f73702', name: 'Luffy' },
    { id: '84185b08-8032-4cb7-a30c-9212a16dfb05', name: 'Usopp' },
  ];

  it('includes the "Available characters" header when vaultMutations:true and characters[] is non-empty', () => {
    const out = buildVaultSystemPrompt({ ...baseRW, characters: ROSTER });
    expect(out).toContain('## Available characters');
  });

  it('lists every character with its UUID in backticks', () => {
    const out = buildVaultSystemPrompt({ ...baseRW, characters: ROSTER });
    expect(out).toContain('Luffy: `25158592-15cf-41c8-99b2-44dde5f73702`');
    expect(out).toContain('Usopp: `84185b08-8032-4cb7-a30c-9212a16dfb05`');
  });

  it('warns the model NOT to invent identifiers like pc-001', () => {
    const out = buildVaultSystemPrompt({ ...baseRW, characters: ROSTER });
    expect(out).toMatch(/do NOT invent.*pc-001/i);
  });

  it('skips the roster section when characters is undefined', () => {
    const out = buildVaultSystemPrompt({ ...baseRW });
    expect(out).not.toContain('## Available characters');
  });

  it('skips the roster section when characters is empty array', () => {
    const out = buildVaultSystemPrompt({ ...baseRW, characters: [] });
    expect(out).not.toContain('## Available characters');
  });

  it('does NOT inject roster when vaultMutations is false (Phase 01 read-only prompts stay clean)', () => {
    const out = buildVaultSystemPrompt({
      ...baseRW,
      toolCount: 3,
      vaultMutations: false,
      characters: ROSTER,
    });
    expect(out).not.toContain('## Available characters');
  });

  it('roster order is preserved (caller controls order)', () => {
    const out1 = buildVaultSystemPrompt({ ...baseRW, characters: ROSTER });
    const reversed = [ROSTER[1]!, ROSTER[0]!];
    const out2 = buildVaultSystemPrompt({ ...baseRW, characters: reversed });
    // Match the full roster-line form (`Name: \`uuid\``) rather than the bare
    // name: Phase 04's worked example mentions "Luffy" in prose, so a bare
    // indexOf('Luffy') would find the example, not the roster entry. The
    // `Name: \`uuid\`` form is unique to the roster block.
    const luffyLine = (id: string) => 'Luffy: `' + id + '`';
    const usoppLine = (id: string) => 'Usopp: `' + id + '`';
    const idxLuffyOut1 = out1.indexOf(luffyLine(ROSTER[0]!.id));
    const idxUsoppOut1 = out1.indexOf(usoppLine(ROSTER[1]!.id));
    const idxLuffyOut2 = out2.indexOf(luffyLine(ROSTER[0]!.id));
    const idxUsoppOut2 = out2.indexOf(usoppLine(ROSTER[1]!.id));
    expect(idxLuffyOut1).toBeLessThan(idxUsoppOut1);
    expect(idxUsoppOut2).toBeLessThan(idxLuffyOut2);
  });

  it('roster injection produces a different hash than no-roster (deterministic divergence)', () => {
    const noRoster = buildVaultSystemPrompt({ ...baseRW });
    const withRoster = buildVaultSystemPrompt({ ...baseRW, characters: ROSTER });
    expect(hashVaultPrompt(noRoster)).not.toBe(hashVaultPrompt(withRoster));
  });

  it('1000 builds with the same roster produce ONE unique hash (stability preserved)', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(hashVaultPrompt(buildVaultSystemPrompt({ ...baseRW, characters: ROSTER })));
    }
    expect(hashes.size).toBe(1);
  });
});

// Phase 05 — manualRolls-gated `## Rolls` block (REQ-036).
// The block is emitted ONLY when manualRolls === true; absent otherwise.
// REQ-022 byte-stability must be preserved: the read-only default
// (manualRolls undefined) hash MUST remain
// 60e56767b9c63ae936741fc6812a3958c6be346662736a455bed75510c54b14e.
describe('buildVaultSystemPrompt — Phase 05 rolls block (REQ-036)', () => {
  // (a) read-only default — block absent
  it('read-only default (manualRolls undefined) → ## Rolls block ABSENT', () => {
    const prompt = buildVaultSystemPrompt(BASE_INPUT);
    expect(prompt).not.toContain('## Rolls');
  });

  // (b) manualRolls:false — block absent
  it('manualRolls:false → ## Rolls block ABSENT', () => {
    const prompt = buildVaultSystemPrompt({ ...BASE_INPUT, manualRolls: false });
    expect(prompt).not.toContain('## Rolls');
  });

  // (c) manualRolls:true — block present with required tokens (English)
  it('manualRolls:true → ## Rolls block PRESENT with required English tokens', () => {
    const prompt = buildVaultSystemPrompt({ ...BASE_INPUT, manualRolls: true });
    expect(prompt).toContain('## Rolls');
    expect(prompt).toContain('Easy 10, Medium 15, Hard 20');
    expect(prompt).toContain('AUTHORITATIVE');
    expect(prompt).toContain('bare d20');
    // add modifier instruction for ability checks / saves
    expect(prompt).toMatch(/add.*modifier/i);
    // English phrasing examples
    expect(prompt).toContain('Roll a DC 15 Perception check.');
    expect(prompt).toContain('Roll a DC 14 Dexterity save.');
    expect(prompt).toContain('Roll 1d20+');
  });

  // (c) also: block present regardless of vaultMutations value
  it('manualRolls:true block present even when vaultMutations:true (independent gating)', () => {
    const prompt = buildVaultSystemPrompt({
      vaultRoot: 'data/vault',
      campaignId: 'test',
      toolCount: 4,
      vaultMutations: true,
      manualRolls: true,
    });
    expect(prompt).toContain('## Rolls');
    expect(prompt).toContain('Easy 10, Medium 15, Hard 20');
    expect(prompt).toContain('AUTHORITATIVE');
  });

  // (d) language:'it' → Italian phrasings + anti-mixing clause
  it('language:it + manualRolls:true → Italian phrasings and anti-mixing clause', () => {
    const prompt = buildVaultSystemPrompt({ ...BASE_INPUT, manualRolls: true, language: 'it' });
    expect(prompt).toContain('Tira una prova di Percezione (CD 15).');
    expect(prompt).toContain('Tira un TS Destrezza (CD 14).');
    // anti-mixing clause token
    expect(prompt).toContain('never mix languages');
  });

  // (e) showDifficultyNumbers:false → no numeric DC/CD in ANY example, hidden-difficulty line.
  // Regex (not a bare 'DC 15' string) so a leak in any single example — e.g. the
  // Dexterity-save line — is caught regardless of the specific number. The
  // "Difficulty anchors: Easy 10, Medium 15, Hard 20" guidance line has no DC/CD
  // prefix before its numbers, so it does not trip these assertions.
  it('showDifficultyNumbers:false (English) → no DC/CD numbers anywhere, hidden-difficulty line present', () => {
    const prompt = buildVaultSystemPrompt({ ...BASE_INPUT, manualRolls: true, showDifficultyNumbers: false });
    expect(prompt).not.toMatch(/\bDC\s*\d/);
    expect(prompt).not.toMatch(/\bCD\s*\d/);
    expect(prompt).toContain('Hidden difficulty');
  });

  // (e-it) Italian + showDifficultyNumbers:false → no CD/DC numbers in any example either.
  it('showDifficultyNumbers:false (Italian) → no CD/DC numbers anywhere', () => {
    const prompt = buildVaultSystemPrompt({ ...BASE_INPUT, manualRolls: true, language: 'it', showDifficultyNumbers: false });
    expect(prompt).not.toMatch(/\bCD\s*\d/);
    expect(prompt).not.toMatch(/\bDC\s*\d/);
    expect(prompt).toContain('Hidden difficulty');
  });

  // (f) showDifficultyNumbers:true (explicit) → DC numbers present
  it('showDifficultyNumbers:true → DC numbers present', () => {
    const prompt = buildVaultSystemPrompt({ ...BASE_INPUT, manualRolls: true, showDifficultyNumbers: true });
    expect(prompt).toContain('DC 15');
  });

  // (g) REQ-022 byte-stability — 1000 builds of {manualRolls:true, toolCount:3} → 1 hash
  it('1000 builds {manualRolls:true} produce ONE unique SHA256 (REQ-022 stability)', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, manualRolls: true })));
    }
    expect(hashes.size).toBe(1);
  });

  // (h) REQ-022 byte-stability — language:'it' variant
  it('1000 builds {manualRolls:true, language:it} produce ONE unique SHA256 (REQ-022 stability)', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, manualRolls: true, language: 'it' })));
    }
    expect(hashes.size).toBe(1);
  });

  // (i) REQ-022 byte-stability — showDifficultyNumbers:false variant
  it('1000 builds {manualRolls:true, showDifficultyNumbers:false} produce ONE unique SHA256 (REQ-022 stability)', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(hashVaultPrompt(buildVaultSystemPrompt({ ...BASE_INPUT, manualRolls: true, showDifficultyNumbers: false })));
    }
    expect(hashes.size).toBe(1);
  });
});
