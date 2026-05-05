import { describe, it, expect } from 'vitest';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';

describe('buildMasterSystemPrompt with memory', () => {
  const baseInput = {
    srdContext: '## SRD\nfoo',
    characterMonoSpace: '{}',
    scene: 'a hill',
    language: 'en',
    handbook: '## Handbook\n(stub)',
    worldLore: '## World lore\n(stub)',
  };

  it('does NOT add memory blocks when fields are missing', () => {
    const { system } = buildMasterSystemPrompt(baseInput);
    const all = system.map((b) => b.text).join('\n');
    expect(all).not.toContain('## Campaign chapter digests');
    expect(all).not.toContain('## Codex index');
    expect(all).not.toContain('## Scene card');
    expect(all).toContain('Memory tools');
  });

  it('adds chapter digests + scene card + codex index when provided', () => {
    const { system } = buildMasterSystemPrompt({
      ...baseInput,
      chapterDigests: '## Chapter 0\nThe hero began their journey.',
      sceneCard: '- (npc) Aldric [aldric]: ally',
      codexIndex: 'npcs: [Aldric]',
    });
    const all = system.map((b) => b.text).join('\n');
    expect(all).toContain('## Campaign chapter digests');
    expect(all).toContain('## Chapter 0');
    expect(all).toContain('## Codex index');
    expect(all).toContain('npcs: [Aldric]');
    expect(all).toContain('## Scene card');
    expect(all).toContain('Aldric');
  });
});
