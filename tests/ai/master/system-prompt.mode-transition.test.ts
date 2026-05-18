import { describe, it, expect } from 'vitest';
import { buildMasterSystemPrompt } from '@/ai/master/system-prompt';
import { deriveMode, needsSpellcastingOverlay } from '@/ai/master/mode';
import type { EngineState } from '@/engine/types';
import type { SnapshotForModel } from '@/sessions/types';

function buildPrompt(state: EngineState, snap: Partial<SnapshotForModel> = {}) {
  const fullSnap: SnapshotForModel = {
    state,
    characterMonoSpace: '{}',
    scene: '',
    language: 'en',
    party: [],
    currentPlayerCharacterId: null,
    viewerCharacterId: null,
    ...snap,
  } as SnapshotForModel;
  return buildMasterSystemPrompt({
    handbook: '',
    worldLore: '',
    srdContext: '',
    characterMonoSpace: fullSnap.characterMonoSpace,
    scene: fullSnap.scene,
    language: 'en',
    manualRolls: false,
    masterGuidanceLevel: 'balanced',
    showDifficultyNumbers: true,
    narrationPace: 'detailed',
    chapterDigests: '',
    sceneCard: '',
    codexIndex: '',
    engagementProfile: [],
    party: fullSnap.party,
    currentPlayerCharacterId: fullSnap.currentPlayerCharacterId,
    usesMetaTools: true,
    staticBlocksAlreadyBaked: true,
    mode: deriveMode(state),
    needsSpellcasting: needsSpellcastingOverlay(fullSnap),
  });
}

function asText(prompt: ReturnType<typeof buildPrompt>): string {
  return prompt.system.map((b) => b.text).join('\n\n');
}

describe('mode transitions through a session', () => {
  it('narrative -> combat -> narrative', () => {
    const narrative: EngineState = {
      characters: [], combatActors: [], runtime: {}, combat: null,
      scene: '', travel: undefined, engagementProfile: [],
    } as unknown as EngineState;
    expect(asText(buildPrompt(narrative))).toMatch(/MODE: NARRATIVE/);

    const combat: EngineState = {
      ...narrative,
      combat: { round: 1, turnOrder: [{ actorId: 'pc1', initiative: 15 }], currentIdx: 0 },
    } as EngineState;
    expect(asText(buildPrompt(combat))).toMatch(/MODE: COMBAT/);

    const afterCombat: EngineState = { ...combat, combat: null } as EngineState;
    expect(asText(buildPrompt(afterCombat))).toMatch(/MODE: NARRATIVE/);
  });

  it('exploration en route -> combat (ambush) -> exploration', () => {
    const exploration: EngineState = {
      characters: [], combatActors: [], runtime: {}, combat: null,
      scene: '',
      travel: { pace: 'normal', lightLevel: 'bright', marchingOrder: { front: [], middle: [], back: [] } },
      engagementProfile: [],
    } as unknown as EngineState;
    expect(asText(buildPrompt(exploration))).toMatch(/MODE: EXPLORATION/);

    const ambush: EngineState = {
      ...exploration,
      combat: { round: 1, turnOrder: [], currentIdx: 0 },
    } as EngineState;
    // Combat wins over travel.
    expect(asText(buildPrompt(ambush))).toMatch(/MODE: COMBAT/);

    const resume: EngineState = { ...ambush, combat: null } as EngineState;
    expect(asText(buildPrompt(resume))).toMatch(/MODE: EXPLORATION/);
  });

  it('spellcaster active -> overlay appears; non-caster active -> no overlay', () => {
    const state: EngineState = {
      characters: [], combatActors: [], runtime: {}, combat: null,
      scene: '', travel: undefined, engagementProfile: [],
    } as unknown as EngineState;

    const withCaster = buildPrompt(state, {
      currentPlayerCharacterId: 'pc1',
      party: [{ id: 'pc1', spellcasting: { ability: 'INT' } } as any],
    });
    expect(asText(withCaster)).toMatch(/OVERLAY: SPELLCASTING/);

    const withFighter = buildPrompt(state, {
      currentPlayerCharacterId: 'pc1',
      party: [{ id: 'pc1', spellcasting: null } as any],
    });
    expect(asText(withFighter)).not.toMatch(/OVERLAY: SPELLCASTING/);
  });
});
