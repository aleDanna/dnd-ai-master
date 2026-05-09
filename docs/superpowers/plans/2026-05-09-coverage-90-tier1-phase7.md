# Coverage 90% — Tier 1 Phase 7: NPC Three-Beat + Tonal Frame

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sblocca +3 punti coverage portando "NPC system + Master craft" da 33% a ~70%. Tre pezzi:
1. NPC Three-Beat schema (Master Handbook §11.1: every NPC has Want/Fear/Quirk + Attitude)
2. Tonal Frame at session level (Master World Lore §5.1: 8 frames: high-heroic/sword-sorcery/dark/mythic/cosmic-horror/swashbuckling/wuxia/steampunk)
3. Engagement Profile hints (Master Handbook §2.1: 7 profiles for player engagement detection)

**Architecture:**
- **NPC Three-Beat**: schema fields on `codex_entities` (kind='npc'): `want?: string`, `fear?: string`, `quirk?: string`, `attitude?: 'friendly' | 'indifferent' | 'hostile'`. The `lookup_codex` tool returns them; the AI Master is encouraged (via system prompt) to populate when creating an NPC entry.
- **Tonal Frame**: `Session.tonalFrame?: TonalFrame` field. Set at session creation (or via `set_tonal_frame` tool). Injected into the system prompt as a session-specific block: "This campaign's tonal frame is [frame] — flavor all NPCs/environments/conflict accordingly."
- **Engagement Profile**: `Session.engagementProfile?: EngagementProfile[]` (array of detected profiles). Populated narratively via `set_engagement_profile` tool. Injected into system prompt as a hint.

**Tech Stack:** TypeScript strict, Vitest, Drizzle (1 migration). Builds on Phase 1-6.

---

## File Structure

### File da creare:
- `src/engine/npc-tonal.ts` — types + helpers (validNPCBeat, validTonalFrame, validEngagementProfile)
- `tests/engine/npc-tonal.test.ts`
- `tests/engine/scenarios/npc-tonal-loop.test.ts`
- `drizzle/0017_*.sql`

### File da modificare:
- `src/engine/types.ts` — `TonalFrame`, `EngagementProfile`, `NPCBeat`, `NPCAttitude` types; mutations set_tonal_frame, set_engagement_profile, update_npc_beats
- `src/db/schema/codex-entities.ts` — colonne `want`, `fear`, `quirk`, `attitude`
- `src/db/schema/sessions.ts` — colonne `tonalFrame`, `engagementProfile`
- `src/sessions/applicator.ts` — handler per le 3 nuove mutations
- `src/sessions/snapshot.ts` — hydrate tonalFrame + engagementProfile + NPC beats nel codex
- `src/engine/tools/handlers.ts` — set_tonal_frame, set_engagement_profile, update_npc_beats handlers
- `src/engine/tools/index.ts` — schema dei nuovi tool
- `src/ai/master/system-prompt.ts` — inject tonalFrame + engagementProfile + Three-Beat encouragement

---

## Task 1: Types + helpers

```ts
// types.ts
export type TonalFrame = 'high_heroic' | 'sword_sorcery' | 'dark' | 'mythic' | 'cosmic_horror' | 'swashbuckling' | 'wuxia' | 'steampunk';

export type EngagementProfile = 'acting' | 'fighting' | 'instigating' | 'optimizing' | 'problem_solving' | 'storytelling' | 'exploring';

export type NPCAttitude = 'friendly' | 'indifferent' | 'hostile';

export interface NPCBeats {
  want?: string;
  fear?: string;
  quirk?: string;
  attitude?: NPCAttitude;
}

// Mutations:
| { op: 'set_tonal_frame'; frame: TonalFrame }
| { op: 'set_engagement_profile'; profiles: EngagementProfile[] }
| { op: 'update_npc_beats'; npcSlug: string; beats: NPCBeats }
```

```ts
// src/engine/npc-tonal.ts
import type { TonalFrame, EngagementProfile, NPCAttitude } from './types';

export const TONAL_FRAMES: TonalFrame[] = [
  'high_heroic', 'sword_sorcery', 'dark', 'mythic',
  'cosmic_horror', 'swashbuckling', 'wuxia', 'steampunk',
];

export const ENGAGEMENT_PROFILES: EngagementProfile[] = [
  'acting', 'fighting', 'instigating', 'optimizing',
  'problem_solving', 'storytelling', 'exploring',
];

export const NPC_ATTITUDES: NPCAttitude[] = ['friendly', 'indifferent', 'hostile'];

export function isValidTonalFrame(s: string): s is TonalFrame {
  return TONAL_FRAMES.includes(s as TonalFrame);
}

export function isValidEngagementProfile(s: string): s is EngagementProfile {
  return ENGAGEMENT_PROFILES.includes(s as EngagementProfile);
}

export function isValidNPCAttitude(s: string): s is NPCAttitude {
  return NPC_ATTITUDES.includes(s as NPCAttitude);
}

/** Check whether an NPC's beats are "complete" — all 4 fields populated.
 *  Used by the Master prompt to remind the AI to fill them. */
export function npcBeatsComplete(beats: { want?: string; fear?: string; quirk?: string; attitude?: NPCAttitude }): boolean {
  return !!(beats.want && beats.fear && beats.quirk && beats.attitude);
}

/** Tonal frame guidance for the system prompt (1-2 sentences each). */
export const TONAL_FRAME_GUIDANCE: Record<TonalFrame, string> = {
  high_heroic: 'Heroes save kingdoms; evil is clear; magic is wondrous. Lean into LotR-style triumph and noble sacrifice.',
  sword_sorcery: 'Gritty, morally grey; magic is rare and corrupting. Conan/Elric flavor: lone protagonists, ambiguous victories.',
  dark: 'The world is dying; every win is a delaying action. Berserk/Bloodborne — body horror, futility undertones.',
  mythic: 'Gods walk the earth; prophecies bind; fate is real. Greek myth/Witcher — cosmic stakes, archetypal characters.',
  cosmic_horror: 'The universe is indifferent; knowledge corrodes. Lovecraft/Bloodborne — sanity, dread, the unknowable.',
  swashbuckling: 'Flashy duels, wit over might, adventure as play. Princess Bride — banter, daring rescues, romance.',
  wuxia: 'Martial schools, honor, ki, mountain monasteries. Eastern flavor: lineage, philosophical conflict, gravity-defying combat.',
  steampunk: 'Magic intersects with industry; airships, gunsmoke, factory cities. Eberron — pulp investigation, magitech.',
};
```

Tests covering all helpers + the guidance dict has all 8 entries.

Commit: `feat(npc-tonal): types + helpers + tonal frame guidance`.

---

## Task 2: Schema + applicator + migration

### Schema additions

```ts
// src/db/schema/codex-entities.ts (npc kind metadata)
want: text('want'),
fear: text('fear'),
quirk: text('quirk'),
attitude: varchar('attitude', { length: 16 }),  // 'friendly' | 'indifferent' | 'hostile'

// src/db/schema/sessions.ts
tonalFrame: varchar('tonal_frame', { length: 32 }),
engagementProfile: jsonb('engagement_profile').$type<string[]>().default([]),
```

### Migration

```bash
pnpm db:generate
pnpm db:migrate
```

### Applicator handlers

```ts
case 'set_tonal_frame': {
  await tx.update(sessionsTable).set({ tonalFrame: m.frame }).where(eq(sessionsTable.id, sessionId));
  break;
}
case 'set_engagement_profile': {
  await tx.update(sessionsTable).set({ engagementProfile: m.profiles }).where(eq(sessionsTable.id, sessionId));
  break;
}
case 'update_npc_beats': {
  // Find the codex entity with kind='npc' and slug=m.npcSlug. Update want/fear/quirk/attitude.
  const next: Record<string, unknown> = {};
  if (m.beats.want != null) next.want = m.beats.want;
  if (m.beats.fear != null) next.fear = m.beats.fear;
  if (m.beats.quirk != null) next.quirk = m.beats.quirk;
  if (m.beats.attitude != null) next.attitude = m.beats.attitude;
  if (Object.keys(next).length > 0) {
    await tx.update(codexEntitiesTable)
      .set(next)
      .where(and(eq(codexEntitiesTable.sessionId, sessionId), eq(codexEntitiesTable.kind, 'npc'), eq(codexEntitiesTable.slug, m.npcSlug)));
  }
  break;
}
```

### Snapshot hydration

```ts
state.tonalFrame = sessionRow.tonalFrame ?? undefined;
state.engagementProfile = sessionRow.engagementProfile ?? [];
// In codex lookup: include want/fear/quirk/attitude in NPC entries.
```

Tests. Commit: `feat(applicator): NPC beats + tonal frame + engagement profile mutations + migration 0017`.

---

## Task 3: Tools

### handleSetTonalFrame, handleSetEngagementProfile, handleUpdateNPCBeats

Standard pattern: validate → emit mutation. Errors:
- `set_tonal_frame`: invalid frame → 'invalid_tonal_frame'
- `set_engagement_profile`: any invalid profile in array → 'invalid_engagement_profile'
- `update_npc_beats`: invalid attitude → 'invalid_attitude'; missing npcSlug → 'missing_npc_slug'

### Tool defs

```ts
{
  name: 'set_tonal_frame',
  description: 'Master Handbook §5.1: set the campaign\'s tonal frame. Affects narration style, NPC speech, combat consequences. 8 frames available: high_heroic, sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia, steampunk.',
  input_schema: { type: 'object', properties: { frame: { type: 'string', enum: TONAL_FRAMES } }, required: ['frame'] },
},
{
  name: 'set_engagement_profile',
  description: 'Master Handbook §2.1: register the player\'s engagement profile(s) detected from their first few turns. Up to multiple values. Affects what scenes the Master should prioritize.',
  input_schema: { type: 'object', properties: { profiles: { type: 'array', items: { type: 'string', enum: ENGAGEMENT_PROFILES } } }, required: ['profiles'] },
},
{
  name: 'update_npc_beats',
  description: 'Master Handbook §11.1: every NPC needs three beats (Want, Fear, Quirk) + an Attitude (friendly/indifferent/hostile). Use this tool whenever you introduce a new NPC OR refine an existing one\'s motivations.',
  input_schema: { /* npcSlug, beats: { want?, fear?, quirk?, attitude? } */ },
},
```

Tests + commit: `feat(tools): NPC beats + tonal frame + engagement profile tools`.

---

## Task 4: System prompt injection

Modify `src/ai/master/system-prompt.ts` so the dynamic block now reads:

```ts
// Append AFTER the static MASTER_TOOL_CONTRACT block:
const dynamicTonalBlock = state.tonalFrame
  ? `\n\n## Campaign Tonal Frame\n\n**Frame**: ${state.tonalFrame}\n\n${TONAL_FRAME_GUIDANCE[state.tonalFrame]}\n\nFlavor every scene, NPC, and consequence according to this frame. The frame is the lens.`
  : '';

const dynamicProfileBlock = state.engagementProfile?.length
  ? `\n\n## Player Engagement Hint\n\nDetected profiles: ${state.engagementProfile.join(', ')}.\n\nLean into scenes that reward these styles.`
  : '';
```

Plus a static section in the prompt that says:

```
### NPC Three-Beat (Master Handbook §11.1)

Every NPC the PC interacts with needs three beats:
- **Want**: what does this NPC want from this scene? (a coin, a favor, to be left alone, to test the PC)
- **Fear**: what would make them flee or escalate?
- **Quirk**: one memorable detail (smells of fish, cracks knuckles, never makes eye contact, laughs at wrong moments)
Plus an **Attitude**: friendly / indifferent / hostile.

When you introduce a new NPC, call `update_npc_beats({ npcSlug, beats: { want, fear, quirk, attitude } })`
to record these. The AI Master should NOT introduce a named, recurring NPC without filling all four fields.

You can refine the beats later as the relationship with the PC evolves
(e.g., attitude shifts from indifferent to friendly after a favor).

### Tonal Frame guidance (Master World Lore §5.1)

If `state.tonalFrame` is set, the campaign has chosen one of 8 frames. The
prompt block above (Campaign Tonal Frame) gives the lens. Match NPC speech
register, combat consequences, magic flavor, and prose density to the frame.

### Engagement Profile (Master Handbook §2.1)

If `state.engagementProfile` is non-empty, the player has shown a preference
for one or more of: acting, fighting, instigating, optimizing, problem_solving,
storytelling, exploring. Lean scenes toward these styles.
```

Commit: `docs(prompt): NPC Three-Beat + tonal frame + engagement profile injection`.

---

## Task 5: E2E + smoke

`tests/engine/scenarios/npc-tonal-loop.test.ts`:
1. Set tonal frame 'dark' → session has tonalFrame='dark'.
2. Set engagement profile ['exploring', 'storytelling'] → session has profile.
3. Update NPC beats: introduce NPC 'gareth-the-blacksmith' with want='his daughter back', fear='the new lord', quirk='cracks knuckles', attitude='friendly' → codex entry has all 4.
4. Update NPC beats partial (only quirk='hums constantly') → existing want/fear/attitude unchanged.
5. Invalid frame error: 'invalid_tonal_frame'.
6. Invalid profile error in array: 'invalid_engagement_profile'.

Smoke + commit final tweaks.

---

## Self-review checklist

- [ ] Coverage delta: NPC system 33% → ~70%.
- [ ] Backward compat: all new fields optional.
- [ ] tonalFrame and engagementProfile injected into system prompt only when set.
- [ ] update_npc_beats partial updates work (existing fields preserved).

---

## Stima sforzo Phase 7

- Task 1 (types + helpers): 1.5h
- Task 2 (schema + applicator + migration): 2h
- Task 3 (tools): 1.5h
- Task 4 (system prompt): 1h
- Task 5 (E2E + smoke): 1h

**Totale: ~7h** developer; subagent-driven: ~1 giornata.
