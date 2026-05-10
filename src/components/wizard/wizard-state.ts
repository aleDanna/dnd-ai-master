'use client';
import * as React from 'react';
import type { Skill } from '@/engine/types';
import { emptyWizardState, type WizardState, type AbilityMethod, type WizardAbilities } from '@/characters/types';

export type WizardAction =
  | { type: 'set-race'; slug: string }
  | { type: 'set-subrace'; slug: string | null }
  | { type: 'set-class'; slug: string }
  | { type: 'set-background'; slug: string }
  | { type: 'set-ability-method'; method: AbilityMethod }
  | { type: 'set-abilities'; abilities: WizardAbilities }
  | { type: 'toggle-skill'; skill: Skill }
  | { type: 'set-equipment-choice'; choice: 'kit' | 'gold' }
  | { type: 'set-kit-choice'; index: number; option: number }
  | { type: 'set-class-choice'; key: string; optionSlug: string }
  | { type: 'toggle-feat'; slug: string }
  | { type: 'set-identity-field'; field: keyof WizardState['identity']; value: string }
  | { type: 'replace'; state: WizardState };

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'set-race':       return { ...state, raceSlug: action.slug, subraceSlug: null };  // changing base race clears subrace
    case 'set-subrace':    return { ...state, subraceSlug: action.slug };
    case 'set-class':      return { ...state, classSlug: action.slug, kitChoices: [], classChoices: {} };  // class change resets kit + class picks
    case 'set-background': return { ...state, backgroundSlug: action.slug };
    case 'set-ability-method': return { ...state, abilityMethod: action.method };
    case 'set-abilities':  return { ...state, abilities: action.abilities };
    case 'toggle-skill': {
      const has = state.skills.includes(action.skill);
      return { ...state, skills: has ? state.skills.filter((s) => s !== action.skill) : [...state.skills, action.skill] };
    }
    case 'set-equipment-choice': return { ...state, equipmentChoice: action.choice };
    case 'set-kit-choice': {
      const next = [...state.kitChoices];
      while (next.length <= action.index) next.push(0);
      next[action.index] = Math.max(0, action.option);
      return { ...state, kitChoices: next };
    }
    case 'set-class-choice':
      return { ...state, classChoices: { ...state.classChoices, [action.key]: action.optionSlug } };
    case 'toggle-feat': {
      const has = state.feats.includes(action.slug);
      return { ...state, feats: has ? state.feats.filter((f) => f !== action.slug) : [...state.feats, action.slug] };
    }
    case 'set-identity-field': return { ...state, identity: { ...state.identity, [action.field]: action.value } };
    case 'replace': return action.state;
  }
}

export function useWizardState() {
  return React.useReducer(wizardReducer, undefined, emptyWizardState);
}
