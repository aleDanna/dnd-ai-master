import { describe, it, expect } from 'vitest';
import { deriveMode, needsSpellcastingOverlay, type MasterMode } from '@/ai/master/mode';
import type { EngineState } from '@/engine/types';
import type { SnapshotForModel } from '@/sessions/types';

function makeState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    characters: [],
    combatActors: [],
    runtime: {},
    combat: null,
    scene: '',
    travel: undefined,
    tonalFrame: null,
    engagementProfile: [],
    ...overrides,
  } as EngineState;
}

function makeSnapshot(overrides: Partial<SnapshotForModel> = {}): SnapshotForModel {
  return {
    state: makeState(),
    characterMonoSpace: '{}',
    scene: '',
    language: null,
    party: [],
    currentPlayerCharacterId: null,
    ...overrides,
  } as SnapshotForModel;
}

describe('deriveMode', () => {
  it('returns "combat" when state.combat is non-null', () => {
    const state = makeState({
      combat: { round: 1, turnOrder: [], currentIdx: 0 },
    });
    expect(deriveMode(state)).toBe<MasterMode>('combat');
  });

  it('returns "exploration" when travel.pace is set and not in combat', () => {
    const state = makeState({
      travel: { pace: 'Normal', lightLevel: 'bright', marchingOrder: [] },
    });
    expect(deriveMode(state)).toBe<MasterMode>('exploration');
  });

  it('returns "narrative" when neither combat nor travel is set', () => {
    expect(deriveMode(makeState())).toBe<MasterMode>('narrative');
  });

  it('combat wins over travel when both are set (ambush en route)', () => {
    const state = makeState({
      combat: { round: 1, turnOrder: [], currentIdx: 0 },
      travel: { pace: 'Normal', lightLevel: 'bright', marchingOrder: [] },
    });
    expect(deriveMode(state)).toBe<MasterMode>('combat');
  });
});

describe('needsSpellcastingOverlay', () => {
  it('returns true when active PC has spellcasting', () => {
    const snap = makeSnapshot({
      currentPlayerCharacterId: 'pc1',
      party: [{ id: 'pc1', spellcasting: { ability: 'INT' } } as any],
    });
    expect(needsSpellcastingOverlay(snap)).toBe(true);
  });

  it('returns false when active PC has no spellcasting', () => {
    const snap = makeSnapshot({
      currentPlayerCharacterId: 'pc1',
      party: [{ id: 'pc1', spellcasting: null } as any],
    });
    expect(needsSpellcastingOverlay(snap)).toBe(false);
  });

  it('returns false when no active PC is set', () => {
    const snap = makeSnapshot({
      currentPlayerCharacterId: null,
      party: [{ id: 'pc1', spellcasting: { ability: 'INT' } } as any],
    });
    expect(needsSpellcastingOverlay(snap)).toBe(false);
  });

  it('returns false when active PC not found in party', () => {
    const snap = makeSnapshot({
      currentPlayerCharacterId: 'missing',
      party: [{ id: 'pc1', spellcasting: { ability: 'INT' } } as any],
    });
    expect(needsSpellcastingOverlay(snap)).toBe(false);
  });
});
