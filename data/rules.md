# D&D 5e Rules Reference (for AI Agent)

> Source: D&D Basic Rules (2018, OGL/SRD content) + Player's Handbook (PHB) for additional structural data. This document is structured for AI-agent consumption: factual, decision-oriented, with explicit lookup tables.

---

## 1. Core Mechanics

### 1.1 The d20 Test
Three core resolutions all use a d20 + modifiers vs a target number:
- **Ability Check** — d20 + ability modifier (+ proficiency if proficient in a relevant skill or tool) vs DC.
- **Saving Throw** — d20 + ability modifier (+ proficiency if proficient in that save) vs DC.
- **Attack Roll** — d20 + ability modifier (+ proficiency if proficient with the weapon/spell) vs target's AC.

### 1.2 Difficulty Classes (DC)

| Task Difficulty | DC |
|---|---|
| Very easy | 5 |
| Easy | 10 |
| Medium | 15 |
| Hard | 20 |
| Very hard | 25 |
| Nearly impossible | 30 |

### 1.3 Advantage and Disadvantage
- **Advantage**: roll 2d20, take higher.
- **Disadvantage**: roll 2d20, take lower.
- Multiple sources of advantage or disadvantage do NOT stack — having any advantage and any disadvantage cancels out, regardless of count.
- A roll with advantage or disadvantage is treated as a single d20.

### 1.4 Proficiency Bonus by Character Level

| Level | PB | Level | PB |
|---|---|---|---|
| 1 | +2 | 11 | +4 |
| 2 | +2 | 12 | +4 |
| 3 | +2 | 13 | +5 |
| 4 | +2 | 14 | +5 |
| 5 | +3 | 15 | +5 |
| 6 | +3 | 16 | +5 |
| 7 | +3 | 17 | +6 |
| 8 | +3 | 18 | +6 |
| 9 | +4 | 19 | +6 |
| 10 | +4 | 20 | +6 |

- Proficiency bonus cannot be added to the same roll more than once.
- Halve (round down) when "half proficiency" applies; double for "expertise" (ranger natural explorer, rogue/bard expertise, etc.).

### 1.5 Ability Score Modifiers

| Score | Mod | Score | Mod |
|---|---|---|---|
| 1 | −5 | 16–17 | +3 |
| 2–3 | −4 | 18–19 | +4 |
| 4–5 | −3 | 20–21 | +5 |
| 6–7 | −2 | 22–23 | +6 |
| 8–9 | −1 | 24–25 | +7 |
| 10–11 | 0 | 26–27 | +8 |
| 12–13 | +1 | 28–29 | +9 |
| 14–15 | +2 | 30 | +10 |

Formula: `mod = floor((score − 10) / 2)`.

### 1.6 The Six Abilities

| Ability | Governs |
|---|---|
| Strength (STR) | Athletics; carrying, breaking, melee weapon attacks (default) |
| Dexterity (DEX) | Acrobatics, Sleight of Hand, Stealth; AC, initiative, ranged & finesse attacks |
| Constitution (CON) | HP per level, concentration saves |
| Intelligence (INT) | Arcana, History, Investigation, Nature, Religion; Wizard spellcasting |
| Wisdom (WIS) | Animal Handling, Insight, Medicine, Perception, Survival; Cleric/Druid/Ranger spellcasting |
| Charisma (CHA) | Deception, Intimidation, Performance, Persuasion; Bard/Sorcerer/Warlock spellcasting |

Maximum normal score is 20; some monsters and magic raise the cap.

### 1.7 Skills (with governing ability)
- **STR**: Athletics
- **DEX**: Acrobatics, Sleight of Hand, Stealth
- **INT**: Arcana, History, Investigation, Nature, Religion
- **WIS**: Animal Handling, Insight, Medicine, Perception, Survival
- **CHA**: Deception, Intimidation, Performance, Persuasion

### 1.8 Passive Checks
Passive score = 10 + all modifiers that would normally apply. Used for repeated/background tasks (Passive Perception, Passive Investigation). Advantage gives +5 passive; disadvantage −5.

### 1.9 Working Together
- **Helping**: helper grants advantage on the d20 roll. Helper must be able to perform the task themselves.
- **Group check**: half or more succeed → group succeeds.

---

## 2. Character Creation (Step-by-Step)

1. Choose a **race** (and subrace).
2. Choose a **class**.
3. Determine **ability scores** (see methods below).
4. Describe character (alignment, **background**, name, traits).
5. Choose **equipment** (from class + background, or buy with starting gold).
6. Compute derived stats: AC, HP, initiative, speed, passive Perception, attack bonuses, save DCs, spells (if any).

### 2.1 Ability Score Generation Methods
- **Standard array**: 15, 14, 13, 12, 10, 8 — assign as desired.
- **Point buy**: 27 points, scores between 8 and 15. Cost: 8→0, 9→1, 10→2, 11→3, 12→4, 13→5, 14→7, 15→9.
- **4d6 drop lowest**: roll 4d6, drop lowest, repeat 6 times, assign.

### 2.2 Hit Points (1st Level)
HP at 1st level = max die value of class hit die + Constitution modifier.

### 2.3 Levels Beyond 1st (per class level)
HP gain per level (after 1st): roll class hit die OR take fixed average (= half die +1, rounded up): d6→4, d8→5, d10→6, d12→7. Add CON mod.

### 2.4 Experience to Level
| Level | XP | Level | XP |
|---|---|---|---|
| 1 | 0 | 11 | 85,000 |
| 2 | 300 | 12 | 100,000 |
| 3 | 900 | 13 | 120,000 |
| 4 | 2,700 | 14 | 140,000 |
| 5 | 6,500 | 15 | 165,000 |
| 6 | 14,000 | 16 | 195,000 |
| 7 | 23,000 | 17 | 225,000 |
| 8 | 34,000 | 18 | 265,000 |
| 9 | 48,000 | 19 | 305,000 |
| 10 | 64,000 | 20 | 355,000 |

### 2.5 Multiclassing Prerequisites
To take a level in a class other than your starting class, you must meet ability minimums:
- Barbarian: STR 13
- Bard: CHA 13
- Cleric: WIS 13
- Druid: WIS 13
- Fighter: STR 13 OR DEX 13
- Monk: DEX 13 AND WIS 13
- Paladin: STR 13 AND CHA 13
- Ranger: DEX 13 AND WIS 13
- Rogue: DEX 13
- Sorcerer: CHA 13
- Warlock: CHA 13
- Wizard: INT 13

Multiclass spell slots use a combined caster level table (full casters count full level; half casters half; third casters third). Spells known/prepared count by individual class level.

### 2.6 Alignment
Two-axis system:
- **Lawful / Neutral / Chaotic** × **Good / Neutral / Evil**
- 9 combinations total. Some classes/creatures restrict alignment (e.g., Paladins typically Lawful Good, with subclass exceptions).

---

## 3. Combat

### 3.1 Combat Sequence
1. **Determine surprise** (compare each side's Stealth vs others' Passive Perception).
2. **Establish positions**.
3. **Roll initiative** (d20 + DEX modifier). Sort highest to lowest.
4. **Take turns** in initiative order.
5. **Begin next round**, repeat until combat ends.

### 3.2 Surprise
- A creature that doesn't notice a threat is surprised at the start of combat.
- Surprised creatures cannot move or take any action on their first turn and cannot take a reaction until that turn ends.

### 3.3 Initiative
- Initiative = d20 + DEX modifier (+ any bonuses).
- Ties: DMs may break ties; PCs decide order among themselves on a tie.

### 3.4 Your Turn — What You Can Do
On each turn you can:
- Move up to your **speed** (split however you want before/after actions).
- Take one **action** (Attack, Cast a Spell, Dash, Disengage, Dodge, Help, Hide, Ready, Search, Use an Object, etc.).
- Take one **bonus action** (only if a feature/spell grants one).
- Take any number of **free interactions** with environment (1 typical: draw a weapon, open a door, etc.).
- Communicate with brief words/gestures.
- One **reaction** per round (off-turn, e.g., opportunity attack), refreshing at start of your turn.

### 3.5 Standard Actions

| Action | Effect |
|---|---|
| Attack | Make one melee or ranged attack (more if Extra Attack). |
| Cast a Spell | Cast a spell with casting time of 1 action. |
| Dash | Gain extra movement equal to your speed this turn. |
| Disengage | Movement does not provoke opportunity attacks for the rest of the turn. |
| Dodge | Until your next turn, attacks against you have disadvantage (if you can see attacker), and you have advantage on DEX saves. Lost if incapacitated or speed = 0. |
| Help | Give an ally advantage on next ability check (within next round) OR on the next attack roll vs a target within 5 ft. |
| Hide | Make a Stealth check vs observers' Passive Perception. |
| Ready | Choose a trigger and a prepared action/movement. Reaction when trigger occurs. Spells: cast as action, hold using a spell slot, release as reaction (concentration; lost if concentration broken). |
| Search | Use action to find something. |
| Use an Object | Interact with a second object on your turn (the first is free) or use a magic item that requires an action. |

### 3.6 Bonus Actions
You can only take a bonus action if a class feature, spell, or other source grants one. You cannot subdivide one bonus action into multiple uses.

### 3.7 Reactions
- One per round.
- Common reactions: opportunity attack, *shield* spell, *counterspell*, *feather fall*, readied actions.
- Trigger occurs → reaction resolves → original effect continues unless the reaction prevents it.

### 3.8 Movement
- Your speed (in feet) is the maximum you can move per turn.
- **Difficult terrain**: 1 foot of movement costs 2 feet.
- **Climbing/swimming**: 1 ft costs 2 ft; 1 ft costs 4 ft if both difficult terrain and climbing/swimming.
- **Crawling/standing prone**: standing up costs half your speed.
- **Jumping (long jump)**: distance in feet equal to STR score with a 10-ft running start; halved without.
- **Jumping (high jump)**: 3 + STR mod feet with running start; half without.
- **Forced movement**: pushed/pulled does not provoke opportunity attacks unless you choose to move.

### 3.9 Opportunity Attacks
- You can make an opportunity attack when a hostile creature you can see leaves your reach.
- Use your reaction; one melee attack against the provoking creature.
- The Disengage action prevents opportunity attacks. Teleporting and forced movement do not provoke.

### 3.10 Attack Rolls
- d20 + ability mod + proficiency (if proficient).
- **Natural 20**: automatic hit AND critical (double weapon dice + bonus dice).
- **Natural 1**: automatic miss.
- Attack must beat AC (≥). Equal AC = miss... wait: hit if total ≥ AC.

### 3.11 Critical Hits
- Roll all weapon and bonus damage dice **twice**, then add modifiers once.
- Some abilities expand crit range (e.g., Champion fighter: 19–20).

### 3.12 Cover

| Cover | AC/Save Bonus | Notes |
|---|---|---|
| Half cover | +2 AC, +2 DEX saves | Low wall, large furniture, narrow tree, creature. |
| Three-quarters | +5 AC, +5 DEX saves | Portcullis, arrow slit, thick tree. |
| Total cover | Cannot be targeted | Must be fully concealed. |

### 3.13 Unseen Attackers and Targets
- Attacking a target you cannot see: **disadvantage**.
- Being unseen by a target you attack: **advantage**.

### 3.14 Ranged Attacks
- Made within normal range: no penalty.
- Beyond normal range, up to long range: **disadvantage**.
- Cannot fire beyond long range.
- Ranged attack while an enemy is within 5 ft of you (and not incapacitated): **disadvantage**.

### 3.15 Melee Attacks
- Reach: typically 5 ft; some weapons (reach property) extend to 10 ft.
- Two-weapon fighting (bonus action): wield a light weapon in each hand; bonus action to attack with offhand. Don't add ability mod to offhand damage unless negative or unless feature allows.

### 3.16 Damage
- Roll damage dice + ability mod (STR for melee, DEX for ranged or finesse, spellcasting mod for spell attacks).
- **Damage types**: acid, bludgeoning, cold, fire, force, lightning, necrotic, piercing, poison, psychic, radiant, slashing, thunder.
- **Resistance**: take half damage (round down) of that type.
- **Vulnerability**: take double damage of that type.
- **Immunity**: take no damage of that type.

### 3.17 Hit Points and Damage
- HP reaches 0 → fall unconscious; PCs make death saves.
- Massive damage: damage equal to or exceeding your maximum HP from a single source while at 0 HP → instant death.
- Temporary HP: separate pool, lost first; doesn't stack with other temp HP (take higher).

### 3.18 Death Saving Throws
- At the start of each turn while at 0 HP and unconscious, roll d20:
  - 10+: success.
  - <10: failure.
  - **Natural 20**: regain 1 HP, become conscious.
  - **Natural 1**: counts as 2 failures.
- 3 successes → stable (still unconscious, no longer dying).
- 3 failures → death.
- Damage while at 0 HP = 1 failure (2 if from a critical hit).

### 3.19 Stabilizing
- DC 10 Wisdom (Medicine) check stabilizes a 0-HP creature with no saves consumed.
- Healing kit: stabilize without a roll (consumes one use).
- A stable 0-HP creature regains 1 HP after 1d4 hours.

### 3.20 Knocking Out
When a melee attack would reduce a creature to 0 HP, attacker may choose to knock unconscious instead of killing.

### 3.21 Healing
- Cannot exceed maximum HP.
- Healing a creature at 0 HP makes it conscious and restores HP.
- Spending Hit Dice: during a short rest, expend Hit Die, roll, add CON mod, regain that many HP.

### 3.22 Underwater Combat
- Melee attacks without a freedom of movement-style benefit have **disadvantage** unless using dagger, javelin, shortsword, spear, or trident.
- Ranged weapon attacks automatically miss beyond normal range; within normal range, **disadvantage** unless using crossbow, net, or thrown weapon (javelin, spear, trident, dart). Note: thrown ranged actually misses too — see PHB. (Use crossbow/net/thrown spear-type to attack normally within normal range.)
- Fire damage: **resistance**.

### 3.23 Mounted Combat
- A willing creature at least one size larger may serve as mount.
- Mounting/dismounting costs half your speed.
- Choose **independent** or **controlled** mount each turn.
- Controlled mount acts on your initiative; takes only Dash, Disengage, Dodge actions; mount and rider share movement; reactions remain with rider.
- Effect targeting mount or rider: rider may use reaction to swap target if applicable.

---

## 4. Conditions (full list)

| Condition | Key Effects |
|---|---|
| **Blinded** | Can't see. Auto-fail checks requiring sight. Attacks vs you have advantage; your attacks have disadvantage. |
| **Charmed** | Cannot attack the charmer or target them with harmful abilities/spells. Charmer has advantage on social interactions with you. |
| **Deafened** | Can't hear. Auto-fail checks requiring hearing. |
| **Exhaustion** | 6 levels — see table below. |
| **Frightened** | Disadvantage on checks and attacks while source of fear is in line of sight. Can't willingly move closer to source. |
| **Grappled** | Speed = 0. Ends if grappler is incapacitated or you are moved out of range by an effect. |
| **Incapacitated** | Cannot take actions or reactions. |
| **Invisible** | Heavily obscured to others, but not auto-hidden. Attacks vs you have disadvantage; your attacks have advantage. |
| **Paralyzed** | Incapacitated. Can't move or speak. Auto-fail STR/DEX saves. Attacks vs you have advantage. Hit within 5 ft = critical hit. |
| **Petrified** | Transformed to stone. Incapacitated, weight ×10, ages stop. Auto-fail STR/DEX saves. Resistance to all damage. Immune to poison and disease (current poison/disease suspended). |
| **Poisoned** | Disadvantage on attack rolls and ability checks. |
| **Prone** | Movement options limited to crawling unless you stand up. Disadvantage on attack rolls. Attacks vs you within 5 ft have advantage; ranged attacks vs you have disadvantage. |
| **Restrained** | Speed = 0. Disadvantage on attacks and DEX saves. Attacks vs you have advantage. |
| **Stunned** | Incapacitated. Can't move; speak only falteringly. Auto-fail STR/DEX saves. Attacks vs you have advantage. |
| **Unconscious** | Incapacitated, can't move/speak, unaware. Drops what it holds; falls prone. Auto-fail STR/DEX saves. Attacks vs you have advantage. Hit within 5 ft = critical hit. |

### 4.1 Exhaustion Levels

| Level | Effect |
|---|---|
| 1 | Disadvantage on ability checks |
| 2 | Speed halved |
| 3 | Disadvantage on attack rolls and saving throws |
| 4 | HP maximum halved |
| 5 | Speed = 0 |
| 6 | Death |

A long rest reduces exhaustion by 1 (food + water consumed).

---

## 5. Resting

### 5.1 Short Rest
- Duration: at least **1 hour**.
- Spend any number of **Hit Dice** to heal: 1d(class HD) + CON mod each, minimum 1.
- Some abilities recharge on a short rest (Warlock spell slots, monk Ki at higher levels — no, monk Ki returns on short rest; etc.).

### 5.2 Long Rest
- Duration: at least **8 hours** (max 2 hours light activity, ≥6 hours sleep).
- Restores all HP.
- Recover spent Hit Dice up to half maximum (minimum 1).
- Restores most class features and all spell slots.
- Cannot benefit from more than one long rest per 24 hours.
- Long rest interrupted by ≥1 hour of strenuous activity (combat, casting spells other than minor, walking long distance) loses its benefit.
- Must have at least 1 HP at the start of a long rest to gain benefits.

---

## 6. Adventuring & Exploration

### 6.1 Travel Pace

| Pace | Per Minute | Per Hour | Per Day | Effect |
|---|---|---|---|---|
| Fast | 400 ft | 4 mi | 30 mi | −5 to passive Perception |
| Normal | 300 ft | 3 mi | 24 mi | — |
| Slow | 200 ft | 2 mi | 18 mi | Can use stealth |

### 6.2 Marching Order
Front, middle, back ranks — affects who's caught in surprise zones, ambushes, traps.

### 6.3 Forced March
Beyond 8 hours of travel: each additional hour = CON save (DC 10 + 1 per extra hour) or 1 level of exhaustion.

### 6.4 Vision and Light
- **Bright light**: normal vision.
- **Dim light** (lightly obscured): disadvantage on Perception checks relying on sight.
- **Darkness** (heavily obscured): effectively blinded for sight-based perception/attacks.
- **Darkvision**: see in dim light as if bright (within range, typically 60 ft); see in darkness as dim. Can't discern color in darkness.
- **Blindsight**: perceive without sight within range.
- **Tremorsense**: detect creatures in contact with the ground.
- **Truesight**: see in darkness, see invisible, see through illusions, see into Ethereal plane.

### 6.5 Suffocating
- Hold breath: 1 + CON mod minutes (min 30 sec).
- After: survive for CON mod rounds (min 1) at 0 HP, then drop to 0 HP and start dying.

### 6.6 Falling
- 1d6 bludgeoning damage per 10 ft fallen, max 20d6.
- Lands prone unless avoiding damage.

### 6.7 Food and Water
- Food: 1 lb/day. Half ration counts as half day toward exhaustion. Days without food = exhaustion if exceeded survival days (CON mod days, minimum 1).
- Water: 1 gallon/day (2 in hot climate). Less than half = CON save DC 15 or 1 level of exhaustion (DC increases per consecutive day without enough).

---

## 7. Social Interaction

### 7.1 Attitudes
Friendly / Indifferent / Hostile.

### 7.2 Influencing
- **Persuasion (CHA)**: appeal to good faith.
- **Deception (CHA)**: lie convincingly.
- **Intimidation (CHA)**: threaten.
- DC depends on attitude and request reasonableness.

---

## 8. Spellcasting

### 8.1 Levels
- Cantrips (level 0): no spell slot, can be cast at will.
- Levels 1–9: require a spell slot of equal or higher level.

### 8.2 Spell Slots
Casting consumes one slot of the spell's level (or higher → upcast, often increasing effect).

### 8.3 Casting a Spell — Required Components

| Component | Description |
|---|---|
| **V (Verbal)** | Spoken incantation. Need to speak; can't be silenced/gagged. |
| **S (Somatic)** | Hand gesture. Need at least one free hand. (A holy symbol or focus in hand can satisfy this if also the focus is being used.) |
| **M (Material)** | Specified item; consumed if marked "consumed". A spellcasting focus can replace non-cost-specified materials. |

### 8.4 Spellcasting Focus
- Arcane focus (orb, rod, staff, wand) — sorcerer, warlock, wizard.
- Druidic focus (sprig of mistletoe, totem, wooden staff, yew wand) — druid, ranger.
- Holy symbol — cleric, paladin (must be worn or held visible).
- Bards: musical instrument as focus.

### 8.5 Casting Time
- Action / Bonus Action / Reaction (with specified trigger) / longer (1 minute, 10 min, 1 hour, ritual).
- **Bonus action spell rule**: if you cast a spell as a bonus action, the only other spell you can cast on the same turn is a cantrip with casting time of 1 action.

### 8.6 Range
- Self / Touch / Specified distance / Sight.

### 8.7 Duration
- Instantaneous / specified time / Until dispelled / Concentration.

### 8.8 Concentration
- Only one concentration spell at a time.
- Lost if: cast another concentration spell; incapacitated or killed; take damage and fail CON save (DC = 10 or half damage taken, whichever higher).
- Environment may force CON save (DM's discretion).

### 8.9 Targeting
- Need a clear path to the target (no total cover) unless spell allows otherwise.
- AoE: typically center on a point.

### 8.10 Spell Attack Rolls
- d20 + spellcasting modifier + proficiency bonus vs target's AC.

### 8.11 Saving Throws Against Spells
- DC = 8 + spellcasting modifier + proficiency bonus.

### 8.12 Combining Magical Effects
Different spells' effects of the same spell don't stack. The most potent (or most recent if equivalent) applies.

### 8.13 Rituals
Spells with the **ritual** tag, cast at +10 minutes casting time, do NOT consume a spell slot. Class feature usually required (Wizard, Cleric, Druid, Bard ritual rules differ — Wizard can ritual any prepared OR in spellbook depending on subclass; Cleric/Druid/Bard must have prepared/known).

### 8.14 Areas of Effect
- **Cone**: starts at a point, length × length wide at far end.
- **Cube**: each side equal to spell's specified size.
- **Cylinder**: radius and height.
- **Line**: long, narrow.
- **Sphere**: all in radius from center point.

---

## 9. Equipment Mechanics

### 9.1 Carrying Capacity
- Carry capacity = STR × 15 lb.
- **Push, drag, lift**: STR × 30 lb (Speed halved if over carrying capacity).
- **Encumbrance** (variant): >5×STR = encumbered (speed −10 ft); >10×STR = heavily encumbered (speed −20 ft, disadvantage on STR/DEX/CON checks, attacks, saves involving these).

### 9.2 Currency

| Coin | Value |
|---|---|
| 1 cp | 1 cp |
| 1 sp | 10 cp |
| 1 ep | 50 cp / 5 sp |
| 1 gp | 100 cp / 10 sp / 2 ep |
| 1 pp | 1,000 cp / 100 sp / 10 gp |

### 9.3 Armor

| Armor Type | AC Formula | Stealth | STR Req |
|---|---|---|---|
| Light | AC + DEX mod | — | — |
| Medium | AC + DEX mod (max +2) | varies | — |
| Heavy | AC (no DEX) | varies | varies |
| Shield | +2 AC | — | — |

You can use only one shield. Wearing armor without proficiency: disadvantage on STR/DEX checks, saves, and attacks; cannot cast spells.

### 9.4 Weapon Properties (key terms)
- **Ammunition**: requires ammo (1 piece per attack). Recover half of expended ammo on a 1-minute search.
- **Finesse**: can use STR or DEX for attack and damage (your choice).
- **Heavy**: small creatures have disadvantage attacking with this weapon.
- **Light**: suitable for two-weapon fighting.
- **Loading**: only one shot per action, bonus action, or reaction (regardless of attacks per action).
- **Range (X/Y)**: normal/long range in feet.
- **Reach**: +5 ft reach.
- **Special**: see weapon-specific rules.
- **Thrown**: can be thrown using listed range. Use STR for melee weapons, DEX for finesse/ranged.
- **Two-Handed**: requires 2 hands.
- **Versatile (X)**: 1H damage normally; X damage if used 2H.
- **Silvered**: bypasses some resistances (e.g., werewolves).

### 9.5 Improvised Weapons
1d4 damage (similar to a real weapon if the DM finds analogue). Proficiency only if very similar to a known weapon.

### 9.6 Mounts and Vehicles
Walking pace × 2 for a mount on a single trip. Can't travel at gallop indefinitely. See PHB for individual stats.

### 9.7 Spellcasting Services (purchase)
- Cure wounds (1st level): 10 gp typical.
- Identify: 20 gp typical.
- Higher-level services priced per spell level + scarcity.

---

## 10. Magic Items (overview)

### 10.1 Rarity and Attunement
- Rarity tiers: common, uncommon, rare, very rare, legendary, artifact.
- Some items require **attunement** — short rest of focus; max 3 attuned items per character.

### 10.2 Wearing/Wielding Items
- One item per body slot.
- Cursed items: detected only on use; harder to remove.

---

## 11. Combat Quick Reference

### 11.1 Action Economy Summary (per turn)
- 1 Action
- 1 Bonus Action (if available)
- Movement up to your speed
- Free interactions (1 typical)
- 1 Reaction per round (off-turn capable)

### 11.2 Common Conditions Auto-fail Rules
- Auto-fail STR/DEX saves: paralyzed, petrified, stunned, unconscious.
- Auto-crit melee within 5 ft: paralyzed, unconscious.

### 11.3 Determining Cover Stack
Cover does not stack; use the highest applicable cover level.

### 11.4 Reach and Engagement
A melee attacker is "engaged" when a hostile creature is within reach. Moving out without Disengaging provokes opportunity attacks.

---

## 12. Character Class Summary (mechanical at-a-glance)

| Class | HD | Primary Ability | Saves | Spellcasting |
|---|---|---|---|---|
| Barbarian | d12 | STR | STR, CON | None |
| Bard | d8 | CHA | DEX, CHA | Full (CHA) |
| Cleric | d8 | WIS | WIS, CHA | Full (WIS) |
| Druid | d8 | WIS | INT, WIS | Full (WIS) |
| Fighter | d10 | STR or DEX | STR, CON | None (Eldritch Knight: 1/3 INT) |
| Monk | d8 | DEX & WIS | STR, DEX | None (Way of Four Elements: limited) |
| Paladin | d10 | STR & CHA | WIS, CHA | Half (CHA) |
| Ranger | d10 | DEX & WIS | STR, DEX | Half (WIS) |
| Rogue | d8 | DEX | DEX, INT | None (Arcane Trickster: 1/3 INT) |
| Sorcerer | d6 | CHA | CON, CHA | Full (CHA) |
| Warlock | d8 | CHA | WIS, CHA | Pact Magic (CHA) |
| Wizard | d6 | INT | INT, WIS | Full (INT) |

---

## 13. Spell Slot Tables

### 13.1 Full Caster Spell Slots (Bard, Cleric, Druid, Sorcerer, Wizard)

| Lvl | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | — | — | — | — | — | — | — | — |
| 2 | 3 | — | — | — | — | — | — | — | — |
| 3 | 4 | 2 | — | — | — | — | — | — | — |
| 4 | 4 | 3 | — | — | — | — | — | — | — |
| 5 | 4 | 3 | 2 | — | — | — | — | — | — |
| 6 | 4 | 3 | 3 | — | — | — | — | — | — |
| 7 | 4 | 3 | 3 | 1 | — | — | — | — | — |
| 8 | 4 | 3 | 3 | 2 | — | — | — | — | — |
| 9 | 4 | 3 | 3 | 3 | 1 | — | — | — | — |
| 10 | 4 | 3 | 3 | 3 | 2 | — | — | — | — |
| 11 | 4 | 3 | 3 | 3 | 2 | 1 | — | — | — |
| 12 | 4 | 3 | 3 | 3 | 2 | 1 | — | — | — |
| 13 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | — | — |
| 14 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | — | — |
| 15 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | 1 | — |
| 16 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | 1 | — |
| 17 | 4 | 3 | 3 | 3 | 2 | 1 | 1 | 1 | 1 |
| 18 | 4 | 3 | 3 | 3 | 3 | 1 | 1 | 1 | 1 |
| 19 | 4 | 3 | 3 | 3 | 3 | 2 | 1 | 1 | 1 |
| 20 | 4 | 3 | 3 | 3 | 3 | 2 | 2 | 1 | 1 |

### 13.2 Half Caster Spell Slots (Paladin, Ranger)
Spell slots start at level 2. Use full caster table at half level (round down). Max 5th-level slots at level 17+.

### 13.3 Warlock Pact Magic
- All slots are the same (highest available) level.
- Slots recover on **short** rest.

| Lvl | Slots | Slot Lvl | Cantrips | Spells Known |
|---|---|---|---|---|
| 1 | 1 | 1 | 2 | 2 |
| 2 | 2 | 1 | 2 | 3 |
| 3 | 2 | 2 | 2 | 4 |
| 5 | 2 | 3 | 3 | 6 |
| 7 | 2 | 4 | 3 | 8 |
| 9 | 2 | 5 | 3 | 10 |
| 11 | 3 | 5 | 4 | 11 |
| 17 | 4 | 5 | 4 | 15 |
| 20 | 4 | 5 | 4 | 15 |

(Ability slots and spells known scale; see warlock_progression in classes.csv.)

---

## 14. Resting/Recharge Triggers

Common features and their refresh:
- **Per Short or Long Rest**: Action Surge (Fighter), Channel Divinity (Cleric), Ki (Monk), Bardic Inspiration (level 5+ Bard), Warlock spell slots, Second Wind (Fighter).
- **Per Long Rest only**: Spell slots (non-warlock), Wild Shape (some uses), Rage uses, Sorcery Points, Lay on Hands pool, etc.

---

## 15. Saving Throw Proficiencies by Class

| Class | Saves |
|---|---|
| Barbarian | STR, CON |
| Bard | DEX, CHA |
| Cleric | WIS, CHA |
| Druid | INT, WIS |
| Fighter | STR, CON |
| Monk | STR, DEX |
| Paladin | WIS, CHA |
| Ranger | STR, DEX |
| Rogue | DEX, INT |
| Sorcerer | CON, CHA |
| Warlock | WIS, CHA |
| Wizard | INT, WIS |

---

## 16. Damage Type Quick-Reference for Resistances

Common type groupings:
- **Physical**: bludgeoning, piercing, slashing.
- **Elemental**: acid, cold, fire, lightning, thunder.
- **Energy**: force, necrotic, psychic, radiant.
- **Poison** (often resisted/immune by undead, constructs).

---

## 17. Backgrounds Mechanical Effects

A background grants:
- 2 skill proficiencies.
- (Sometimes) 1–2 tool proficiencies.
- (Sometimes) 1–2 languages.
- Starting equipment.
- A unique **Feature** (non-mechanical / role-play utility).
- Suggested traits, ideals, bonds, flaws.

---

## 18. Important DM-Facing Rules

### 18.1 Inspiration
DMs award Inspiration for great roleplaying or other criteria. Spend Inspiration to gain advantage on a single d20 test. You either have Inspiration or you don't (no stacking).

### 18.2 XP Awards
- Encounters by CR: see DMG. For Basic Rules, milestone leveling is acceptable.
- Combat XP awarded for defeating monsters, divided among all PCs (sometimes by level).

### 18.3 Common DCs (sample)

| Action | Suggested DC |
|---|---|
| Climb a knotted rope | 5 |
| Pick a simple lock | 10 |
| Track a creature in fresh snow | 10 |
| Climb a wall with handholds | 15 |
| Pick a complex lock | 15 |
| Swim against a strong current | 20 |
| Track a stealthy creature on stone | 25 |

---

## 19. Reading Stat Blocks

Standard fields (in order):
1. Name, size, type, alignment.
2. Armor Class (and source).
3. Hit Points (and HD formula).
4. Speed (modes: walk, fly, swim, climb, burrow).
5. Six abilities (score and modifier).
6. Saving throws (proficient ones).
7. Skills (proficient ones with bonuses).
8. Damage Vulnerabilities / Resistances / Immunities.
9. Condition Immunities.
10. Senses (with passive Perception).
11. Languages.
12. Challenge Rating (XP value).
13. Proficiency Bonus.
14. Special traits (always-on abilities).
15. Actions.
16. Reactions (if any).
17. Legendary Actions / Lair Actions (if any).

### 19.1 Challenge Rating (CR) by XP

| CR | XP | CR | XP |
|---|---|---|---|
| 0 | 0 or 10 | 11 | 7,200 |
| 1/8 | 25 | 12 | 8,400 |
| 1/4 | 50 | 13 | 10,000 |
| 1/2 | 100 | 14 | 11,500 |
| 1 | 200 | 15 | 13,000 |
| 2 | 450 | 16 | 15,000 |
| 3 | 700 | 17 | 18,000 |
| 4 | 1,100 | 18 | 20,000 |
| 5 | 1,800 | 19 | 22,000 |
| 6 | 2,300 | 20 | 25,000 |
| 7 | 2,900 | 21 | 33,000 |
| 8 | 3,900 | 22 | 41,000 |
| 9 | 5,000 | 23 | 50,000 |
| 10 | 5,900 | 24 | 62,000 |

(continues to CR 30 = 155,000 XP)

---

## 20. Decision Trees for AI Agent (resolution patterns)

### 20.1 "Can the character do X?"
1. Is X a free action / interaction? → Yes, no roll.
2. Does X require an action / bonus action / reaction? → Confirm action economy budget remaining this turn.
3. Does X require a roll?
   - Is it opposed? → Both sides roll relevant ability check.
   - Is it against a DC? → Set DC by difficulty table; roll d20 + ability mod (+ proficiency if applicable).
4. Is there a relevant feature/spell that bypasses or modifies the roll?
5. Does the result trigger any conditions or effects?

### 20.2 "Resolve an attack"
1. Action available? Target in range? Required components/ammo?
2. Attack roll: d20 + STR or DEX mod + proficiency.
3. Apply advantage/disadvantage from circumstances.
4. Compare to AC; on hit, roll damage (+ ability mod).
5. Apply resistances/immunities/vulnerabilities.
6. Apply on-hit effects (poison, grapple, etc.).

### 20.3 "Resolve a spell"
1. Caster has spell prepared/known and slot of sufficient level?
2. Components met? Concentration impact (drop existing concentration if needed)?
3. Casting time fits action economy?
4. Target in range, line of sight as required?
5. Attack roll OR saving throw?
   - Spell attack: d20 + spellcasting mod + PB vs AC.
   - Save: target rolls d20 + save ability mod (+ PB if proficient) vs DC = 8 + spellcasting mod + PB.
6. Apply damage (resistance/immunity), conditions, durations.

### 20.4 "Initiative for a new combat"
1. Detect surprise (Stealth vs PP).
2. All combatants roll d20 + DEX mod.
3. Sort descending. Resolve ties by DM call (or higher DEX wins, common house rule).
4. Surprised creatures cannot act on round 1 turn 1, no reactions until that turn ends.

---

## 21. Source Notes

- Section 1, 2, 3 (core mechanics, character creation, combat): Basic Rules.
- Class table (§12): synthesizes Basic Rules + PHB metadata (factual data only).
- Spell slot tables (§13): SRD/Basic Rules.
- Conditions (§4): Basic Rules + PHB Appendix A.
- Equipment / properties (§9): Basic Rules.

For full descriptive text of any feature, consult the original PDFs directly — this document focuses on rules-as-applied for AI-agent decision making.
