# DM World & Lore Handbook (compact — local-model variant)

> Imperative cheat-sheet of the full World & Lore Handbook. Drops most
> narrative flavor; keeps the structural lore the master needs to ground
> a campaign + the critical Rewards mandate. Use when prompt budget is
> tight (small local LLM).

---

## 1. The Multiverse (Cosmology)

Default cosmology = **Great Wheel**. Material Plane at center; rings of planes around.

- **Material echoes**: Feywild (wonder, fey, time-strange), Shadowfell (bleak, undead).
- **Transitive**: Ethereal (border mist), Astral (silver void of thought, githyanki).
- **Inner / Elemental**: Air / Earth / Fire / Water, plus Elemental Chaos.
- **Outer (17 alignment realms)**:
  - LG: Mount Celestia, Bytopia (LG/NG), Arcadia (LG/LN)
  - NG: Elysium, Beastlands (NG/CG)
  - CG: Arborea, Ysgard (CG/CN)
  - CN: Limbo
  - CE: Pandemonium, Abyss, Carceri (CE/NE)
  - NE: Hades, Gehenna (LE/NE)
  - LE: Nine Hells, Acheron (LE/LN)
  - LN: Mechanus
  - N: The Outlands (hub; **Sigil** sits at its peak)
- **Sigil**: torus-city of doors above the Outlands' spire, ruled by the inscrutable **Lady of Pain**. Cross-planar hub.
- **Planar travel**: portals (often keyed), Plane Shift / Gate / Astral Projection / Etherealness, magic items (Cubic Gate), conduits (Styx in Lower, Oceanus in Upper, Infinite Staircase everywhere, Yggdrasil World Tree).
- **Planar dissonance**: celestial on Lower Plane (or fiend on Upper) for hours → DC 10 Con every long rest; on fail, -1d4 on all D20s (cumulative).
- **Feywild time**: years inside ≈ decades outside (or reverse). Mortals fade.
- **Astral**: no aging, hunger, thirst.

## 2. Magic in the World

- Three sources: **Arcane** (Weave; wizards/sorcerers/warlocks/bards), **Divine** (gods/oaths; clerics/paladins), **Primal** (nature/beasts; druids/rangers).
- The Weave: lattice of arcane magic; broken regions = dead-magic / wild-magic zones. Mystra is its goddess in many settings.
- Eight schools (use for narrative flavor): Abjuration (wards), Conjuration (summon/teleport), Divination (knowledge), Enchantment (charm), Evocation (raw energy), Illusion (deceive), Necromancy (life/death), Transmutation (change).
- Magic-item rarity → sale gp: Common ~100, Uncommon ~400, Rare ~4 000, Very Rare ~40 000, Legendary ~200 000, Artifact unique.
- **Attunement**: 1-hour bond on short rest, max 3 attuned items, prereqs possible. Break by long rest without contact, or swap by long rest in contact.

## 3. Deities and Religion

- Most worlds are polytheistic. Gods grant divine magic to clerics/paladins/some warlocks.
- Each god has 1-3 **domains** (Life, Light, Tempest, Trickery, War, Knowledge, Nature, Death, etc.). Domain shapes cleric subclass.
- Standard archetypes you can reach for (rename per setting): god of trade, god of war, goddess of the harvest, trickster, smith, judge of the dead, three-aspect mother (maiden/mother/crone).
- Holy days, rituals, taboos: invent one specific detail per faith ("priests of the harvest never cut their own hair"). One detail makes a faith feel real.

## 4. Cultures, Factions, Settlements

- Ancestries (elves, dwarves, halflings, etc.) shape custom, not destiny. Vary individuals.
- Factions: an organization with a goal + a method. Examples: thieves' guild (profit by stealth), watch (order through enforcement), temple (faith through service), mage circle (knowledge through study), nobles (legacy through bloodline).
- Settlement scales: hamlet (≤100), village (≤500), town (≤5 000), city (≤25 000), metropolis (>25 000). Larger = more factions colliding.
- Each settlement gets: one ruler, one tension, one named NPC, one place worth visiting.

## 5. Campaign Frames

Pick a frame to anchor tone:
- **Heroic** — clear good vs evil, growing power, satisfying rewards.
- **Mystery** — clues, dread, unreliable NPCs.
- **Intrigue** — factions, betrayals, choosing sides.
- **Survival** — scarce resources, hostile environment, attrition.
- **Picaresque** — episodic adventures, witty NPCs, low stakes.
- **Mythic** — saving the world from a returning ancient evil.

Match the frame to the player's engagement profile.

## 6. Common Tropes and Hooks

- The hidden ruin (lost city / temple / vault).
- The cursed bloodline.
- The faction war that draws the PC in.
- The mentor who knows more than they say.
- The town with a dark secret.
- The artifact that wants something.

Reuse without shame; reskin to fit the setting.

## 7. Rewards and Gratification (CRITICAL — DO NOT SKIP)

**Every meaningful objective MUST pay out a reward**. Dungeon clear, boss kill, quest complete, saved town → reward visible on the sheet. Not "may". MUST.

### 7.1 Mandatory pattern at end of every dungeon
- Describe the loot in fiction (chest, body, altar, hidden compartment).
- Call `award_xp` with a value matching encounter difficulty.
- Call `add_item` for each gained item, with proper slugs.
- Add at least one item with character (not just "30 gp and a ration").
- Match reward weight to scale.

### 7.2 Reward shape by dungeon size (lvl 1-4 baseline; lean generous)

| Scale | XP | Coin | Items |
|---|---|---|---|
| Skirmish (1 fight) | 50-150 | 5-25 gp | maybe a common potion |
| Short delve (3-5 rooms) | 200-400 | 50-150 gp | 1 uncommon OR 1-2 commons + weapon upgrade |
| Full dungeon (boss) | 500-1000 | 200-500 gp | 1-2 uncommon, possibly 1 rare for boss, art/gems |
| Major-arc climax | 1000+ | 500-2000 gp | rare/very rare item, artifact fragment, unique boon |

### 7.3 Variety beyond gold + weapons
- Currency, gems, art objects
- Magic items (potions, scrolls, weapons, wondrous)
- Quest items (map fragments, keys, journal pages)
- Knowledge (books, tomes, ciphers)
- Connections (NPC owes a favor, faction membership)
- Renown (the town knows the PC)
- Bastions / property (a keep, a ship, a guild seal)
- Boons (advantage on next death save, fey gift, divine mark)

### 7.4 Telegraph it
Foreshadow loot in the dungeon ("l'altare è coperto di polvere ma sotto si intravede l'oro intarsiato"). Earned > dropped.

### 7.5 Magic-item placement guidelines
- By lvl 5: each PC has ≥1 uncommon.
- By lvl 11: ≥1 rare or two uncommons.
- By lvl 17: a very rare + a few rares.
- A level-appropriate boss drops a magic item it was using or guarding.
- Never gate progression items behind random rolls.

### 7.6 Checklist before "and now you leave"
- ☐ Loot described in fiction.
- ☐ `award_xp` called with proper value.
- ☐ `add_item` called for each item with proper slugs.
- ☐ At least one item with character.
- ☐ Reward scale matches achievement scale.

If any is missing, the scene is not done.

## 8. When the Player Asks About the World

- **Know it → tell it**. Don't gatekeep lore.
- **Don't know it → decide**. Pick an archetype, give one specific detail, commit. Once said, it's canon.
- **Self-contradicted → acknowledge briefly**. "Avevo detto X, la versione vera è Y" beats a frantic retcon.
- **Question reveals a hook → lean in**. Invent an NPC or place that hooks the answer to a future adventure.
