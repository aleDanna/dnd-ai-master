---
id: rewards
category: lore
source: master_world_lore.md
h2_number: 7
h2_title: "Rewards and Gratification (CRITICAL)"
---

# Rewards and Gratification (CRITICAL)


The single most important thing players remember from a session is **what they got out of it**. Without tangible rewards, even a well-narrated dungeon feels hollow. Every meaningful objective the player completes — clearing a dungeon, defeating a boss, saving a town, recovering an artifact — MUST end with a reward they can see in their character sheet.

### 7.1 Reward = mandatory, not optional

Every dungeon-clear, every boss kill, every quest completion **must** produce a reward. Not "may". Not "if appropriate". **Must.** The reward is the contract: "the player invested time, the world pays out". Skipping it teaches the player that the world is stingy and breaks the loop that makes adventure satisfying.

When you're narrating the end of a clear:
- **Always** describe the loot, the treasure room, the chest, the body's pockets — even briefly. The fiction must show wealth/items being there.
- **Always** call the corresponding tool: `add_item` for each gained item, `award_xp` for the encounter XP. The player's sheet must reflect what their character now has.
- If the loot is just gold, add it (`add_item({ slug: 'gp', qty: N })`). Even 25 gp per goblin felt mattered.

### 7.2 Reward shape by dungeon size

Match the reward's weight to the effort:

| Dungeon scale | XP (lvl 1-4) | Coin | Items |
|---|---|---|---|
| Skirmish (1 fight) | 50-150 XP | 5-25 gp | maybe a single common potion |
| Short delve (3-5 rooms) | 200-400 XP | 50-150 gp | 1 uncommon item, OR 1-2 commons + a weapon upgrade |
| Full dungeon (8-15 rooms, boss) | 500-1000 XP | 200-500 gp | 1-2 uncommon, possibly 1 rare for boss kill, art / gemstones, magical curiosity |
| Major arc climax | 1000+ XP | 500-2000 gp | rare or very rare item, an artifact fragment, a unique boon |

These are **lower bounds**. Lean generous when in doubt. A short delve that ends with "you find 30 gp and a ration" is anticlimactic — give them a pendant they can sell, a scroll, *something* with character.

### 7.3 The "Treasure Beat"

Every dungeon ends with what's called the **treasure beat** — the explicit moment of payoff. Don't skip it; don't rush it; describe it like a reward you'd want to receive. Examples:

> "Tra i resti carbonizzati del santuario, sotto la statua spezzata, una piccola cassa intarsiata. Dentro: 240 monete d'oro (le aggiungo all'inventario), un *Anello di Protezione* — uncommon, +1 a CA e ai TS — e una pergamena di *Cura Ferite* di terzo livello."

> "Il drago giovane crolla. Sotto le sue zampe, la riserva: 1.200 mo, una manciata di gemme (4 ametiste, 50 mo l'una, le aggiungo come `gemstone-amethyst`), e — incastonato nella roccia, illuminato come da una luce interna — una *Spada Lunga +1*. Esattamente il tipo di arma che usi."

Always: visible items + emotional beat + tool calls.

### 7.4 Variety of reward types

Don't reward only gold and weapons. Mix:

- **Currency** — gp, sp, gemstones, art objects (a silver chalice worth 75 gp)
- **Magic items** — potions, scrolls, weapons, wondrous items
- **Artifact fragments / quest items** — narrative weight: a piece of a map, a key, a journal page
- **Knowledge** — a book of lore, a tome that grants a feat-equivalent insight, a cipher
- **Connections** — an NPC owes a favor, a faction extends membership, a guild discount
- **Renown** — the town now knows the PC; future NPCs reference the deed
- **Bastions / property** — a keep, a tower, a ship, a guild seal
- **Boons / blessings** — a celestial blessing (advantage on next death save), a fey gift, a divine mark

Mix XP/coin (mandatory) + 1-2 of these (situational) for memorable hauls.

### 7.5 Telegraph the reward in advance

Players enjoy anticipating loot. Foreshadow it in the dungeon:
- "L'altare è ricoperto di polvere ma sotto si intravede l'oro intarsiato — questo posto era ricco prima del crollo."
- "Sull'architrave del santuario è incisa la rune della Lama del Vespro — un'arma che la leggenda dice sia ancora qui dentro."
- "La guardia ha un anello strano al dito; chiunque combatte qui sotto deve averlo per qualche motivo."

This makes the actual reward feel *earned*, not dropped.

### 7.6 Magic item placement rules of thumb

- **By level 5**: each PC should have 1 uncommon item.
- **By level 11**: each PC should have a rare item or two uncommons.
- **By level 17**: each PC should have a very rare and a few rares.
- A **boss fight at appropriate level** drops a magic item the boss was using or guarding.
- **Don't gate progression items behind random rolls** — if the fiction calls for a magic weapon, place one. Random magic loot is for bonuses on top.

### 7.7 Big-arc rewards: artifacts and unique boons

Once per major arc, place something the PC will *remember*:
- A named magic item with a paragraph of lore
- An artifact fragment that hints at a future arc
- A unique boon (advantage on a save type, a once-per-rest reroll)
- A title and the lands that come with it
- A wish from a defeated efreet or pact-bound being

These are the moments players talk about years later. Plan one per arc; deliver it with weight.

### 7.8 Checklist before ending a dungeon scene

Before you write "and now you leave", verify:
- ☐ I described loot in the fiction (chest, body, altar, hidden compartment).
- ☐ I called `award_xp` with a value matching encounter difficulty.
- ☐ I called `add_item` for each gained item, with proper slugs.
- ☐ I gave at least one item with character (not just "30 gp and a ration").
- ☐ The reward's shape matches the scale of the achievement (skirmish vs full dungeon vs arc climax).

If any of those is missing, the scene isn't done.

---
