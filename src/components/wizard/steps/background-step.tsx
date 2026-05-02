'use client';
import type { SrdBackground } from '@/db/schema';
import { Tile } from '../tile';
import { StepHeader } from '../wizard-shell';

export interface BackgroundStepProps {
  backgrounds: SrdBackground[];
  selected: string | null;
  onSelect: (slug: string) => void;
}

export function BackgroundStep({ backgrounds, selected, onSelect }: BackgroundStepProps) {
  return (
    <div>
      <StepHeader title="Background" sub="A scrap of past — two skill proficiencies, a feature, a starting bond." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: 12 }}>
        {backgrounds.map((b) => (
          <Tile
            key={b.slug}
            name={b.name}
            note={b.skillProficiencies.join(', ') || 'See details'}
            selected={b.slug === selected}
            onClick={() => onSelect(b.slug)}
            accent="var(--gold)"
          />
        ))}
      </div>
    </div>
  );
}
