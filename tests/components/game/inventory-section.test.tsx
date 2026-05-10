import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CharacterPane } from '@/components/game/character-pane';
import type { Character } from '@/engine/types';
import type { SessionStateRow } from '@/sessions/client-types';
import type { MasterInventoryView } from '@/srd/enrich-inventory';

const mkChar = (inventory: Character['inventory']): Character => ({
  id: 'pc1', name: 'Tharion', level: 1, xp: 0,
  classSlug: 'fighter', raceSlug: 'human', backgroundSlug: 'soldier',
  abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
  proficiencyBonus: 2, hpMax: 10, ac: 10, speed: 30,
  proficiencies: { saves: [], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
  spellcasting: null, features: [], inventory,
  hitDiceMax: 1, hitDieSize: 10,
});

const mkState = (): SessionStateRow => ({
  hpCurrent: 10,
  tempHp: 0,
  hitDiceRemaining: 1,
  spellSlotsUsed: {},
  conditions: [],
  resourcesUsed: {},
  inCombat: false,
  combat: null,
  scene: '',
} as unknown as SessionStateRow);

describe('CharacterPane → InventorySection', () => {
  it('renders narrative items with the (narrativo) suffix', () => {
    const inventory = [
      { slug: 'strano-amuleto-di-osso', qty: 1, equipped: false },
    ];
    const enriched: MasterInventoryView[] = [
      { slug: 'strano-amuleto-di-osso', qty: 1, equipped: false, kind: 'named_item', name: 'Strano amuleto di osso', magical: false },
    ];
    render(<CharacterPane character={mkChar(inventory)} state={mkState()} enrichedInventory={enriched} />);
    expect(screen.getByText('Strano amuleto di osso (narrativo)')).toBeInTheDocument();
  });

  it('does NOT add the suffix to magical named items', () => {
    const inventory = [{ slug: 'spada-di-aldric', qty: 1, equipped: true }];
    const enriched: MasterInventoryView[] = [
      { slug: 'spada-di-aldric', qty: 1, equipped: true, kind: 'named_item', name: 'Spada di Aldric', magical: true },
    ];
    render(<CharacterPane character={mkChar(inventory)} state={mkState()} enrichedInventory={enriched} />);
    expect(screen.getByText('Spada di Aldric')).toBeInTheDocument();
    expect(screen.queryByText(/narrativo/)).not.toBeInTheDocument();
  });

  it('falls back to slug-derived label when enriched view is absent', () => {
    const inventory = [{ slug: 'rope-hempen-50ft', qty: 1, equipped: false }];
    render(<CharacterPane character={mkChar(inventory)} state={mkState()} />);
    expect(screen.getByText('Rope Hempen 50ft')).toBeInTheDocument();
  });
});
