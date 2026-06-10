/**
 * Phase 03-A plan 03-A-10 — reverse-lookup: VaultEvent → Postgres mutation.
 *
 * `invokeEnginePathwayFromEvent` is the callback the apply_event dispatcher
 * (src/ai/master/vault/tools.ts) closes over and hands to
 * `dualWriteApplyEvent` (src/sessions/dual-writer.ts) as the Postgres leg
 * of the parallel write. For each Phase 02 / Phase 03 event type listed in
 * `.planning/phases/03-migration-cutover/COMPLETENESS-AUDIT.md` §"(a)
 * Already-covered handler mapping", this function performs the EQUIVALENT
 * Postgres mutation that the baked engine path would have performed when
 * the LLM called the matching engine tool.
 *
 * Why direct Drizzle (and not `applyMutations`)
 * --------------------------------------------------------------------------
 * The engine `applyMutations` (src/sessions/applicator.ts) carries side
 * effects beyond the column update: it emits `notifySession({type:'state'})`,
 * loads a `SessionContext` (host's PC, not necessarily the event target),
 * dedupes `add_inventory`, opens its own `db.transaction(...)`, and applies
 * combat-actor-vs-PC branching keyed off `ctx.characterId`. Routing vault
 * events through it would (1) re-emit a stale state-notification per event
 * (the LLM turn already emits one at the end), (2) misroute mutations for
 * events whose `payload.character` is NOT the host PC in a multi-PC party,
 * and (3) entangle the dual-write parity surface with the dedup logic that
 * is applicator-internal. Direct Drizzle lets the dual-writer perform the
 * exact column update the audit table will diff against.
 *
 * Why this lives in `src/sessions/` (not `src/ai/master/vault/`)
 * --------------------------------------------------------------------------
 * It writes to Postgres (`session_state`, `characters`) — the vault module
 * is filesystem-only. Putting it in `sessions/` keeps the import graph
 * acyclic: `dual-writer.ts` (Postgres + vault) imports both the vault
 * `EventsWriter` AND this engine-mutation alias; the vault subtree never
 * imports `sessions/`.
 *
 * Failure-mode contract
 * --------------------------------------------------------------------------
 * - Missing rows (character or session_state) → silent return (the dual-
 *   writer's Promise.all sees the resolved void, the parity-check then
 *   detects + records the divergence via the regular audit path).
 * - Unknown event type → `_exhaustive: never` triggers a tsc error at
 *   compile-time; runtime fallthrough returns silently (defensive).
 * - DB error (UPDATE rejects, transaction aborts) → re-throws. The
 *   dual-writer's `Promise.all` catches; the vault leg may have already
 *   appended its event. The thrown error surfaces in the LLM turn as
 *   `isError: true` via the dispatcher's catch.
 *
 * Mapping table (from COMPLETENESS-AUDIT.md §"(a)" + §"(c)")
 * --------------------------------------------------------------------------
 * Phase 02:
 *   - hp_change          → session_state.hp_current ± delta (clamped 0..hp_max)
 *   - condition_add      → session_state.conditions [+ slug]
 *   - condition_remove   → session_state.conditions [- slug]
 *   - spell_slot_use     → characters.spell_slots_used[level] += 1
 *   - spell_slot_restore → characters.spell_slots_used[level] -= 1 (min 0)
 *   - inventory_add      → characters.inventory [+ {slug, qty, equipped:false}]
 *   - inventory_remove   → characters.inventory [- slug or qty -= qty]
 *
 * Phase 03 (NEW):
 *   - temp_hp_set        → session_state.temp_hp = tempHp
 *   - death_save_success → session_state.death_saves.successes++ (3 → reset + stable)
 *   - death_save_fail    → session_state.death_saves.failures += (critical ? 2 : 1) (3 → reset + dead)
 *   - death_save_stabilize → session_state.death_saves = reset + flags.stable = true
 *   - death_save_recover_at_one → session_state.hp_current = 1, death_saves reset, stable cleared
 *   - concentration_set  → session_state.concentrating_on = {spellSlug, slotLevel, startedRound}
 *   - concentration_break → session_state.concentrating_on = null
 *   - exhaustion_increment → session_state.exhaustion_level += 1 (capped at 6, sets flags.dead at 6)
 *   - exhaustion_decrement → session_state.exhaustion_level -= 1 (floored at 0)
 *   - hit_dice_use       → session_state.hit_dice_remaining -= count (min 0)
 *   - hit_dice_restore   → session_state.hit_dice_remaining += count
 *   - resource_use       → characters.resources_used[resourceKey] += uses
 *   - resource_restore   → characters.resources_used[resourceKey] -= uses (min 0)
 *   - inspiration_grant  → characters.inspiration = true
 *   - inspiration_spend  → characters.inspiration = false
 *   - attune             → characters.attuned_items [+ slug] (idempotent)
 *   - unattune           → characters.attuned_items [- slug]
 *   - xp_award           → characters.xp += amount
 *
 * Phase 03 NO-OP (no clean Postgres counterpart, parity-check will surface
 * any divergence; operator remediates via vault:rebuild-views):
 *   - focus_set / focus_unset → characters.equipped_focus is a JSONB column
 *     but the AUDIT classifies focus as (c)-with-direct-Drizzle. Implemented.
 *   - campaign_initialized   → seed event; the vault-flip script (plan
 *     02-10) already wrote Postgres state. The dual-writer should never
 *     see this event in the steady-state turn loop.
 *   - level_up               → multi-row update (level, hp_delta, slots).
 *     Not exposed via the vault apply_event surface; engine emits via the
 *     baked tool surface. Deferred — parity-check will surface.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessionState, characters } from '@/db/schema';
import type { VaultEventEnvelope, VaultEvent } from '@/ai/master/vault/events-schema';

/**
 * Apply the Postgres-side equivalent of `envelope` to the relevant
 * `session_state` / `characters` columns for `(sessionId, characterId)`.
 *
 * Returns void on success (including the silent no-op skip cases listed in
 * the module JSDoc). Re-throws on DB errors so the dual-writer's
 * `Promise.all` can fail the parallel write.
 *
 * `characterId` may be null for session-level events (`campaign_initialized`
 * — never seen in steady-state) or for events the dispatcher chose not to
 * key on a character (none exist today; included for forward compatibility).
 * The function returns silently when characterId is null and the event
 * requires a character.
 */
export async function invokeEnginePathwayFromEvent(
  envelope: VaultEventEnvelope,
  sessionId: string,
  characterId: string | null,
): Promise<void> {
  const event = envelope as VaultEvent;
  switch (event.type) {
    case 'hp_change': {
      // 2026-06-10 audit — mirror the vault reducer's RAW pipeline
      // (projector.ts hp_change), not just a clamp: temp-HP absorption,
      // unconscious/dying at 0 (instant death on massive damage), one
      // automatic death-save failure when damaged while at 0, wake-on-heal
      // (rules.md §3.17–3.21). The two legs must stay semantically
      // equivalent or every combat turn diverges under dual-write.
      // We use `event.payload.character` rather than the dispatcher's
      // `characterId` argument because the event payload is the source of
      // truth for which PC owns the mutation (multi-PC party).
      const targetId = event.payload.character;
      const [char] = await db.select({ hpMax: characters.hpMax }).from(characters).where(eq(characters.id, targetId)).limit(1);
      const [state] = await db
        .select({ hpCurrent: sessionState.hpCurrent, tempHp: sessionState.tempHp, conditions: sessionState.conditions, deathSaves: sessionState.deathSaves, flags: sessionState.flags })
        .from(sessionState)
        .where(eq(sessionState.sessionId, sessionId))
        .limit(1);
      if (!char || !state) return;
      const delta = event.payload.delta;
      const flags = { ...(state.flags ?? {}) } as { stable?: boolean; dead?: boolean };
      const deathSaves = state.deathSaves ?? { successes: 0, failures: 0 };
      const conditions = (state.conditions ?? []) as { slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[];

      if (delta < 0) {
        let dmg = -delta;
        let tempHp = state.tempHp ?? 0;
        if (tempHp > 0) {
          const absorbed = Math.min(tempHp, dmg);
          tempHp -= absorbed;
          dmg -= absorbed;
        }
        if (dmg === 0) {
          await db.update(sessionState).set({ tempHp }).where(eq(sessionState.sessionId, sessionId));
          return;
        }
        if (state.hpCurrent === 0) {
          if (flags.dead) return;
          const failures = Math.min(3, deathSaves.failures + 1);
          await db.update(sessionState).set({
            tempHp,
            deathSaves: failures >= 3 ? { successes: 0, failures: 3 } : { successes: deathSaves.successes, failures },
            flags: { ...flags, stable: false, dead: failures >= 3 },
          }).where(eq(sessionState.sessionId, sessionId));
          return;
        }
        const hpAfter = Math.max(0, state.hpCurrent - dmg);
        if (hpAfter === 0) {
          const overkill = dmg - state.hpCurrent;
          if (overkill >= char.hpMax) {
            await db.update(sessionState).set({
              hpCurrent: 0,
              tempHp,
              flags: { ...flags, stable: false, dead: true },
            }).where(eq(sessionState.sessionId, sessionId));
            return;
          }
          const conds = conditions.slice();
          if (!conds.some((c) => c.slug === 'unconscious')) {
            conds.push({ slug: 'unconscious', source: 'dropped to 0 HP', durationRounds: 'until_removed', appliedRound: 0 });
          }
          await db.update(sessionState).set({
            hpCurrent: 0,
            tempHp,
            conditions: conds,
            deathSaves: { successes: 0, failures: 0 },
            flags: { ...flags, stable: false },
          }).where(eq(sessionState.sessionId, sessionId));
          return;
        }
        await db.update(sessionState).set({ hpCurrent: hpAfter, tempHp }).where(eq(sessionState.sessionId, sessionId));
        return;
      }

      // Heal (delta >= 0).
      if (flags.dead) return; // RAW: hp_change cannot revive the dead
      const next = Math.max(0, Math.min(char.hpMax, state.hpCurrent + delta));
      if (state.hpCurrent === 0 && next > 0) {
        // PHB §3.21 wake-on-heal (mirrors applicator heal-from-0).
        await db.update(sessionState).set({
          hpCurrent: next,
          conditions: conditions.filter((c) => c.slug !== 'unconscious'),
          deathSaves: { successes: 0, failures: 0 },
          flags: { ...flags, stable: false },
        }).where(eq(sessionState.sessionId, sessionId));
        return;
      }
      await db.update(sessionState).set({ hpCurrent: next }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'temp_hp_set': {
      // PHB §3.21: temp HP is an absorption buffer; setter overwrites the
      // current value (does NOT stack). Min 0 enforced by the validator
      // (tempHp >= 0) so no further clamping.
      await db.update(sessionState).set({ tempHp: Math.max(0, event.payload.tempHp) }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'condition_add': {
      // Append to conditions[] — idempotent on slug. Source/duration are
      // 'vault-tool' / 'until_removed' placeholders because the vault
      // event schema does NOT carry that metadata (the projector's vault
      // state likewise omits source/duration — the parity-check only diffs
      // condition SLUGS).
      const [state] = await db.select({ conditions: sessionState.conditions }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const existing = state.conditions ?? [];
      if (existing.some((c) => c.slug === event.payload.condition)) return;
      const next = [...existing, {
        slug: event.payload.condition,
        source: 'vault-tool',
        durationRounds: 'until_removed' as const,
        appliedRound: 0,
      }];
      await db.update(sessionState).set({ conditions: next }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'condition_remove': {
      const [state] = await db.select({ conditions: sessionState.conditions }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const next = (state.conditions ?? []).filter((c) => c.slug !== event.payload.condition);
      await db.update(sessionState).set({ conditions: next }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'spell_slot_use':
    case 'spell_slot_restore': {
      // Per-character ledger keyed by level-string ("1", "2", ...). Mirror
      // applicator.ts use_spell_slot / restore_spell_slot. spell_slot_use
      // increments by 1; spell_slot_restore decrements by 1 (min 0).
      const targetId = event.payload.character;
      const [char] = await db.select({ spellSlotsUsed: characters.spellSlotsUsed }).from(characters).where(eq(characters.id, targetId)).limit(1);
      if (!char) return;
      const used = { ...(char.spellSlotsUsed ?? {}) };
      const level = String(event.payload.level);
      const cur = used[level] ?? 0;
      if (event.type === 'spell_slot_use') {
        used[level] = cur + 1;
      } else {
        const next = Math.max(0, cur - 1);
        if (next === 0) delete used[level];
        else used[level] = next;
      }
      await db.update(characters).set({ spellSlotsUsed: used }).where(eq(characters.id, targetId));
      return;
    }

    case 'inventory_add': {
      // Mirror applicator.ts add_inventory: append a new entry OR bump qty
      // on existing slug. equipped defaults to false (vault has no
      // equip-on-pickup notion).
      const targetId = event.payload.character;
      const [char] = await db.select({ inventory: characters.inventory }).from(characters).where(eq(characters.id, targetId)).limit(1);
      if (!char) return;
      const inv = [...(char.inventory ?? [])];
      const existingIdx = inv.findIndex((i) => i.slug === event.payload.item);
      if (existingIdx >= 0) {
        const existing = inv[existingIdx]!;
        inv[existingIdx] = { ...existing, qty: existing.qty + event.payload.qty };
      } else {
        inv.push({ slug: event.payload.item, qty: event.payload.qty, equipped: false });
      }
      await db.update(characters).set({ inventory: inv }).where(eq(characters.id, targetId));
      return;
    }

    case 'inventory_remove': {
      // Mirror applicator.ts remove_inventory: decrement qty, drop entry
      // when qty hits 0. No-op when slug is absent.
      const targetId = event.payload.character;
      const [char] = await db.select({ inventory: characters.inventory }).from(characters).where(eq(characters.id, targetId)).limit(1);
      if (!char) return;
      const inv = [...(char.inventory ?? [])];
      const existingIdx = inv.findIndex((i) => i.slug === event.payload.item);
      if (existingIdx < 0) return;
      const existing = inv[existingIdx]!;
      const nextQty = existing.qty - event.payload.qty;
      if (nextQty <= 0) {
        inv.splice(existingIdx, 1);
      } else {
        inv[existingIdx] = { ...existing, qty: nextQty };
      }
      await db.update(characters).set({ inventory: inv }).where(eq(characters.id, targetId));
      return;
    }

    case 'death_save_success':
    case 'death_save_fail':
    case 'death_save_stabilize':
    case 'death_save_recover_at_one': {
      // PHB §3.21 — death save reducer semantics (mirrors applicator.ts
      // death_save / reset_death_saves / set_stable). At 3 successes:
      // reset + flags.stable. At 3 failures: reset + flags.dead.
      const [state] = await db.select({
        hpCurrent: sessionState.hpCurrent,
        deathSaves: sessionState.deathSaves,
        flags: sessionState.flags,
      }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const ds = state.deathSaves ?? { successes: 0, failures: 0 };
      const flags = state.flags ?? {};
      if (event.type === 'death_save_success') {
        const successes = ds.successes + 1;
        if (successes >= 3) {
          await db.update(sessionState).set({
            deathSaves: { successes: 0, failures: 0 },
            flags: { ...flags, stable: true },
          }).where(eq(sessionState.sessionId, sessionId));
        } else {
          await db.update(sessionState).set({
            deathSaves: { successes, failures: ds.failures },
          }).where(eq(sessionState.sessionId, sessionId));
        }
      } else if (event.type === 'death_save_fail') {
        const incrementBy = event.payload.critical === true ? 2 : 1;
        const failures = ds.failures + incrementBy;
        if (failures >= 3) {
          await db.update(sessionState).set({
            deathSaves: { successes: 0, failures: 0 },
            flags: { ...flags, dead: true },
          }).where(eq(sessionState.sessionId, sessionId));
        } else {
          await db.update(sessionState).set({
            deathSaves: { successes: ds.successes, failures },
          }).where(eq(sessionState.sessionId, sessionId));
        }
      } else if (event.type === 'death_save_stabilize') {
        // Manual stabilize: reset saves, mark stable (still unconscious).
        await db.update(sessionState).set({
          deathSaves: { successes: 0, failures: 0 },
          flags: { ...flags, stable: true },
        }).where(eq(sessionState.sessionId, sessionId));
      } else {
        // death_save_recover_at_one: nat20 atomic recovery → HP=1, saves
        // reset, stable cleared (PC wakes up). Per PHB §3.21.
        await db.update(sessionState).set({
          hpCurrent: 1,
          deathSaves: { successes: 0, failures: 0 },
          flags: { ...flags, stable: false },
        }).where(eq(sessionState.sessionId, sessionId));
      }
      return;
    }

    case 'concentration_set': {
      // PHB §10.4 — set the concentration target. Overwrites any prior
      // concentration (a new concentration spell breaks the old one — the
      // engine emits break_concentration first, then set_concentration; the
      // vault dispatches them in that order via two apply_event calls).
      await db.update(sessionState).set({
        concentratingOn: {
          spellSlug: event.payload.spellSlug,
          slotLevel: event.payload.slotLevel,
          startedRound: event.payload.startedRound,
        },
      }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'concentration_break': {
      await db.update(sessionState).set({ concentratingOn: null }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'exhaustion_increment': {
      // PHB §4.1 — 6-level cumulative track. The slug appears in
      // conditions[] only ONCE; the level lives in
      // session_state.exhaustion_level. Mirror applicator.ts
      // add_condition('exhaustion') special-case.
      const [state] = await db.select({
        exhaustionLevel: sessionState.exhaustionLevel,
        conditions: sessionState.conditions,
        flags: sessionState.flags,
      }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const cur = state.exhaustionLevel ?? 0;
      const newLevel = Math.min(6, cur + 1);
      const conds = [...(state.conditions ?? [])];
      const hasExhaustion = conds.some((c) => c.slug === 'exhaustion');
      if (!hasExhaustion) {
        conds.push({
          slug: 'exhaustion',
          source: event.payload.source,
          durationRounds: 'until_removed' as const,
          appliedRound: 0,
        });
      }
      const flags = state.flags ?? {};
      const nextFlags = newLevel >= 6 ? { ...flags, dead: true } : flags;
      await db.update(sessionState).set({
        exhaustionLevel: newLevel,
        conditions: conds,
        flags: nextFlags,
      }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'exhaustion_decrement': {
      const [state] = await db.select({
        exhaustionLevel: sessionState.exhaustionLevel,
        conditions: sessionState.conditions,
      }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const cur = state.exhaustionLevel ?? 0;
      if (cur <= 0) return;
      const newLevel = Math.max(0, cur - 1);
      const conds = newLevel === 0
        ? (state.conditions ?? []).filter((c) => c.slug !== 'exhaustion')
        : (state.conditions ?? []);
      await db.update(sessionState).set({
        exhaustionLevel: newLevel,
        conditions: conds,
      }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'hit_dice_use': {
      // Mirror applicator.ts spend_hit_die — but spend_hit_die decrements
      // by 1 per op. The vault event lets a single apply_event spend
      // multiple dice via `count` (matches short-rest semantics).
      const [state] = await db.select({ hitDiceRemaining: sessionState.hitDiceRemaining }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const next = Math.max(0, state.hitDiceRemaining - event.payload.count);
      await db.update(sessionState).set({ hitDiceRemaining: next }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'hit_dice_restore': {
      const [state] = await db.select({ hitDiceRemaining: sessionState.hitDiceRemaining }).from(sessionState).where(eq(sessionState.sessionId, sessionId)).limit(1);
      if (!state) return;
      const next = state.hitDiceRemaining + event.payload.count;
      await db.update(sessionState).set({ hitDiceRemaining: next }).where(eq(sessionState.sessionId, sessionId));
      return;
    }

    case 'resource_use':
    case 'resource_restore': {
      // Per-character feature ledger (rage, action-surge, channel-divinity,
      // bardic-inspiration, lay-on-hands, etc). Mirrors applicator.ts
      // use_resource / restore_resource — same column, additive semantics.
      const targetId = event.payload.character;
      const [char] = await db.select({ resourcesUsed: characters.resourcesUsed }).from(characters).where(eq(characters.id, targetId)).limit(1);
      if (!char) return;
      const used = { ...(char.resourcesUsed ?? {}) };
      const cur = used[event.payload.resourceKey] ?? 0;
      used[event.payload.resourceKey] = event.type === 'resource_use'
        ? cur + event.payload.uses
        : Math.max(0, cur - event.payload.uses);
      await db.update(characters).set({ resourcesUsed: used }).where(eq(characters.id, targetId));
      return;
    }

    case 'inspiration_grant':
    case 'inspiration_spend': {
      // PHB §18.1 — single boolean column. grant sets true; spend sets
      // false. Both are idempotent (granting when already inspired is a
      // no-op; spending when not inspired is a no-op — the engine guards
      // this server-side; the column write is unconditional here).
      const targetId = event.payload.character;
      await db.update(characters).set({
        inspiration: event.type === 'inspiration_grant',
      }).where(eq(characters.id, targetId));
      return;
    }

    case 'attune':
    case 'unattune': {
      // PHB §10.1 — attuned_items is a slug[] capped at 3 (cap enforced
      // engine-side, not here — the validator already bounded itemSlug
      // length to 64). attune is idempotent on duplicate slug; unattune
      // is idempotent on absent slug.
      const targetId = event.payload.character;
      const [char] = await db.select({ attunedItems: characters.attunedItems }).from(characters).where(eq(characters.id, targetId)).limit(1);
      if (!char) return;
      const items = [...(char.attunedItems ?? [])];
      if (event.type === 'attune') {
        if (items.includes(event.payload.itemSlug)) return;
        items.push(event.payload.itemSlug);
      } else {
        const idx = items.indexOf(event.payload.itemSlug);
        if (idx < 0) return;
        items.splice(idx, 1);
      }
      await db.update(characters).set({ attunedItems: items }).where(eq(characters.id, targetId));
      return;
    }

    case 'focus_set': {
      // PHB §8.4 — characters.equipped_focus JSONB ({kind, itemSlug}).
      // Overwrites any prior focus. The engine's set_focus tool runs the
      // same overwrite semantics.
      const targetId = event.payload.character;
      await db.update(characters).set({
        equippedFocus: { kind: event.payload.kind, itemSlug: event.payload.itemSlug },
      }).where(eq(characters.id, targetId));
      return;
    }

    case 'focus_unset': {
      const targetId = event.payload.character;
      await db.update(characters).set({ equippedFocus: null }).where(eq(characters.id, targetId));
      return;
    }

    case 'xp_award': {
      // Additive — DM grants XP (reason is metadata only; not persisted on
      // the characters row in Phase 03). Mirror applicator.ts award_xp.
      const targetId = event.payload.character;
      const [char] = await db.select({ xp: characters.xp }).from(characters).where(eq(characters.id, targetId)).limit(1);
      if (!char) return;
      await db.update(characters).set({ xp: char.xp + event.payload.amount }).where(eq(characters.id, targetId));
      return;
    }

    case 'campaign_initialized': {
      // Seed event — the vault-flip script (plan 02-10) already wrote
      // Postgres state when it emitted this event. The dual-writer should
      // never see this in the steady-state turn loop; if it does, no-op
      // on the Postgres side so we don't re-seed. The parity-check at
      // turn-time may surface a divergence if the operator manually
      // emitted a campaign_initialized via the LLM — that is a deferred
      // case the runbook covers (`vault:rebuild-views`).
      void characterId;
      return;
    }

    case 'combat_start':
    case 'monster_spawn':
    case 'initiative_set':
    case 'turn_advance':
    case 'monster_hp_change':
    case 'combat_end': {
      // Phase 06 D1 — encounter-scoped events have NO Postgres write.
      // Combat state is vault-native (events.md + combat.md) per the D1
      // architecture decision. REQ-037 prohibits Postgres combat writes
      // in this phase. The dual-writer invokes this function after vault
      // append; for encounter events we simply return without touching
      // session_state.combat or combat_actors.
      return;
    }

    default: {
      // tsc exhaustiveness — adding a new event type without an arm here
      // is a build error. Runtime fallthrough returns silently.
      const _exhaustive: never = event;
      void _exhaustive;
      return;
    }
  }
}
