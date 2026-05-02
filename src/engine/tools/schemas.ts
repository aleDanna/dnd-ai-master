// JSONSchema fragments shared across tool definitions. Plan D will compose
// the full Anthropic Messages.Tool list from these.

export const ABILITY_ENUM = {
  type: 'string' as const,
  enum: ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'],
};

export const SKILL_ENUM = {
  type: 'string' as const,
  enum: [
    'Acrobatics', 'Animal Handling', 'Arcana', 'Athletics',
    'Deception', 'History', 'Insight', 'Intimidation',
    'Investigation', 'Medicine', 'Nature', 'Perception',
    'Performance', 'Persuasion', 'Religion', 'Sleight of Hand',
    'Stealth', 'Survival',
  ],
};

export const DAMAGE_TYPE_ENUM = {
  type: 'string' as const,
  enum: [
    'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning',
    'necrotic', 'piercing', 'poison', 'psychic', 'radiant',
    'slashing', 'thunder',
  ],
};

export const CONDITION_ENUM = {
  type: 'string' as const,
  enum: [
    'blinded', 'charmed', 'deafened', 'frightened', 'grappled',
    'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
    'prone', 'restrained', 'stunned', 'unconscious', 'exhaustion',
  ],
};

export const ACTOR_ID = {
  type: 'string' as const,
  description: 'Either "player_character" or a combat actor id (e.g. "m1") returned by a previous tool result.',
};
