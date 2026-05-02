'use client';
import { Field, Input, TextArea } from '@/components/ui/field';
import { ALIGNMENTS, PORTRAIT_COLORS } from '@/characters/types';
import type { WizardState } from '@/characters/types';
import { StepHeader } from '../wizard-shell';

export interface IdentityStepProps {
  identity: WizardState['identity'];
  onChange: (field: keyof WizardState['identity'], value: string) => void;
}

export function IdentityStep({ identity, onChange }: IdentityStepProps) {
  return (
    <div>
      <StepHeader title="Identity" sub="The last brushstrokes — name, alignment, the shape of a person." />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Name">
          <Input value={identity.name} onChange={(e) => onChange('name', e.target.value)} />
        </Field>
        <Field label="Alignment">
          <select
            value={identity.alignment}
            onChange={(e) => onChange('alignment', e.target.value)}
            style={{
              background: 'var(--bg-card)',
              color: 'var(--fg)',
              border: '1px solid var(--border-strong)',
              borderRadius: 6,
              padding: '9px 12px',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
            }}
          >
            {ALIGNMENTS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </Field>
        <Field label="Portrait color" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {PORTRAIT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onChange('portraitColor', c)}
                aria-label={`portrait color ${c}`}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: c,
                  border: identity.portraitColor === c ? '2px solid var(--fg)' : '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        </Field>
        <Field label="Trait" style={{ gridColumn: '1 / -1' }}>
          <Input value={identity.trait} onChange={(e) => onChange('trait', e.target.value)} />
        </Field>
        <Field label="Bond" style={{ gridColumn: '1 / -1' }}>
          <Input value={identity.bond} onChange={(e) => onChange('bond', e.target.value)} />
        </Field>
        <Field label="Flaw" style={{ gridColumn: '1 / -1' }}>
          <Input value={identity.flaw} onChange={(e) => onChange('flaw', e.target.value)} />
        </Field>
        <Field label="Backstory" style={{ gridColumn: '1 / -1' }}>
          <TextArea rows={4} value={identity.backstory} onChange={(e) => onChange('backstory', e.target.value)} />
        </Field>
      </div>
    </div>
  );
}
