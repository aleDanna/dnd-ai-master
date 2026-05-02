'use client';
import type { SrdClass } from '@/db/schema';
import { Tile } from '../tile';
import { StepHeader } from '../wizard-shell';

export interface ClassStepProps {
  classes: SrdClass[];
  selected: string | null;
  onSelect: (slug: string) => void;
}

export function ClassStep({ classes, selected, onSelect }: ClassStepProps) {
  return (
    <div>
      <StepHeader title="Choose a class" sub="Your class shapes hit points, proficiencies, and the loop of play." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: 12 }}>
        {classes.map((c) => (
          <Tile
            key={c.slug}
            name={c.name}
            note={`${c.hitDie} hit die · ${c.savingThrows.join(', ')}`}
            selected={c.slug === selected}
            onClick={() => onSelect(c.slug)}
            accent="var(--ember)"
          />
        ))}
      </div>
    </div>
  );
}
