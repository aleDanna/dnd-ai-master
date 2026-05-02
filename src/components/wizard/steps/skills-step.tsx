'use client';
import type { Skill } from '@/engine/types';
import { StepHeader } from '../wizard-shell';

const ALL_SKILLS: Skill[] = [
  'Acrobatics', 'Animal Handling', 'Arcana', 'Athletics',
  'Deception', 'History', 'Insight', 'Intimidation',
  'Investigation', 'Medicine', 'Nature', 'Perception',
  'Performance', 'Persuasion', 'Religion', 'Sleight of Hand',
  'Stealth', 'Survival',
];

export interface SkillsStepProps {
  classSlug: string | null;
  selected: Skill[];
  onToggle: (s: Skill) => void;
}

export function SkillsStep({ classSlug, selected, onToggle }: SkillsStepProps) {
  return (
    <div>
      <StepHeader
        title="Skills"
        sub={`A ${classSlug ?? 'character'} picks two skills from the class list. Background skills are added automatically.`}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
        {ALL_SKILLS.map((s) => {
          const isSelected = selected.includes(s);
          return (
            <label
              key={s}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: 12,
                background: 'var(--bg-card)',
                border: '1px solid ' + (isSelected ? 'var(--arcane)' : 'var(--border)'),
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggle(s)}
                style={{ accentColor: 'var(--arcane)' }}
              />
              <span style={{ fontSize: 14 }}>{s}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
