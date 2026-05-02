'use client';
import * as React from 'react';
import type { Skill } from '@/engine/types';
import { emptyWizardState, type WizardState, type AbilityMethod, type WizardAbilities } from '@/characters/types';

export type WizardAction =
  | { type: 'set-race'; slug: string }
  | { type: 'set-class'; slug: string }
  | { type: 'set-background'; slug: string }
  | { type: 'set-ability-method'; method: AbilityMethod }
  | { type: 'set-abilities'; abilities: WizardAbilities }
  | { type: 'toggle-skill'; skill: Skill }
  | { type: 'set-equipment-choice'; choice: 'kit' | 'gold' }
  | { type: 'set-identity-field'; field: keyof WizardState['identity']; value: string }
  | { type: 'replace'; state: WizardState };

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'set-race':       return { ...state, raceSlug: action.slug };
    case 'set-class':      return { ...state, classSlug: action.slug };
    case 'set-background': return { ...state, backgroundSlug: action.slug };
    case 'set-ability-method': return { ...state, abilityMethod: action.method };
    case 'set-abilities':  return { ...state, abilities: action.abilities };
    case 'toggle-skill': {
      const has = state.skills.includes(action.skill);
      return { ...state, skills: has ? state.skills.filter((s) => s !== action.skill) : [...state.skills, action.skill] };
    }
    case 'set-equipment-choice': return { ...state, equipmentChoice: action.choice };
    case 'set-identity-field': return { ...state, identity: { ...state.identity, [action.field]: action.value } };
    case 'replace': return action.state;
  }
}

export function useWizardState() {
  return React.useReducer(wizardReducer, undefined, emptyWizardState);
}
