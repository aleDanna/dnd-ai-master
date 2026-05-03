import { describe, it, expect } from 'vitest';
import { TOOL_HANDLERS } from '@/engine/tools/handlers';
import type { EngineState, Character } from '@/engine/types';

const generateSceneImage = TOOL_HANDLERS.generate_scene_image!;

const character: Character = {
  id: 'pc1', name: 'Tharion', level: 3, xp: 900,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 8 },
  proficiencyBonus: 2, hpMax: 28, ac: 16, speed: 30,
  proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
  spellcasting: null, features: [], inventory: [], hitDiceMax: 3, hitDieSize: 10,
};

const baseState: EngineState = {
  characters: [character],
  combatActors: [],
  runtime: { pc1: { actorId: 'pc1', hpCurrent: 28, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [], hitDiceRemaining: 3, spellSlotsUsed: {}, resourcesUsed: {} } },
  combat: null,
  scene: '',
};

describe('generate_scene_image tool', () => {
  it('emits a queue_scene_image mutation carrying the visualPrompt verbatim', () => {
    const result = generateSceneImage(baseState, { visualPrompt: 'A stone lighthouse at twilight' });
    expect(result.ok).toBe(true);
    expect(result.mutations).toEqual([{ op: 'queue_scene_image', visualPrompt: 'A stone lighthouse at twilight' }]);
    expect(result.data).toMatchObject({ status: 'queued' });
  });

  it('trims whitespace around the prompt before queueing', () => {
    const result = generateSceneImage(baseState, { visualPrompt: '   foggy cliffs   ' });
    expect(result.mutations[0]).toMatchObject({ op: 'queue_scene_image', visualPrompt: 'foggy cliffs' });
  });

  it('rejects empty or whitespace-only prompts with invalid_visualPrompt', () => {
    const empty = generateSceneImage(baseState, { visualPrompt: '' });
    expect(empty.ok).toBe(false);
    expect(empty.error).toBe('invalid_visualPrompt');
    expect(empty.mutations).toEqual([]);

    const blank = generateSceneImage(baseState, { visualPrompt: '   ' });
    expect(blank.ok).toBe(false);
    expect(blank.error).toBe('invalid_visualPrompt');
  });

  it('coerces non-string input to invalid_visualPrompt', () => {
    const result = generateSceneImage(baseState, { visualPrompt: 42 as unknown as string });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_visualPrompt');
  });
});
