'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Tile } from '../tile';
import { StepHeader } from '../wizard-shell';

export interface EquipmentStepProps {
  classSlug: string | null;
  choice: 'kit' | 'gold';
  onChoiceChange: (c: 'kit' | 'gold') => void;
}

export function EquipmentStep({ classSlug, choice, onChoiceChange }: EquipmentStepProps) {
  return (
    <div>
      <StepHeader title="Equipment" sub="Pick a starting kit or buy gear with your starting gold." />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
        <Tile
          name="Class kit"
          note={`Standard ${classSlug ?? 'class'} starting kit. Recommended for new characters.`}
          selected={choice === 'kit'}
          onClick={() => onChoiceChange('kit')}
          accent="var(--verdigris)"
        />
        <Tile
          name="Roll for gold"
          note="5d4 × 10 gp. Buy what you like at market price (resolved after creation)."
          selected={choice === 'gold'}
          onClick={() => onChoiceChange('gold')}
          accent="var(--verdigris)"
        />
      </div>
      <Eyebrow style={{ marginBottom: 8 }}>Note</Eyebrow>
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
          color: 'var(--fg-muted)',
        }}
      >
        Equipment items are not persisted to the character sheet at MVP launch — the full inventory will be filled in
        through play. The choice you make here is a hint to the AI Master for the first scene.
      </div>
    </div>
  );
}
