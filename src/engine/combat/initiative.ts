import type { ActionResult, Character, CombatActor, CombatState, Mutation } from '../types';
import { abilityModifier } from '../modifiers';
import { rollD20 } from '../dice';
import { defaultRng, type Rng } from '../rand';

export interface InitiativeInput {
  pcs: Character[];
  monsters: CombatActor[];
}

export function rollInitiative(input: InitiativeInput, rng: Rng = defaultRng): ActionResult<{ turnOrder: CombatState['turnOrder'] }> {
  const entries: { id: string; init: number; dex: number; isPc: boolean; rollIdx: number }[] = [];
  const rolls = [];

  for (const pc of input.pcs) {
    const r = rollD20({ modifier: abilityModifier(pc.abilities.DEX) }, rng);
    rolls.push(r);
    entries.push({ id: pc.id, init: r.total, dex: pc.abilities.DEX, isPc: true, rollIdx: rolls.length - 1 });
  }
  for (const m of input.monsters) {
    const r = rollD20({ modifier: m.initiativeBonus }, rng);
    rolls.push(r);
    entries.push({ id: m.id, init: r.total, dex: m.abilities.DEX, isPc: false, rollIdx: rolls.length - 1 });
  }

  entries.sort((a, b) => {
    if (b.init !== a.init) return b.init - a.init;
    if (b.dex !== a.dex) return b.dex - a.dex;
    if (a.isPc !== b.isPc) return a.isPc ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const turnOrder: CombatState['turnOrder'] = entries.map((e) => ({ actorId: e.id, initiative: e.init }));
  const combat: CombatState = { round: 1, turnOrder, currentIdx: 0 };
  const mutations: Mutation[] = [{ op: 'set_combat', combat }];

  return {
    ok: true,
    data: { turnOrder },
    rolls,
    mutations,
  };
}
