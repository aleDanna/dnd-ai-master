'use client';
import type { Skill } from '@/engine/types';
import { Eyebrow } from '@/components/ui/eyebrow';
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
  className?: string;
  /** How many class skill picks the player gets (e.g. 2 for Fighter, 3 for Bard). */
  classSkillsChoose: number;
  /** The class's allowed skill list. */
  classSkillsFrom: Skill[];
  /** Auto-granted skills from the chosen background. Not togglable. */
  backgroundSkills: Skill[];
  selected: Skill[];
  onToggle: (s: Skill) => void;
}

export function SkillsStep({
  classSlug,
  className,
  classSkillsChoose,
  classSkillsFrom,
  backgroundSkills,
  selected,
  onToggle,
}: SkillsStepProps) {
  // Only count picks that come from the class list (background skills are free + locked).
  const classPickCount = selected.filter((s) => classSkillsFrom.includes(s) && !backgroundSkills.includes(s)).length;
  const limitReached = classPickCount >= classSkillsChoose;

  return (
    <div>
      <StepHeader
        title="Skills"
        sub={
          classSlug
            ? `${className ?? classSlug} picks ${classSkillsChoose} skill${classSkillsChoose === 1 ? '' : 's'} from this list. Background skills are added automatically and locked.`
            : 'Pick a class first to see the available skills.'
        }
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          marginBottom: 16,
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
        }}
      >
        <span style={{ color: 'var(--fg-muted)' }}>Class picks</span>
        <strong style={{ color: limitReached ? 'var(--verdigris)' : 'var(--fg)' }}>{classPickCount}</strong>
        <span style={{ color: 'var(--fg-subtle)' }}>/ {classSkillsChoose}</span>
        <span style={{ flex: 1 }} />
        {backgroundSkills.length > 0 && (
          <>
            <span style={{ color: 'var(--fg-muted)' }}>Background grants</span>
            <strong style={{ color: 'var(--gold)' }}>{backgroundSkills.length}</strong>
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
        {ALL_SKILLS.map((s) => {
          const inClassList = classSkillsFrom.includes(s);
          const fromBackground = backgroundSkills.includes(s);
          // Hide skills that aren't on either list — D&D 5e doesn't let you take random skills.
          if (!inClassList && !fromBackground) return null;

          const isSelected = selected.includes(s) || fromBackground;
          const locked = fromBackground;
          // Disable additional unselected boxes once the limit is reached.
          const disabled = !locked && !isSelected && limitReached;

          return (
            <label
              key={s}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: 12,
                background: locked ? 'rgba(224, 184, 74, 0.10)' : 'var(--bg-card)',
                border: '1px solid ' + (isSelected ? 'var(--arcane)' : 'var(--border)'),
                borderRadius: 8,
                cursor: locked || disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.45 : 1,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={locked || disabled}
                  onChange={() => onToggle(s)}
                  style={{ accentColor: locked ? 'var(--gold)' : 'var(--arcane)' }}
                />
                <span style={{ fontSize: 14 }}>{s}</span>
              </span>
              {locked && (
                <Eyebrow style={{ fontSize: 9, color: 'var(--gold)' }}>background</Eyebrow>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
