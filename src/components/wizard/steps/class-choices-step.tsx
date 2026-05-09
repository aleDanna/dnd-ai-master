'use client';
import { Tile } from '../tile';
import { StepHeader } from '../wizard-shell';
import { Eyebrow } from '@/components/ui/eyebrow';
import { getClassChoices } from '@/srd/class-l1-choices';

export interface ClassChoicesStepProps {
  classSlug: string | null;
  classChoices: Record<string, string>;
  onSelect: (key: string, optionSlug: string) => void;
}

export function ClassChoicesStep({ classSlug, classChoices, onSelect }: ClassChoicesStepProps) {
  const choices = getClassChoices(classSlug);

  if (!classSlug) {
    return (
      <div>
        <StepHeader title="Class choices" sub="Pick a class first." />
      </div>
    );
  }

  if (choices.length === 0) {
    return (
      <div>
        <StepHeader title="Class choices" sub="No level-1 choices for this class." />
        <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          Some classes don&apos;t make explicit picks at level 1 — your features come straight from the class table.
          You can continue.
        </div>
      </div>
    );
  }

  return (
    <div>
      <StepHeader title="Class choices" sub="Set the level-1 features that need a pick." />
      {choices.map((choice) => (
        <div key={choice.key} style={{ marginBottom: 24 }}>
          <Eyebrow style={{ marginBottom: 8 }}>{choice.label}</Eyebrow>
          {choice.helperText && (
            <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 10 }}>{choice.helperText}</p>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px,1fr))', gap: 10 }}>
            {choice.options.map((opt) => (
              <Tile
                key={opt.slug}
                name={opt.name}
                note={opt.description}
                selected={classChoices[choice.key] === opt.slug}
                onClick={() => onSelect(choice.key, opt.slug)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
