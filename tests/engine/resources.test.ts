import { describe, it, expect } from 'vitest';
import { useResource } from '@/engine/resources';
import type { ActorRuntimeState, Character, FeatureInstance } from '@/engine/types';

const rage: FeatureInstance = { slug: 'rage', source: 'class', usesMax: 2, description: 'Barbarian rage' };

const barbarian: Character = {
  id: 'pc1', name: 'Korg', level: 1, xp: 0,
  classSlug: 'barbarian', raceSlug: 'half-orc', backgroundSlug: 'outlander',
  abilities: { STR: 16, DEX: 14, CON: 16, INT: 8, WIS: 12, CHA: 10 },
  proficiencyBonus: 2, hpMax: 14, ac: 14, speed: 30,
  proficiencies: { saves: ['STR', 'CON'], skills: [], expertise: [], weapons: ['Simple', 'Martial'], armor: ['Light', 'Medium', 'Shield'], tools: [], languages: ['Common', 'Orc'] },
  spellcasting: null, features: [rage], inventory: [], hitDiceMax: 1, hitDieSize: 12,
};

const runtime0: ActorRuntimeState = {
  actorId: 'pc1', hpCurrent: 14, tempHp: 0, deathSaves: { successes: 0, failures: 0 }, conditions: [],
  resourcesUsed: {},
};

describe('useResource', () => {
  it('decrements available uses and emits use_resource mutation', () => {
    const r = useResource({ char: barbarian, runtime: runtime0, featureSlug: 'rage', amount: 1 });
    expect(r.ok).toBe(true);
    expect(r.data?.remaining).toBe(1);
    expect(r.mutations[0]).toEqual({ op: 'use_resource', actorId: 'pc1', featureSlug: 'rage', amount: 1 });
  });

  it('refuses if no uses left', () => {
    const exhausted: ActorRuntimeState = { ...runtime0, resourcesUsed: { rage: 2 } };
    const r = useResource({ char: barbarian, runtime: exhausted, featureSlug: 'rage', amount: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_uses');
  });

  it('refuses unknown feature', () => {
    const r = useResource({ char: barbarian, runtime: runtime0, featureSlug: 'no_such_feature', amount: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_feature');
  });

  it('"unlimited" features always allowed', () => {
    const cunningAction: FeatureInstance = { slug: 'cunning_action', source: 'class', usesMax: 'unlimited', description: 'Rogue cunning action' };
    const rogue: Character = { ...barbarian, classSlug: 'rogue', features: [cunningAction] };
    const r = useResource({ char: rogue, runtime: runtime0, featureSlug: 'cunning_action', amount: 1 });
    expect(r.ok).toBe(true);
    expect(r.mutations[0]).toBeDefined();
  });
});
