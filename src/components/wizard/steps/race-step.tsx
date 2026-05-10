'use client';
import type { SrdRace } from '@/db/schema';
import { Tile } from '../tile';
import { StepHeader } from '../wizard-shell';

export interface RaceStepProps {
  races: SrdRace[];
  /** Selected base race slug (parent_race_slug = null). */
  selected: string | null;
  /** Selected subrace slug (parent_race_slug = selected base). null if not yet picked. */
  selectedSubrace: string | null;
  onSelect: (slug: string) => void;
  onSelectSubrace: (slug: string | null) => void;
}

export function RaceStep({ races, selected, selectedSubrace, onSelect, onSelectSubrace }: RaceStepProps) {
  const baseRaces = races.filter((r) => !r.parentRaceSlug);
  const subraces = selected ? races.filter((r) => r.parentRaceSlug === selected) : [];

  return (
    <div>
      <StepHeader title="Choose a race" sub="Each race grants ability score increases and innate traits." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))', gap: 12 }}>
        {baseRaces.map((r) => (
          <Tile
            key={r.slug}
            name={r.name}
            note={summarizeRace(r)}
            selected={r.slug === selected}
            onClick={() => onSelect(r.slug)}
          />
        ))}
      </div>

      {subraces.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <StepHeader title="Choose a subrace" sub="Subraces add their own ability bonuses and traits on top of the base race." />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))', gap: 12 }}>
            {subraces.map((s) => (
              <Tile
                key={s.slug}
                name={s.name}
                note={summarizeRace(s)}
                selected={s.slug === selectedSubrace}
                onClick={() => onSelectSubrace(s.slug)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function summarizeRace(r: SrdRace): string {
  const asi = Object.entries(r.abilityScoreIncrease)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `+${v} ${k}`)
    .join(', ');
  return asi || 'See details';
}
