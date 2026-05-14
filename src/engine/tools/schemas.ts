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
  description:
    'Identifier of the actor the mutation targets. Accepts: "player_character" (solo-mode alias for the only PG); a party member\'s character UUID (multiplayer — see the PARTY MODE block for the roster of valid UUIDs); a combat actor id like "m1" returned by a previous tool result. In multiplayer the "player_character" alias only resolves when the party has one member — for cross-character ops (e.g. add_item on the receiver during an item transfer), always pass the explicit UUID.',
};
