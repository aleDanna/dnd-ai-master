import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessionState as sessionStateTable,
  combatActors as combatActorsTable,
  diceLog as diceLogTable,
  sessions as sessionsTable,
  characters as charactersTable,
  codexEntities as codexEntitiesTable,
  type DiceLogInsert,
} from '@/db/schema';
import type {
  ClassLevel,
  ConditionInstance,
  DiceRoll,
  Mutation,
  TurnState,
  TravelState,
  Senses,
} from '@/engine/types';
import { newTurnState, consumeAction, spendMovement } from '@/engine/combat/turn-state';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const VALID_KINDS = new Set(['attack', 'damage', 'save', 'check', 'init', 'generic']);

interface SessionContext {
  characterId: string;
  hpMax: number;
}

async function loadContext(tx: Tx, sessionId: string): Promise<SessionContext | null> {
  const [s] = await tx
    .select({ characterId: sessionsTable.characterId })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId))
    .limit(1);
  if (!s) return null;
  const [c] = await tx.select({ hpMax: charactersTable.hpMax }).from(charactersTable).where(eq(charactersTable.id, s.characterId)).limit(1);
  if (!c) return null;
  return { characterId: s.characterId, hpMax: c.hpMax };
}

export async function applyMutations(sessionId: string, mutations: Mutation[], rolls: DiceRoll[]): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await loadContext(tx, sessionId);
    if (!ctx) return;
    for (const m of mutations) {
      await applyOne(tx, sessionId, ctx, m);
    }
    if (rolls.length) {
      const inserts: DiceLogInsert[] = rolls.map((r) => ({
        sessionId,
        kind: pickKind(r),
        formula: r.formula,
        rolls: r.rolls,
        modifier: r.modifier,
        total: r.total,
        meta: r.meta ?? {},
      }));
      await tx.insert(diceLogTable).values(inserts);
    }
  });
}

function pickKind(r: DiceRoll): DiceLogInsert['kind'] {
  const k = (r.meta?.kind as string | undefined) ?? 'generic';
  return (VALID_KINDS.has(k) ? k : 'generic') as DiceLogInsert['kind'];
}

async function applyOne(tx: Tx, sessionId: string, ctx: SessionContext, m: Mutation): Promise<void> {
  switch (m.op) {
    case 'set_hp':
    case 'apply_damage':
    case 'heal': {
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
        const cur = s?.hpCurrent ?? 0;
        const next = m.op === 'set_hp' ? m.hpCurrent
                   : m.op === 'apply_damage' ? Math.max(0, cur - m.amount)
                   : Math.min(ctx.hpMax, cur + m.amount);
        // PHB §3.21: healing a creature at 0 HP wakes them — reset death
        // saves, drop the unconscious condition, clear any `stable` flag.
        if (m.op === 'heal' && s && cur === 0 && next > 0) {
          const conds = (s.conditions as ConditionInstance[]).filter((c) => c.slug !== 'unconscious');
          const flags = { ...((s.flags ?? {}) as { stable?: boolean; dead?: boolean }), stable: false };
          await tx
            .update(sessionStateTable)
            .set({
              hpCurrent: next,
              deathSaves: { successes: 0, failures: 0 },
              conditions: conds,
              flags,
            })
            .where(eq(sessionStateTable.sessionId, sessionId));
        } else {
          await tx.update(sessionStateTable).set({ hpCurrent: next }).where(eq(sessionStateTable.sessionId, sessionId));
        }
      } else {
        const [actor] = await tx.select().from(combatActorsTable).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId))).limit(1);
        if (!actor) return;
        const cur = actor.hpCurrent;
        const next = m.op === 'set_hp' ? m.hpCurrent
                   : m.op === 'apply_damage' ? Math.max(0, cur - m.amount)
                   : Math.min(actor.hpMax, cur + m.amount);
        await tx.update(combatActorsTable).set({ hpCurrent: next, isAlive: next > 0 }).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId)));
      }
      break;
    }
    case 'set_temp_hp': {
      await tx.update(sessionStateTable).set({ tempHp: m.amount }).where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'add_condition':
    case 'remove_condition': {
      const isPc = m.actorId === ctx.characterId;
      const targetSlug = m.op === 'add_condition' ? m.condition.slug : m.conditionSlug;
      if (isPc) {
        const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
        if (!s) return;
        // PHB §4.1: exhaustion is a 6-level cumulative track. The slug
        // appears in `conditions[]` only ONCE — the level lives in
        // `session_state.exhaustion_level`. Each add_condition increments
        // the level (capped at 6, sets flags.dead at 6); each
        // remove_condition decrements (min 0, removes from array at 0).
        if (targetSlug === 'exhaustion') {
          const curLevel = s.exhaustionLevel ?? 0;
          if (m.op === 'add_condition') {
            const newLevel = Math.min(6, curLevel + 1);
            const conds = (s.conditions as ConditionInstance[]).slice();
            const hasExhaustion = conds.some((c) => c.slug === 'exhaustion');
            if (!hasExhaustion) conds.push(m.condition);
            const flags = (s.flags ?? {}) as { stable?: boolean; dead?: boolean };
            const nextFlags = newLevel >= 6 ? { ...flags, dead: true } : flags;
            await tx
              .update(sessionStateTable)
              .set({ exhaustionLevel: newLevel, conditions: conds, flags: nextFlags })
              .where(eq(sessionStateTable.sessionId, sessionId));
          } else {
            // remove_condition: decrement, drop from array at 0
            if (curLevel <= 0) break; // no-op when already clear
            const newLevel = Math.max(0, curLevel - 1);
            const conds = newLevel === 0
              ? (s.conditions as ConditionInstance[]).filter((c) => c.slug !== 'exhaustion')
              : (s.conditions as ConditionInstance[]);
            await tx
              .update(sessionStateTable)
              .set({ exhaustionLevel: newLevel, conditions: conds })
              .where(eq(sessionStateTable.sessionId, sessionId));
          }
          break;
        }
        const conds = (s.conditions as ConditionInstance[]).filter((c) => c.slug !== targetSlug);
        if (m.op === 'add_condition') conds.push(m.condition);
        await tx.update(sessionStateTable).set({ conditions: conds }).where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        // FIX I1: scope by session_id too
        const [a] = await tx.select().from(combatActorsTable).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId))).limit(1);
        if (!a) return;
        const conds = (a.conditions as ConditionInstance[]).filter((c) => c.slug !== targetSlug);
        if (m.op === 'add_condition') conds.push(m.condition);
        await tx.update(combatActorsTable).set({ conditions: conds }).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId)));
      }
      break;
    }
    case 'use_spell_slot': {
      const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
      if (!s) return;
      const used = { ...(s.spellSlotsUsed as Record<string, number>) };
      used[String(m.level)] = (used[String(m.level)] ?? 0) + 1;
      await tx.update(sessionStateTable).set({ spellSlotsUsed: used }).where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'restore_spell_slot': {
      const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
      if (!s) return;
      const used = { ...(s.spellSlotsUsed as Record<string, number>) };
      const cur = used[String(m.level)] ?? 0;
      const next = Math.max(0, cur - Math.max(0, Math.floor(m.amount)));
      if (next === 0) delete used[String(m.level)];
      else used[String(m.level)] = next;
      await tx.update(sessionStateTable).set({ spellSlotsUsed: used }).where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'use_resource':
    case 'restore_resource': {
      const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
      if (!s) return;
      const used = { ...(s.resourcesUsed as Record<string, number>) };
      const cur = used[m.featureSlug] ?? 0;
      used[m.featureSlug] = m.op === 'use_resource' ? cur + m.amount : Math.max(0, cur - m.amount);
      await tx.update(sessionStateTable).set({ resourcesUsed: used }).where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'spend_hit_die':
    case 'restore_hit_dice': {
      const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
      if (!s) return;
      const next = m.op === 'spend_hit_die' ? Math.max(0, s.hitDiceRemaining - 1) : s.hitDiceRemaining + m.amount;
      await tx.update(sessionStateTable).set({ hitDiceRemaining: next }).where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'set_combat': {
      await tx.update(sessionStateTable).set({ inCombat: m.combat !== null, combat: m.combat ?? null }).where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'advance_turn': {
      const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
      if (!s || !s.combat) return;
      const c = s.combat;
      const last = c.currentIdx >= c.turnOrder.length - 1;
      const next = { ...c, currentIdx: last ? 0 : c.currentIdx + 1, round: last ? c.round + 1 : c.round };
      await tx.update(sessionStateTable).set({ combat: next }).where(eq(sessionStateTable.sessionId, sessionId));

      // PHB §8.7: tick condition durations at the end of the previous actor's
      // turn. The actor whose turn just ended is at c.turnOrder[c.currentIdx]
      // (BEFORE we advanced). Decrement durationRounds for round-counted
      // conditions; drop any that hit 0; leave 'until_removed' alone.
      const previousActorId = c.turnOrder[c.currentIdx]?.actorId;
      if (previousActorId) {
        const isPc = previousActorId === ctx.characterId;
        if (isPc) {
          const conds = (s.conditions as ConditionInstance[]) ?? [];
          const ticked = tickConditionsArray(conds);
          if (ticked.changed) {
            await tx
              .update(sessionStateTable)
              .set({ conditions: ticked.next })
              .where(eq(sessionStateTable.sessionId, sessionId));
          }
        } else {
          const [actor] = await tx
            .select()
            .from(combatActorsTable)
            .where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, previousActorId)))
            .limit(1);
          if (actor) {
            const conds = (actor.conditions as ConditionInstance[]) ?? [];
            const ticked = tickConditionsArray(conds);
            if (ticked.changed) {
              await tx
                .update(combatActorsTable)
                .set({ conditions: ticked.next })
                .where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, previousActorId)));
            }
          }
        }
      }
      break;
    }
    case 'set_scene': {
      await tx.update(sessionStateTable).set({ scene: m.scene }).where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'award_xp': {
      // Atomic increment: read current xp, add the delta, write back. The
      // transaction guards against concurrent writes within a single turn.
      const [current] = await tx
        .select({ xp: charactersTable.xp })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!current) break;
      await tx
        .update(charactersTable)
        .set({ xp: current.xp + Math.max(0, Math.floor(m.amount)) })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'level_up': {
      // Read current persisted character so we can compute the new hpMax
      // and merge spell slots without clobbering existing prep state.
      const [current] = await tx
        .select({
          hpMax: charactersTable.hpMax,
          proficiencyBonus: charactersTable.proficiencyBonus,
          spellcasting: charactersTable.spellcasting,
        })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!current) break;

      const newHpMax = Math.max(1, current.hpMax + Math.floor(m.hpDelta || 0));
      // Proficiency bonus by level (PHB): 1-4 = +2, 5-8 = +3, 9-12 = +4,
      // 13-16 = +5, 17-20 = +6.
      const newPB = m.newLevel >= 17 ? 6 : m.newLevel >= 13 ? 5 : m.newLevel >= 9 ? 4 : m.newLevel >= 5 ? 3 : 2;

      let newSpellcasting = current.spellcasting;
      if (m.newSlots && current.spellcasting) {
        const mergedSlots: Record<string, number> = { ...(current.spellcasting.slotsMax ?? {}) };
        for (const [lvl, max] of Object.entries(m.newSlots)) {
          if (typeof max === 'number') mergedSlots[lvl] = max;
        }
        newSpellcasting = { ...current.spellcasting, slotsMax: mergedSlots };
      }

      await tx
        .update(charactersTable)
        .set({
          level: m.newLevel,
          hpMax: newHpMax,
          proficiencyBonus: newPB,
          spellcasting: newSpellcasting,
          updatedAt: new Date(),
        })
        .where(eq(charactersTable.id, m.characterId));

      // Heal the PC by the HP delta (standard convention: leveling up at a
      // long rest grants the new max immediately and the player is at
      // full HP on the new level). We add hpDelta to current HP and clamp
      // at the new hpMax so we don't over-heal a wounded character beyond
      // their new ceiling.
      if (m.hpDelta > 0) {
        const [s] = await tx
          .select({ hpCurrent: sessionStateTable.hpCurrent })
          .from(sessionStateTable)
          .where(eq(sessionStateTable.sessionId, sessionId))
          .limit(1);
        if (s) {
          const healed = Math.min(newHpMax, s.hpCurrent + m.hpDelta);
          await tx.update(sessionStateTable).set({ hpCurrent: healed }).where(eq(sessionStateTable.sessionId, sessionId));
        }
      }
      break;
    }
    case 'add_class_level': {
      // PHB §2.5: append a new class entry, or increment an existing one.
      // The applicator stays permissive (no prereq check — the tool layer
      // validates) so a replayed event log re-applies cleanly. Updates
      // `characters.level` to be the sum of all class levels and aligns
      // `class_slug` with classes[0].slug.
      const [c] = await tx
        .select({
          classes: charactersTable.classes,
          classSlug: charactersTable.classSlug,
          level: charactersTable.level,
        })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;

      // Hydrate the existing breakdown — backfill from classSlug+level when
      // empty so we never lose the starting class.
      let current: ClassLevel[] = Array.isArray(c.classes) && c.classes.length > 0
        ? (c.classes as ClassLevel[]).filter(
            (cl): cl is ClassLevel =>
              !!cl && typeof cl.slug === 'string' && typeof cl.level === 'number',
          )
        : [];
      if (current.length === 0) {
        current = [{ slug: c.classSlug, level: Math.max(1, c.level || 1) }];
      }

      const idx = current.findIndex((cl) => cl.slug === m.classSlug);
      let next: ClassLevel[];
      if (idx >= 0) {
        const existing = current[idx]!;
        const updated: ClassLevel = {
          ...existing,
          level: existing.level + 1,
        };
        if (m.subclass) updated.subclass = m.subclass;
        next = current.map((cl, i) => (i === idx ? updated : cl));
      } else {
        const fresh: ClassLevel = { slug: m.classSlug, level: 1 };
        if (m.subclass) fresh.subclass = m.subclass;
        next = [...current, fresh];
      }

      const newTotalLevel = next.reduce((sum, cl) => sum + Math.max(1, cl.level), 0);
      const newPrimarySlug = next[0]?.slug ?? c.classSlug;

      await tx
        .update(charactersTable)
        .set({
          classes: next,
          classSlug: newPrimarySlug,
          level: newTotalLevel,
          updatedAt: new Date(),
        })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'add_inventory': {
      const [c] = await tx.select({ inventory: charactersTable.inventory }).from(charactersTable).where(eq(charactersTable.id, m.characterId)).limit(1);
      if (!c) break;
      const next = mergeInventoryAdd(c.inventory ?? [], m.itemSlug, m.qty);
      await tx.update(charactersTable).set({ inventory: next, updatedAt: new Date() }).where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'remove_inventory': {
      const [c] = await tx.select({ inventory: charactersTable.inventory }).from(charactersTable).where(eq(charactersTable.id, m.characterId)).limit(1);
      if (!c) break;
      const next = mergeInventoryRemove(c.inventory ?? [], m.itemSlug, m.qty);
      await tx.update(charactersTable).set({ inventory: next, updatedAt: new Date() }).where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'set_equipped': {
      const [c] = await tx.select({ inventory: charactersTable.inventory }).from(charactersTable).where(eq(charactersTable.id, m.characterId)).limit(1);
      if (!c) break;
      const inv = asInvArray(c.inventory);
      const next = inv.map((it) => (it.slug === m.itemSlug ? { ...it, equipped: m.equipped } : it));
      await tx.update(charactersTable).set({ inventory: next, updatedAt: new Date() }).where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'recompute_ac': {
      await tx.update(charactersTable).set({ ac: Math.max(1, Math.floor(m.newAc)), updatedAt: new Date() }).where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'death_save': {
      // PHB §3.18: tracked on the PC's session_state row. Monsters/NPCs
      // don't roll death saves (they die at 0 HP), so treat any non-PC
      // actorId as a no-op.
      if (m.actorId !== ctx.characterId) break;
      const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
      if (!s) break;
      const ds = s.deathSaves ?? { successes: 0, failures: 0 };
      const flags = (s.flags ?? {}) as { stable?: boolean; dead?: boolean };
      if (m.success) {
        const newSuccesses = Math.min(3, ds.successes + 1);
        if (newSuccesses >= 3) {
          // STABLE — reset counters, mark stable, ensure unconscious is present.
          const conds = (s.conditions as ConditionInstance[]).slice();
          if (!conds.some((c) => c.slug === 'unconscious')) {
            conds.push({
              slug: 'unconscious',
              source: 'stable but down',
              durationRounds: 'until_removed',
              appliedRound: 0,
            });
          }
          await tx
            .update(sessionStateTable)
            .set({
              deathSaves: { successes: 0, failures: 0 },
              flags: { ...flags, stable: true },
              conditions: conds,
            })
            .where(eq(sessionStateTable.sessionId, sessionId));
        } else {
          await tx
            .update(sessionStateTable)
            .set({ deathSaves: { successes: newSuccesses, failures: ds.failures } })
            .where(eq(sessionStateTable.sessionId, sessionId));
        }
      } else {
        const inc = m.isCrit ? 2 : 1;
        const newFailures = Math.min(3, ds.failures + inc);
        if (newFailures >= 3) {
          await tx
            .update(sessionStateTable)
            .set({
              deathSaves: { successes: 0, failures: 3 },
              flags: { ...flags, dead: true },
            })
            .where(eq(sessionStateTable.sessionId, sessionId));
        } else {
          await tx
            .update(sessionStateTable)
            .set({ deathSaves: { successes: ds.successes, failures: newFailures } })
            .where(eq(sessionStateTable.sessionId, sessionId));
        }
      }
      break;
    }
    case 'reset_death_saves': {
      // Zero the counters; do NOT touch flags (caller decides when to clear
      // stable/dead — typically on level-up, revivify, or session reset).
      if (m.actorId !== ctx.characterId) break;
      await tx
        .update(sessionStateTable)
        .set({ deathSaves: { successes: 0, failures: 0 } })
        .where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'set_stable': {
      // PHB §3.19: stable PCs no longer roll death saves. Monsters/NPCs are
      // not tracked here, so non-PC actorIds are no-ops.
      if (m.actorId !== ctx.characterId) break;
      const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
      if (!s) break;
      const flags = (s.flags ?? {}) as { stable?: boolean; dead?: boolean };
      await tx
        .update(sessionStateTable)
        .set({ flags: { ...flags, stable: m.stable } })
        .where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'set_concentration': {
      // PHB §8.8: at most one concentration spell per caster. Monsters/NPCs
      // are not tracked in session_state — we only record concentration for
      // the PC, so non-PC actorIds are no-ops. Replacing an existing entry
      // is intentional: a fresh concentration cast supersedes the prior one.
      if (m.actorId !== ctx.characterId) break;
      await tx
        .update(sessionStateTable)
        .set({
          concentratingOn: {
            spellSlug: m.spellSlug,
            slotLevel: m.slotLevel,
            startedRound: m.startedRound,
          },
        })
        .where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'break_concentration': {
      // Null out the column. Setting NULL when already NULL is a harmless
      // no-op at the SQL level, so we don't pre-check.
      if (m.actorId !== ctx.characterId) break;
      await tx
        .update(sessionStateTable)
        .set({ concentratingOn: null })
        .where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'concentration_check': {
      // The applicator does not resolve concentration checks. The
      // concentration_check tool rolls the CON save and emits a
      // `break_concentration` mutation on a failure; this case is a marker
      // for traceability and intentionally has no DB side effect.
      break;
    }
    case 'start_turn': {
      // Reset the actor's per-turn action economy budget to a fresh state
      // (PHB §9: at the start of each turn, the actor regains their action,
      // bonus action, reaction, movement, and free interactions).
      const fresh = newTurnState();
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        await tx
          .update(sessionStateTable)
          .set({ turnState: fresh })
          .where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        await tx
          .update(combatActorsTable)
          .set({ turnState: fresh })
          .where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId)));
      }
      break;
    }
    case 'consume_action': {
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
        if (!s) break;
        const current = (s.turnState as TurnState | null) ?? newTurnState();
        const updated = consumeAction(current, m.kind);
        await tx
          .update(sessionStateTable)
          .set({ turnState: updated })
          .where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        const [a] = await tx.select().from(combatActorsTable).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId))).limit(1);
        if (!a) break;
        const current = (a.turnState as TurnState | null) ?? newTurnState();
        const updated = consumeAction(current, m.kind);
        await tx
          .update(combatActorsTable)
          .set({ turnState: updated })
          .where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId)));
      }
      break;
    }
    case 'consume_movement': {
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
        if (!s) break;
        const current = (s.turnState as TurnState | null) ?? newTurnState();
        const updated = spendMovement(current, m.feet);
        await tx
          .update(sessionStateTable)
          .set({ turnState: updated })
          .where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        const [a] = await tx.select().from(combatActorsTable).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId))).limit(1);
        if (!a) break;
        const current = (a.turnState as TurnState | null) ?? newTurnState();
        const updated = spendMovement(current, m.feet);
        await tx
          .update(combatActorsTable)
          .set({ turnState: updated })
          .where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId)));
      }
      break;
    }
    case 'take_dodge':
    case 'take_disengage':
    case 'take_dash': {
      // Each of these flips a single boolean flag on turnState. We share the
      // load + write pattern; only the field name differs (mapped below).
      const flagMap: Record<typeof m.op, 'dodging' | 'disengaged' | 'dashed'> = {
        take_dodge: 'dodging',
        take_disengage: 'disengaged',
        take_dash: 'dashed',
      };
      const flag = flagMap[m.op];
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
        if (!s) break;
        const current = (s.turnState as TurnState | null) ?? newTurnState();
        const updated: TurnState = { ...current, [flag]: true };
        await tx
          .update(sessionStateTable)
          .set({ turnState: updated })
          .where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        const [a] = await tx.select().from(combatActorsTable).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId))).limit(1);
        if (!a) break;
        const current = (a.turnState as TurnState | null) ?? newTurnState();
        const updated: TurnState = { ...current, [flag]: true };
        await tx
          .update(combatActorsTable)
          .set({ turnState: updated })
          .where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId)));
      }
      break;
    }
    case 'set_readied': {
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
        if (!s) break;
        const current = (s.turnState as TurnState | null) ?? newTurnState();
        const updated: TurnState = { ...current, readied: { trigger: m.trigger, action: m.action } };
        await tx
          .update(sessionStateTable)
          .set({ turnState: updated })
          .where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        const [a] = await tx.select().from(combatActorsTable).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId))).limit(1);
        if (!a) break;
        const current = (a.turnState as TurnState | null) ?? newTurnState();
        const updated: TurnState = { ...current, readied: { trigger: m.trigger, action: m.action } };
        await tx
          .update(combatActorsTable)
          .set({ turnState: updated })
          .where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId)));
      }
      break;
    }
    case 'set_position': {
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        await tx
          .update(sessionStateTable)
          .set({ position: m.position })
          .where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        await tx
          .update(combatActorsTable)
          .set({ position: m.position })
          .where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId)));
      }
      break;
    }
    case 'opportunity_attack_triggered': {
      // No-op: this is a marker in the mutation log for the AI Master to
      // act on (e.g. by emitting a follow-up attack roll). The applicator
      // intentionally does not mutate state for this op.
      break;
    }
    case 'grant_inspiration': {
      // PHB §18.1: idempotent — granting Inspiration when already inspired
      // is a no-op (the boolean is already true). We unconditionally write
      // true to avoid an extra read-roundtrip; the SQL UPDATE is harmless.
      await tx
        .update(charactersTable)
        .set({ inspiration: true, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'spend_inspiration': {
      await tx
        .update(charactersTable)
        .set({ inspiration: false, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'set_long_rest_at': {
      // PHB §5.2: stamp the moment of the most recent successful long rest
      // on session_state so the next long_rest call can enforce the 24h
      // cooldown.
      await tx
        .update(sessionStateTable)
        .set({ lastLongRestAt: new Date(m.epochMs) })
        .where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'attune': {
      // PHB §10.1: append the slug to characters.attuned_items if not already
      // present. The cap (3) is enforced by the tool layer before emitting
      // this mutation; the applicator stays permissive so a re-applied event
      // log replays cleanly even if the cap was relaxed in the meantime.
      const [c] = await tx
        .select({ attunedItems: charactersTable.attunedItems })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = Array.isArray(c.attunedItems) ? c.attunedItems : [];
      if (cur.includes(m.itemSlug)) break;
      await tx
        .update(charactersTable)
        .set({ attunedItems: [...cur, m.itemSlug], updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'unattune': {
      // PHB §10.1: remove the slug from characters.attuned_items. Idempotent
      // — if the slug isn't present, the row is left untouched.
      const [c] = await tx
        .select({ attunedItems: charactersTable.attunedItems })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = Array.isArray(c.attunedItems) ? c.attunedItems : [];
      if (!cur.includes(m.itemSlug)) break;
      const next = cur.filter((s) => s !== m.itemSlug);
      await tx
        .update(charactersTable)
        .set({ attunedItems: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'set_travel_pace':
    case 'set_light_level':
    case 'set_marching_order': {
      // PHB §6.1/§6.4/§6.2 — merge into the session_state.travel jsonb so
      // each field can be updated independently. Read-modify-write keeps
      // unrelated fields intact.
      const [s] = await tx
        .select({ travel: sessionStateTable.travel })
        .from(sessionStateTable)
        .where(eq(sessionStateTable.sessionId, sessionId))
        .limit(1);
      if (!s) break;
      const cur: TravelState = (s.travel ?? {}) as TravelState;
      let next: TravelState;
      if (m.op === 'set_travel_pace') {
        next = { ...cur, pace: m.pace };
      } else if (m.op === 'set_light_level') {
        next = { ...cur, lightLevel: m.lightLevel };
      } else {
        next = { ...cur, marchingOrder: m.order };
      }
      await tx
        .update(sessionStateTable)
        .set({ travel: next })
        .where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'set_senses': {
      // PHB §6.4 — write Senses to the PC row (characters.senses) when the
      // actorId is the session's PC, otherwise the matching combat-actor row.
      const isPc = m.actorId === ctx.characterId;
      const senses: Senses = m.senses;
      if (isPc) {
        await tx
          .update(charactersTable)
          .set({ senses, updatedAt: new Date() })
          .where(eq(charactersTable.id, m.actorId));
      } else {
        await tx
          .update(combatActorsTable)
          .set({ senses })
          .where(
            and(
              eq(combatActorsTable.sessionId, sessionId),
              eq(combatActorsTable.id, m.actorId),
            ),
          );
      }
      break;
    }
    case 'set_tonal_frame': {
      // Master World Lore §5.1 — persist the campaign tonal frame on the
      // session row. The validator at the tool layer guarantees the value
      // is one of the 8 known frames; the applicator stays permissive.
      await tx
        .update(sessionsTable)
        .set({ tonalFrame: m.frame, updatedAt: new Date() })
        .where(eq(sessionsTable.id, sessionId));
      break;
    }
    case 'set_engagement_profile': {
      // Master Handbook §2.1 — persist the detected engagement profile
      // array. Replaces the previous value (the master typically calls
      // this with the FULL up-to-date list). Empty array is legal —
      // it clears the hint.
      await tx
        .update(sessionsTable)
        .set({ engagementProfile: m.profiles, updatedAt: new Date() })
        .where(eq(sessionsTable.id, sessionId));
      break;
    }
    case 'update_npc_beats': {
      // Master Handbook §11.1 — partial update of an NPC codex entry's
      // Three-Beat fields. Build the patch from non-null/undefined values
      // so unspecified fields stay intact (idempotent re-application of
      // the SAME patch is a no-op; later patches MERGE with previous).
      const patch: Record<string, unknown> = {};
      if (m.beats.want != null) patch.want = m.beats.want;
      if (m.beats.fear != null) patch.fear = m.beats.fear;
      if (m.beats.quirk != null) patch.quirk = m.beats.quirk;
      if (m.beats.attitude != null) patch.attitude = m.beats.attitude;
      if (Object.keys(patch).length === 0) break;
      patch.updatedAt = new Date();
      await tx
        .update(codexEntitiesTable)
        .set(patch)
        .where(
          and(
            eq(codexEntitiesTable.sessionId, sessionId),
            eq(codexEntitiesTable.kind, 'npc'),
            eq(codexEntitiesTable.slug, m.npcSlug),
          ),
        );
      break;
    }
    case 'mark_loading_shot':
    case 'mark_offhand_attack': {
      // PHB §9.4 / §3.15 — set a turnState boolean flag on the actor's
      // current turn. Mirror the load+write pattern used by consume_action.
      const flag: 'loadingShotUsed' | 'offHandAttackUsed' =
        m.op === 'mark_loading_shot' ? 'loadingShotUsed' : 'offHandAttackUsed';
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        const [s] = await tx
          .select()
          .from(sessionStateTable)
          .where(eq(sessionStateTable.sessionId, sessionId))
          .limit(1);
        if (!s) break;
        const current = (s.turnState as TurnState | null) ?? newTurnState();
        const updated: TurnState = { ...current, [flag]: true };
        await tx
          .update(sessionStateTable)
          .set({ turnState: updated })
          .where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        const [a] = await tx
          .select()
          .from(combatActorsTable)
          .where(
            and(
              eq(combatActorsTable.sessionId, sessionId),
              eq(combatActorsTable.id, m.actorId),
            ),
          )
          .limit(1);
        if (!a) break;
        const current = (a.turnState as TurnState | null) ?? newTurnState();
        const updated: TurnState = { ...current, [flag]: true };
        await tx
          .update(combatActorsTable)
          .set({ turnState: updated })
          .where(
            and(
              eq(combatActorsTable.sessionId, sessionId),
              eq(combatActorsTable.id, m.actorId),
            ),
          );
      }
      break;
    }
    case 'set_focus': {
      // PHB §8.4: persist the held focus on the PC. Overwrites any
      // existing focus — the tool layer is responsible for declaring
      // a single coherent state per cast.
      await tx
        .update(charactersTable)
        .set({ equippedFocus: m.focus, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'unset_focus': {
      // PHB §8.4: clear the focus. Idempotent — writing NULL when
      // already NULL is a harmless no-op at the SQL level.
      await tx
        .update(charactersTable)
        .set({ equippedFocus: null, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'consume_ammo': {
      // PHB §9.4 — decrement inventory[ammoSlug].qty by qty. PC-only:
      // monsters/NPCs don't track inventory in the engine state.
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({ inventory: charactersTable.inventory })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const next = mergeInventoryRemove(c.inventory ?? [], m.ammoSlug, m.qty);
      await tx
        .update(charactersTable)
        .set({ inventory: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
  }
}

type InvRow = { slug: string; qty: number; equipped: boolean };

// Coerce whatever the jsonb column returned into the expected array shape.
// Drizzle types it as InventoryItem[] but historic rows or partial wizard
// states could write an object/null/undefined — without this guard the
// callers' .map/.find would throw inside the transaction and crash the turn.
function asInvArray(raw: unknown): InvRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (it): it is InvRow =>
      !!it && typeof it === 'object' && typeof (it as InvRow).slug === 'string' && typeof (it as InvRow).qty === 'number',
  );
}

function mergeInventoryAdd(inv: unknown, slug: string, qty: number): InvRow[] {
  const safe = asInvArray(inv);
  const safeQty = Math.max(1, Math.floor(qty));
  const existing = safe.find((it) => it.slug === slug);
  if (existing) {
    return safe.map((it) => (it.slug === slug ? { ...it, qty: it.qty + safeQty } : it));
  }
  return [...safe, { slug, qty: safeQty, equipped: false }];
}

function mergeInventoryRemove(inv: unknown, slug: string, qty: number): InvRow[] {
  const safe = asInvArray(inv);
  const safeQty = Math.max(1, Math.floor(qty));
  return safe
    .map((it) => (it.slug === slug ? { ...it, qty: it.qty - safeQty } : it))
    .filter((it) => it.qty > 0);
}

/**
 * Pure helper that decrements `durationRounds` on each round-counted
 * condition and drops those that reach 0. Conditions with
 * `durationRounds === 'until_removed'` are passed through untouched.
 *
 * Mirrors the logic of `tickConditions` in `engine/combat/turn.ts` but
 * works on a raw array (no ActorRuntimeState needed) so the applicator
 * can call it inside its existing transactional read-update cycle on
 * either `session_state.conditions` or `combat_actors.conditions`.
 *
 * Returns `changed=false` when nothing needed to update — caller skips
 * the DB write to avoid a no-op transaction step.
 */
function tickConditionsArray(
  conds: ConditionInstance[],
): { next: ConditionInstance[]; changed: boolean } {
  let changed = false;
  const next: ConditionInstance[] = [];
  for (const c of conds) {
    if (c.durationRounds === 'until_removed') {
      next.push(c);
      continue;
    }
    const newDuration = c.durationRounds - 1;
    if (newDuration <= 0) {
      changed = true;
      continue; // drop expired
    }
    if (newDuration !== c.durationRounds) changed = true;
    next.push({ ...c, durationRounds: newDuration });
  }
  return { next, changed };
}
