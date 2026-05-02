import type { Anthropic } from '@anthropic-ai/sdk';

export const PROPOSE_CHOICE_TOOL: Anthropic.Messages.Tool = {
  name: 'propose_choice',
  description: 'Propose a value for the current wizard step.',
  input_schema: {
    type: 'object',
    required: ['step', 'value', 'reasoning'],
    properties: {
      step: {
        type: 'string',
        enum: ['race', 'class', 'background', 'abilities', 'skills', 'equipment', 'identity'],
      },
      value: {
        description: 'The proposed value. Shape depends on step: a slug string for race/class/background; an object {STR,DEX,CON,INT,WIS,CHA} for abilities; an array of skill strings for skills; "kit" or "gold" for equipment; an object {name,alignment,trait,bond,flaw,backstory,portraitColor} for identity.',
      },
      reasoning: {
        type: 'string',
        description: '1-3 short sentences explaining the choice in the user\'s language.',
      },
    },
  } as never,
};
