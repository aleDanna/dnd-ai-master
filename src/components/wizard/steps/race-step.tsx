'use client';
import type { SrdRace } from '@/db/schema';
import { Tile } from '../tile';
import { StepHeader } from '../wizard-shell';

export interface RaceStepProps {
  races: SrdRace[];
  selected: string | null;
  onSelect: (slug: string) => void;
}

export function RaceStep({ races, selected, onSelect }: RaceStepProps) {
  const baseRaces = races.filter((r) => !r.parentRaceSlug);
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
