export const SPELLCASTING_OVERLAY_BLOCK = `## OVERLAY: SPELLCASTING

The active PC is a spellcaster. The full SRD spell-rules section is in your
baked content — this overlay provides quick reference for in-turn calls.

SLOT MECHANICS:
- spell_action with subaction="cast_spell" consumes a slot of the cast level.
- Cantrips: no slot. Scale by character level (1-4: base, 5-10: x2, 11-16: x3,
  17+: x4 dice).
- Long rest: all slots restored.
- Short rest: only warlock pact slots and explicitly short-rest features regain.

CONCENTRATION:
- Only one concentration spell at a time per caster.
- Taking damage triggers a CON save: DC = max(10, damage/2). Fail = drop.
- Casting a new concentration spell ends any current concentration.

COMPONENTS:
- V/S/M check available. Costed material components are consumed.
- A focus or component pouch satisfies non-costed M.

RESOLUTION:
- Spell attack rolls: d20 + spellcasting mod + proficiency bonus.
- Save spells: target rolls; DC = 8 + spellcasting mod + proficiency bonus.
- Healing: cap at hpMax. Necrotic on undead heals - flag explicitly.

Use lookup_codex for the full text of a specific spell if it's not in your
recent context (e.g. niche cleric domain spells).
`;
