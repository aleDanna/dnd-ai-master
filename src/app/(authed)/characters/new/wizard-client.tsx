'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { Options } from '@/characters/options';
import { useWizardState } from '@/components/wizard/wizard-state';
import { WizardShell } from '@/components/wizard/wizard-shell';
import { RaceStep } from '@/components/wizard/steps/race-step';
import { ClassStep } from '@/components/wizard/steps/class-step';
import { BackgroundStep } from '@/components/wizard/steps/background-step';
import { AbilitiesStep } from '@/components/wizard/steps/abilities-step';
import { SkillsStep } from '@/components/wizard/steps/skills-step';
import { EquipmentStep } from '@/components/wizard/steps/equipment-step';
import { IdentityStep } from '@/components/wizard/steps/identity-step';
import { validateWizardState } from '@/characters/validate';

export function WizardClient({ options }: { options: Options }) {
  const router = useRouter();
  const [state, dispatch] = useWizardState();
  const [step, setStep] = React.useState(0);
  const [showAi, setShowAi] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const validation = validateWizardState(state, {
    raceSlugs: options.races.map((r) => r.slug),
    classSlugs: options.classes.map((c) => c.slug),
    backgroundSlugs: options.backgrounds.map((b) => b.slug),
  });

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
      const { id } = (await res.json()) as { id: string };
      router.push(`/characters/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
      setBusy(false);
    }
  }

  return (
    <WizardShell
      current={step}
      onPrev={() => setStep((s) => Math.max(0, s - 1))}
      onNext={() => setStep((s) => Math.min(6, s + 1))}
      onSave={handleSave}
      onCancel={() => router.push('/hub')}
      showAi={showAi}
      onToggleAi={() => setShowAi((v) => !v)}
      saveDisabled={busy || !validation.ok}
    >
      {step === 0 && (
        <RaceStep
          races={options.races}
          selected={state.raceSlug}
          onSelect={(slug) => dispatch({ type: 'set-race', slug })}
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
        <BackgroundStep
          backgrounds={options.backgrounds}
          selected={state.backgroundSlug}
          onSelect={(slug) => dispatch({ type: 'set-background', slug })}
        />
      )}
      {step === 3 && (
        <AbilitiesStep
          method={state.abilityMethod}
          abilities={state.abilities}
          onMethodChange={(method) => dispatch({ type: 'set-ability-method', method })}
          onAbilitiesChange={(abilities) => dispatch({ type: 'set-abilities', abilities })}
        />
      )}
      {step === 4 && (
        <SkillsStep
          classSlug={state.classSlug}
          selected={state.skills}
          onToggle={(skill) => dispatch({ type: 'toggle-skill', skill })}
        />
      )}
      {step === 5 && (
        <EquipmentStep
          classSlug={state.classSlug}
          choice={state.equipmentChoice}
          onChoiceChange={(choice) => dispatch({ type: 'set-equipment-choice', choice })}
        />
      )}
      {step === 6 && (
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
