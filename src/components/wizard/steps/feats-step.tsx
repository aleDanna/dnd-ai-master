'use client';
import type { SrdFeat } from '@/db/schema';
import { Tile } from '../tile';
import { StepHeader } from '../wizard-shell';
import { Eyebrow } from '@/components/ui/eyebrow';

export interface FeatsStepProps {
  feats: SrdFeat[];
  selected: string[];
  /**
   * Hard cap on number of feats this PC can pick at level 1. Standard PHB:
   * 0. Variant Human and a few class options bump it. The wizard passes the
   * computed cap; the step enforces it visually (extra clicks are no-ops).
   */
  cap: number;
  onToggle: (slug: string) => void;
}

export function FeatsStep({ feats, selected, cap, onToggle }: FeatsStepProps) {
  return (
    <div>
      <StepHeader
        title="Feats"
        sub={
          cap === 0
            ? 'No feats available at level 1 for this character. You can skip this step.'
            : `Pick up to ${cap} feat${cap > 1 ? 's' : ''}. Each feat grants a permanent passive ability.`
        }
      />
      {cap > 0 && (
        <Eyebrow style={{ marginBottom: 8 }}>
          Selected: {selected.length} / {cap}
        </Eyebrow>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px,1fr))', gap: 10 }}>
        {feats.map((f) => {
          const isOn = selected.includes(f.slug);
          const atCap = !isOn && selected.length >= cap;
          return (
            <Tile
              key={f.slug}
              name={f.name}
              note={summarizeFeat(f)}
              selected={isOn}
              onClick={() => {
                if (atCap) return;
                onToggle(f.slug);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function summarizeFeat(f: SrdFeat): string {
  const prereq = f.prerequisites && f.prerequisites !== 'None' ? `Prereq: ${f.prerequisites}. ` : '';
  return `${prereq}${f.benefits}`;
}
