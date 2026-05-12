'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Options } from '@/characters/options';
import type { WizardState } from '@/characters/types';
import type { Skill } from '@/engine/types';
import { useWizardState } from '@/components/wizard/wizard-state';
import { WizardShell, WIZARD_STEPS } from '@/components/wizard/wizard-shell';
import { AiBuilderPane } from '@/components/wizard/ai-builder-pane';
import { RaceStep } from '@/components/wizard/steps/race-step';
import { ClassStep } from '@/components/wizard/steps/class-step';
import { ClassChoicesStep } from '@/components/wizard/steps/class-choices-step';
import { BackgroundStep } from '@/components/wizard/steps/background-step';
import { AbilitiesStep } from '@/components/wizard/steps/abilities-step';
import { SkillsStep } from '@/components/wizard/steps/skills-step';
import { EquipmentStep } from '@/components/wizard/steps/equipment-step';
import { FeatsStep } from '@/components/wizard/steps/feats-step';
import { IdentityStep } from '@/components/wizard/steps/identity-step';
import { validateWizardState } from '@/characters/validate';
import type { SrdRace } from '@/db/schema';

function buildSubracesByBase(races: SrdRace[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of races) {
    if (r.parentRaceSlug) {
      (out[r.parentRaceSlug] ??= []).push(r.slug);
    }
  }
  return out;
}

/**
 * Number of feats this PC may pick at level 1. PHB defaults: 0. Bumped by
 * Variant Human (subrace = 'variant-human') and certain class options
 * (none implemented yet). Mid-game ASI levels (4/8/12/16/19) trade an ASI
 * for a feat — handled separately at level-up time, not here.
 */
function computeFeatCap(state: WizardState): number {
  let cap = 0;
  if (state.subraceSlug === 'variant-human') cap += 1;
  return cap;
}

export function WizardClient({ options }: { options: Options }) {
  const router = useRouter();
  const search = useSearchParams();
  const returnTo = search.get('returnTo');
  const [state, dispatch] = useWizardState();
  const [step, setStep] = React.useState(0);
  const [showAi, setShowAi] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const validation = validateWizardState(state, {
    raceSlugs: options.races.map((r) => r.slug),
    classSlugs: options.classes.map((c) => c.slug),
    backgroundSlugs: options.backgrounds.map((b) => b.slug),
    subracesByBase: buildSubracesByBase(options.races),
    featSlugs: options.feats.map((f) => f.slug),
    classSkillRules: Object.fromEntries(
      options.classes.map((c) => [c.slug, { skillsChoose: c.proficiencies.skillsChoose, skillsFrom: c.proficiencies.skillsFrom }]),
    ),
    backgroundSkills: Object.fromEntries(
      options.backgrounds.map((b) => [b.slug, b.skillProficiencies]),
    ),
  });

  const currentStepName = WIZARD_STEPS[step]!;

  function handleAccept(proposal: { step: string; value: unknown; reasoning: string }) {
    switch (proposal.step) {
      case 'race':
        if (typeof proposal.value === 'string') dispatch({ type: 'set-race', slug: proposal.value });
        break;
      case 'class':
        if (typeof proposal.value === 'string') dispatch({ type: 'set-class', slug: proposal.value });
        break;
      case 'background':
        if (typeof proposal.value === 'string') dispatch({ type: 'set-background', slug: proposal.value });
        break;
      case 'abilities':
        if (proposal.value && typeof proposal.value === 'object') {
          dispatch({ type: 'set-abilities', abilities: proposal.value as WizardState['abilities'] });
        }
        break;
      case 'skills':
        if (Array.isArray(proposal.value)) {
          const newSkills = proposal.value as WizardState['skills'];
          dispatch({ type: 'replace', state: { ...state, skills: newSkills } });
        }
        break;
      case 'equipment':
        if (proposal.value === 'kit' || proposal.value === 'gold') {
          dispatch({ type: 'set-equipment-choice', choice: proposal.value });
        }
        break;
      case 'identity':
        if (proposal.value && typeof proposal.value === 'object') {
          const v = proposal.value as Partial<WizardState['identity']>;
          for (const [k, val] of Object.entries(v)) {
            if (typeof val === 'string') {
              dispatch({ type: 'set-identity-field', field: k as keyof WizardState['identity'], value: val });
            }
          }
        }
        break;
    }
  }

  async function handleSave() {
    if (!validation.ok) {
      setError('Please complete all required fields.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/characters', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wizard: state }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to save');
      }
      const saved = await res.json();
      if (returnTo) {
        router.push(returnTo);
      } else if (saved?.id) {
        router.push(`/characters/${saved.id}`);
      } else {
        router.push('/hub');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
      setBusy(false);
    }
  }

  return (
    <WizardShell
      current={step}
      onPrev={() => setStep((s) => Math.max(0, s - 1))}
      onNext={() => setStep((s) => Math.min(WIZARD_STEPS.length - 1, s + 1))}
      onSave={handleSave}
      onCancel={() => router.push('/hub')}
      showAi={showAi}
      onToggleAi={() => setShowAi((v) => !v)}
      saveDisabled={busy || !validation.ok}
      aiPane={<AiBuilderPane step={currentStepName} wizard={state} onAccept={handleAccept} />}
    >
      {step === 0 && (
        <RaceStep
          races={options.races}
          selected={state.raceSlug}
          selectedSubrace={state.subraceSlug}
          onSelect={(slug) => dispatch({ type: 'set-race', slug })}
          onSelectSubrace={(slug) => dispatch({ type: 'set-subrace', slug })}
        />
      )}
      {step === 1 && (
        <ClassStep
          classes={options.classes}
          selected={state.classSlug}
          onSelect={(slug) => dispatch({ type: 'set-class', slug })}
        />
      )}
      {step === 2 && (
        <ClassChoicesStep
          classSlug={state.classSlug}
          classChoices={state.classChoices}
          onSelect={(key, optionSlug) => dispatch({ type: 'set-class-choice', key, optionSlug })}
        />
      )}
      {step === 3 && (
        <BackgroundStep
          backgrounds={options.backgrounds}
          selected={state.backgroundSlug}
          onSelect={(slug) => dispatch({ type: 'set-background', slug })}
        />
      )}
      {step === 4 && (
        <AbilitiesStep
          method={state.abilityMethod}
          abilities={state.abilities}
          onMethodChange={(method) => dispatch({ type: 'set-ability-method', method })}
          onAbilitiesChange={(abilities) => dispatch({ type: 'set-abilities', abilities })}
        />
      )}
      {step === 5 && (() => {
        const klass = options.classes.find((c) => c.slug === state.classSlug);
        const bg = options.backgrounds.find((b) => b.slug === state.backgroundSlug);
        const classSkillsChoose = klass?.proficiencies.skillsChoose ?? 0;
        const rawClassSkillsFrom = (klass?.proficiencies.skillsFrom ?? []) as string[];
        // SRD sentinel '*' means "any skill" (e.g. Bard, Rogue with 4 from any).
        // Expand to the full 18-skill list so the wizard renders all options.
        const classSkillsFrom: Skill[] = rawClassSkillsFrom.includes('*')
          ? ([
              'Acrobatics', 'Animal Handling', 'Arcana', 'Athletics',
              'Deception', 'History', 'Insight', 'Intimidation',
              'Investigation', 'Medicine', 'Nature', 'Perception',
              'Performance', 'Persuasion', 'Religion', 'Sleight of Hand',
              'Stealth', 'Survival',
            ] as Skill[])
          : (rawClassSkillsFrom as Skill[]);
        const backgroundSkills = (bg?.skillProficiencies ?? []) as Skill[];
        return (
          <SkillsStep
            classSlug={state.classSlug}
            className={klass?.name}
            classSkillsChoose={classSkillsChoose}
            classSkillsFrom={classSkillsFrom}
            backgroundSkills={backgroundSkills}
            selected={state.skills}
            onToggle={(skill) => {
              // Hard cap at limit: ignore toggles that would exceed the class budget.
              const isOn = state.skills.includes(skill);
              const inClassList = classSkillsFrom.includes(skill);
              const fromBg = backgroundSkills.includes(skill);
              if (fromBg) return; // background skills can't be toggled
              if (!isOn && inClassList) {
                const currentClassPicks = state.skills.filter((s) => classSkillsFrom.includes(s) && !backgroundSkills.includes(s)).length;
                if (currentClassPicks >= classSkillsChoose) return;
              }
              dispatch({ type: 'toggle-skill', skill });
            }}
          />
        );
      })()}
      {step === 6 && (
        <FeatsStep
          feats={options.feats}
          selected={state.feats}
          cap={computeFeatCap(state)}
          onToggle={(slug) => dispatch({ type: 'toggle-feat', slug })}
        />
      )}
      {step === 7 && (
        <EquipmentStep
          classSlug={state.classSlug}
          backgroundSlug={state.backgroundSlug}
          choice={state.equipmentChoice}
          kitChoices={state.kitChoices}
          onChoiceChange={(choice) => dispatch({ type: 'set-equipment-choice', choice })}
          onKitChoiceChange={(index, option) => dispatch({ type: 'set-kit-choice', index, option })}
        />
      )}
      {step === 8 && (
        <IdentityStep
          identity={state.identity}
          onChange={(field, value) => dispatch({ type: 'set-identity-field', field, value })}
        />
      )}
      {error && (
        <div style={{ marginTop: 16, color: 'var(--ember)', fontSize: 13 }}>
          {error}
        </div>
      )}
    </WizardShell>
  );
}
