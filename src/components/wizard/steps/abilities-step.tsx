'use client';
import { Eyebrow } from '@/components/ui/eyebrow';
import { abilityModifier } from '@/engine/modifiers';
import { ABILITIES, STANDARD_ARRAY, type WizardAbilities, type AbilityMethod } from '@/characters/types';
import { StepHeader } from '../wizard-shell';

export interface AbilitiesStepProps {
  method: AbilityMethod;
  abilities: WizardAbilities;
  onMethodChange: (m: AbilityMethod) => void;
  onAbilitiesChange: (a: WizardAbilities) => void;
}

export function AbilitiesStep({ method, abilities, onMethodChange, onAbilitiesChange }: AbilitiesStepProps) {
  const total = Object.values(abilities).reduce((a, b) => a + b, 0);
  return (
    <div>
      <StepHeader title="Ability scores" sub="Strength carries gold; Dexterity dodges arrows. Pick a method." />
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {(['array', 'pointbuy', 'roll'] as AbilityMethod[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onMethodChange(id)}
            style={{
              padding: '8px 14px',
              borderRadius: 999,
              background: method === id ? 'var(--bone)' : 'var(--bg-card)',
              color: method === id ? 'var(--ink)' : 'var(--fg)',
              border: '1px solid ' + (method === id ? 'var(--bone)' : 'var(--border)'),
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 13,
            }}
          >
            {id === 'array' ? 'Standard array' : id === 'pointbuy' ? 'Point buy' : 'Roll 4d6 drop lowest'}
          </button>
        ))}
      </div>

      {method === 'array' && (
        <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
          Standard array: {STANDARD_ARRAY.join(', ')}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {ABILITIES.map((k) => {
          const v = abilities[k];
          const mod = abilityModifier(v);
          return (
            <div
              key={k}
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 14,
                textAlign: 'center',
              }}
            >
              <Eyebrow>{k}</Eyebrow>
              <input
                type="number"
                min={3}
                max={18}
                value={v}
                onChange={(e) => onAbilitiesChange({ ...abilities, [k]: Math.max(3, Math.min(18, parseInt(e.target.value || '0', 10))) })}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  textAlign: 'center',
                  color: 'var(--fg)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 36,
                  fontWeight: 600,
                  marginTop: 8,
                  outline: 'none',
                }}
              />
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-muted)' }}>
                {mod >= 0 ? '+' : ''}
                {mod}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
        total {total} · racial bonuses applied next
      </div>
    </div>
  );
}
