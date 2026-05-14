import { eq, and, gt } from 'drizzle-orm';
import { db } from '@/db/client';
import { notifySession } from '@/sessions/notify';
import {
  sessionState as sessionStateTable,
  combatActors as combatActorsTable,
  diceLog as diceLogTable,
  sessions as sessionsTable,
  campaigns as campaignsTable,
  characters as charactersTable,
  codexEntities as codexEntitiesTable,
  inventoryGrants as inventoryGrantsTable,
  type DiceLogInsert,
} from '@/db/schema';
import type {
  Bastion,
  BastionRoom,
  ClassLevel,
  ConditionInstance,
  CraftingProject,
  DiceRoll,
  DowntimeActivity,
  DowntimeActivityKind,
  Hireling,
  MountedState,
  MountMode,
  Mutation,
  TurnState,
  TravelState,
  Senses,
} from '@/engine/types';
import { isValidMountMode } from '@/engine/mounts';
import { isValidVehicleSlug } from '@/engine/vehicles';
import { newTurnState, consumeAction, spendMovement } from '@/engine/combat/turn-state';
import { isCurrencySlug, payCurrency } from './currency';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const VALID_KINDS = new Set(['attack', 'damage', 'save', 'check', 'init', 'generic']);

interface SessionContext {
  characterId: string;
  hpMax: number;
  campaignId: string | null;
}

async function loadContext(tx: Tx, sessionId: string): Promise<SessionContext | null> {
  const [s] = await tx
    .select({
      characterId: sessionsTable.characterId,
      currentPlayerCharacterId: sessionsTable.currentPlayerCharacterId,
      campaignId: sessionsTable.campaignId,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId))
    .limit(1);
  if (!s) return null;
  // Multiplayer: mutations land on the currently acting PG, not the host.
  // Falls back to the legacy `characterId` for solo and unmigrated rows.
  const activeId = s.currentPlayerCharacterId ?? s.characterId;
  const [c] = await tx.select({ hpMax: charactersTable.hpMax }).from(charactersTable).where(eq(charactersTable.id, activeId)).limit(1);
  if (!c) return null;
  return { characterId: activeId, hpMax: c.hpMax, campaignId: s.campaignId };
}

/**
 * Defensive de-dup of `add_inventory` mutations within a single batch.
 *
 * The AI master sometimes emits two `add_item` tool calls for the same loot
 * inside the same turn (re-narrating "you pick up X", calling the tool twice
 * via successive tool-uses, or re-emitting after a tool error). Same-turn
 * de-dup keeps only the FIRST `add_inventory` for each (characterId, itemSlug)
 * pair within a single applyMutations() call.
 *
 * Cross-turn duplication (the master re-narrating the same loot one or two
 * turns later) is handled separately inside the `add_inventory` case using
 * the `inventory_grants` log — that path keys on (sessionId, characterId,
 * itemSlug, qty) inside a recent time window so legitimate later pickups
 * with a different quantity still apply.
 *
 * Note: `qty` is NOT summed across same-turn duplicate calls. If the master
 * meant to grant the loot twice, it should pass `qty: 2` in a single call.
 * The conservative choice prevents accidental duplication; deliberate
 * stacking still works.
 */
function dedupeAddInventory(mutations: Mutation[]): Mutation[] {
  const seen = new Set<string>();
  const out: Mutation[] = [];
  for (const m of mutations) {
    if (m.op === 'add_inventory') {
      const key = `${m.characterId}::${m.itemSlug}`;
      if (seen.has(key)) continue;  // skip duplicate; first call wins
      seen.add(key);
    }
    out.push(m);
  }
  return out;
}

/**
 * How recently is "too recent" for an identical (character, itemSlug, qty)
 * add_inventory mutation to be considered a duplicate of the previous one.
 * 10 minutes is long enough to cover several player+master turns even with
 * thinking pauses, but short enough that "you find a second healing potion
 * twenty minutes later" still applies.
 */
const CROSS_TURN_DEDUP_WINDOW_MS = 10 * 60 * 1000;

export async function applyMutations(sessionId: string, mutations: Mutation[], rolls: DiceRoll[]): Promise<void> {
  const deduped = dedupeAddInventory(mutations);
  await db.transaction(async (tx) => {
    const ctx = await loadContext(tx, sessionId);
    if (!ctx) return;
    for (const m of deduped) {
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
  // Notify SSE subscribers after the transaction commits so they can refetch
  // the latest state. Errors are swallowed so a broken notify channel never
  // crashes the applicator.
  if (deduped.length > 0) {
    notifySession(sessionId, { type: 'state' }).catch((e) =>
      console.warn('notifySession(state) failed:', e instanceof Error ? e.message : String(e)),
    );
  }
  if (rolls.length > 0) {
    // Batch insert — no per-row IDs returned. Emit a single dice notification;
    // clients refetch the dice log on receipt. logId is left empty as a
    // sentinel meaning "some dice were logged this turn".
    notifySession(sessionId, { type: 'dice', logId: '' }).catch((e) =>
      console.warn('notifySession(dice) failed:', e instanceof Error ? e.message : String(e)),
    );
  }
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
      // Per-character storage (multiplayer-correct): each PG owns their
      // own `spell_slots_used` column on `characters`. Pre-migration the
      // applicator wrote to a single session_state row that only the active
      // PG could read, which is why non-active party members' slots never
      // refreshed after long_rest.
      const [c] = await tx.select().from(charactersTable).where(eq(charactersTable.id, m.actorId)).limit(1);
      if (!c) return;
      const used = { ...((c.spellSlotsUsed ?? {}) as Record<string, number>) };
      used[String(m.level)] = (used[String(m.level)] ?? 0) + 1;
      await tx.update(charactersTable).set({ spellSlotsUsed: used }).where(eq(charactersTable.id, m.actorId));
      break;
    }
    case 'restore_spell_slot': {
      const [c] = await tx.select().from(charactersTable).where(eq(charactersTable.id, m.actorId)).limit(1);
      if (!c) return;
      const used = { ...((c.spellSlotsUsed ?? {}) as Record<string, number>) };
      const cur = used[String(m.level)] ?? 0;
      const next = Math.max(0, cur - Math.max(0, Math.floor(m.amount)));
      if (next === 0) delete used[String(m.level)];
      else used[String(m.level)] = next;
      await tx.update(charactersTable).set({ spellSlotsUsed: used }).where(eq(charactersTable.id, m.actorId));
      break;
    }
    case 'use_resource':
    case 'restore_resource': {
      const [c] = await tx.select().from(charactersTable).where(eq(charactersTable.id, m.actorId)).limit(1);
      if (!c) return;
      const used = { ...((c.resourcesUsed ?? {}) as Record<string, number>) };
      const cur = used[m.featureSlug] ?? 0;
      used[m.featureSlug] = m.op === 'use_resource' ? cur + m.amount : Math.max(0, cur - m.amount);
      await tx.update(charactersTable).set({ resourcesUsed: used }).where(eq(charactersTable.id, m.actorId));
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
      // Cross-turn dedup. The master sometimes re-narrates the same loot in a
      // following turn and re-emits add_inventory; without this guard the
      // player's inventory doubles. We look up the `inventory_grants` log for
      // the same (sessionId, characterId, itemSlug, qty) tuple inside a recent
      // time window — if it's there, treat as a duplicate and skip.
      const threshold = new Date(Date.now() - CROSS_TURN_DEDUP_WINDOW_MS);
      const [recentGrant] = await tx
        .select({ id: inventoryGrantsTable.id })
        .from(inventoryGrantsTable)
        .where(
          and(
            eq(inventoryGrantsTable.sessionId, sessionId),
            eq(inventoryGrantsTable.characterId, m.characterId),
            eq(inventoryGrantsTable.itemSlug, m.itemSlug),
            eq(inventoryGrantsTable.qty, m.qty),
            gt(inventoryGrantsTable.createdAt, threshold),
          ),
        )
        .limit(1);
      if (recentGrant) {
        // Suppress, but log so we can spot if the heuristic ever fires on a
        // legitimate "player picks up the same thing twice in quick succession".
        console.warn('applicator.add_inventory.cross_turn_suppressed', {
          sessionId,
          characterId: m.characterId,
          itemSlug: m.itemSlug,
          qty: m.qty,
        });
        break;
      }
      const [c] = await tx.select({ inventory: charactersTable.inventory }).from(charactersTable).where(eq(charactersTable.id, m.characterId)).limit(1);
      if (!c) break;
      const next = mergeInventoryAdd(c.inventory ?? [], m.itemSlug, m.qty);
      await tx.update(charactersTable).set({ inventory: next, updatedAt: new Date() }).where(eq(charactersTable.id, m.characterId));
      // Record the grant after the inventory write succeeded. The same
      // transaction means a rollback would undo the log row too.
      await tx.insert(inventoryGrantsTable).values({
        sessionId,
        characterId: m.characterId,
        itemSlug: m.itemSlug,
        qty: m.qty,
      });
      break;
    }
    case 'remove_inventory': {
      const [c] = await tx.select({ inventory: charactersTable.inventory }).from(charactersTable).where(eq(charactersTable.id, m.characterId)).limit(1);
      if (!c) break;
      const inv = asInvArray(c.inventory);
      // Currency payments need cross-denomination accounting. Paying 3 gp out
      // of a pile that holds only sp/cp is a "make change" operation, not a
      // no-op. payCurrency() either subtracts directly (denominations
      // preserved) or redistributes the entire coin pile in cp value.
      let next: InvRow[];
      if (isCurrencySlug(m.itemSlug)) {
        const result = payCurrency(inv, m.itemSlug, m.qty);
        if (!result.ok) {
          // Insufficient total wealth across all denominations. Don't silently
          // drain what little the player has — log it and skip; the master
          // sees the unchanged inventory snapshot next turn and can react.
          console.warn('applicator.remove_inventory.insufficient_currency', {
            characterId: m.characterId,
            slug: m.itemSlug,
            qty: m.qty,
            needCp: result.needCp,
            haveCp: result.haveCp,
          });
          break;
        }
        next = result.next;
      } else {
        next = mergeInventoryRemove(inv, m.itemSlug, m.qty);
      }
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
      // campaign row (campaign-scoped, not session-scoped). The validator
      // at the tool layer guarantees the value is one of the 8 known frames;
      // the applicator stays permissive. No-op if session has no campaign yet
      // (legacy sessions without a campaignId).
      if (ctx.campaignId) {
        await tx
          .update(campaignsTable)
          .set({ tonalFrame: m.frame, updatedAt: new Date() })
          .where(eq(campaignsTable.id, ctx.campaignId));
      }
      break;
    }
    case 'set_engagement_profile': {
      // Master Handbook §2.1 — persist the detected engagement profile
      // array on the campaign row. Replaces the previous value (the master
      // typically calls this with the FULL up-to-date list). Empty array
      // is legal — it clears the hint. No-op if session has no campaign yet
      // (legacy sessions without a campaignId).
      if (ctx.campaignId) {
        await tx
          .update(campaignsTable)
          .set({ engagementProfile: m.profiles, updatedAt: new Date() })
          .where(eq(campaignsTable.id, ctx.campaignId));
      }
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
    case 'use_class_feature':
    case 'restore_class_feature':
    case 'modify_lay_on_hands_pool': {
      // Phase 11 — class-feature resource bookkeeping. Mirrors the
      // use_resource / restore_resource handler but exposed under a
      // dedicated mutation op so the AI Master's tool calls stay
      // semantically distinct (a "rage start" is more readable than a
      // generic "use_resource:rage" log entry). PC-only: monsters/NPCs
      // don't track per-feature resources.
      //
      // Per-character storage (multiplayer-correct): writes land on the
      // addressed PG's `characters.resources_used` column instead of the
      // shared session_state row, so non-active party members keep their
      // own class-feature ledgers and a long_rest can restore each one
      // independently.
      const [c] = await tx
        .select()
        .from(charactersTable)
        .where(eq(charactersTable.id, m.actorId))
        .limit(1);
      if (!c) break;
      const used = { ...((c.resourcesUsed ?? {}) as Record<string, number>) };
      if (m.op === 'use_class_feature') {
        const inc = Math.max(1, Math.floor(m.uses ?? 1));
        used[m.featureSlug] = (used[m.featureSlug] ?? 0) + inc;
      } else if (m.op === 'restore_class_feature') {
        const dec = Math.max(1, Math.floor(m.uses ?? 1));
        const cur = used[m.featureSlug] ?? 0;
        const next = Math.max(0, cur - dec);
        if (next === 0) delete used[m.featureSlug];
        else used[m.featureSlug] = next;
      } else {
        // modify_lay_on_hands_pool — delta is added to the spent counter.
        // Negative delta restores the pool (used by long_rest); positive
        // delta consumes it (used by use_lay_on_hands).
        const delta = Math.floor(m.delta);
        const cur = used['lay_on_hands'] ?? 0;
        const next = Math.max(0, cur + delta);
        if (next === 0) delete used['lay_on_hands'];
        else used['lay_on_hands'] = next;
      }
      await tx
        .update(charactersTable)
        .set({ resourcesUsed: used })
        .where(eq(charactersTable.id, m.actorId));
      break;
    }
    case 'mark_sneak_attack': {
      // Phase 11 — once-per-turn Sneak Attack marker on the actor's
      // current turnState. Mirrors mark_loading_shot.
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        const [s] = await tx
          .select()
          .from(sessionStateTable)
          .where(eq(sessionStateTable.sessionId, sessionId))
          .limit(1);
        if (!s) break;
        const current = (s.turnState as TurnState | null) ?? newTurnState();
        const updated: TurnState = { ...current, sneakAttackUsed: true };
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
        const updated: TurnState = { ...current, sneakAttackUsed: true };
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
    case 'reset_action_for_surge': {
      // Phase 11 — Fighter Action Surge: clears turnState.actionUsed so
      // the fighter can take another action this turn. The bonus action
      // and reaction budgets are NOT touched (Action Surge gives one
      // additional ACTION). Mirror the load+write pattern of consume_action.
      const isPc = m.actorId === ctx.characterId;
      if (isPc) {
        const [s] = await tx
          .select()
          .from(sessionStateTable)
          .where(eq(sessionStateTable.sessionId, sessionId))
          .limit(1);
        if (!s) break;
        const current = (s.turnState as TurnState | null) ?? newTurnState();
        const updated: TurnState = { ...current, actionUsed: false };
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
        const updated: TurnState = { ...current, actionUsed: false };
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
    case 'start_crafting': {
      // Phase 12 (PHB §5 + DMG): append the project to
      // characters.crafting_projects. Idempotent on id collision (a
      // duplicate id is silently ignored — the master is responsible
      // for generating fresh ids per project).
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({ projects: charactersTable.craftingProjects })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = asProjectsArray(c.projects);
      if (cur.some((p) => p.id === m.project.id)) break; // idempotent
      const next: CraftingProject[] = [...cur, sanitizeProject(m.project)];
      await tx
        .update(charactersTable)
        .set({ craftingProjects: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'progress_crafting': {
      // Phase 12: decrement daysRemaining by daysSpent (clamp at 0),
      // optionally add gpDelta to gpSpent. Silent no-op when the
      // project id isn't present (re-applying a stale event log
      // shouldn't crash; the tool layer reports the error).
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({ projects: charactersTable.craftingProjects })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = asProjectsArray(c.projects);
      const idx = cur.findIndex((p) => p.id === m.projectId);
      if (idx < 0) break;
      const project = cur[idx]!;
      const daysSpent = Math.max(0, Math.floor(m.daysSpent));
      const gpDelta = Math.max(0, Math.floor(m.gpDelta ?? 0));
      const updated: CraftingProject = {
        ...project,
        daysRemaining: Math.max(0, project.daysRemaining - daysSpent),
        gpSpent: project.gpSpent + gpDelta,
      };
      const next = cur.map((p, i) => (i === idx ? updated : p));
      await tx
        .update(charactersTable)
        .set({ craftingProjects: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'complete_crafting': {
      // Phase 12: validate project exists + daysRemaining === 0,
      // remove from craftingProjects, and ALSO update the inventory
      // (qty +1 for the recipe slug) — chaining the add_inventory
      // side-effect inside the same transaction so the project's
      // disappearance can never be observed without the resulting item.
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({
          projects: charactersTable.craftingProjects,
          inventory: charactersTable.inventory,
        })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = asProjectsArray(c.projects);
      const idx = cur.findIndex((p) => p.id === m.projectId);
      if (idx < 0) break;
      const project = cur[idx]!;
      // The applicator stays permissive: if the master skipped the
      // tool-level validation and emitted complete_crafting too early,
      // we still drop the project (to keep the event log replayable)
      // but DO NOT add the item — the master is responsible for the
      // narrative reset.
      const ready = project.daysRemaining <= 0;
      const remainingProjects = cur.filter((_, i) => i !== idx);
      const nextInventory = ready
        ? mergeInventoryAdd(c.inventory ?? [], project.recipeSlug, 1)
        : c.inventory ?? [];
      await tx
        .update(charactersTable)
        .set({
          craftingProjects: remainingProjects,
          inventory: nextInventory,
          updatedAt: new Date(),
        })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'cancel_crafting': {
      // Phase 12: remove the project from craftingProjects with no
      // refund and no inventory side-effect. Silent no-op when the id
      // is not present.
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({ projects: charactersTable.craftingProjects })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = asProjectsArray(c.projects);
      const next = cur.filter((p) => p.id !== m.projectId);
      if (next.length === cur.length) break; // nothing changed
      await tx
        .update(charactersTable)
        .set({ craftingProjects: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'start_downtime_activity': {
      // Phase 13 (PHB §6): append to characters.downtime_activities.
      // Idempotent on duplicate id (silent no-op so re-applied event
      // logs don't grow the array).
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({ activities: charactersTable.downtimeActivities })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = asDowntimeActivitiesArray(c.activities);
      if (cur.some((a) => a.id === m.activity.id)) break;
      const next: DowntimeActivity[] = [
        ...cur,
        sanitizeDowntimeActivity(m.activity),
      ];
      await tx
        .update(charactersTable)
        .set({ downtimeActivities: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'complete_downtime_activity': {
      // Phase 13: remove the activity from downtime_activities. The
      // master narrates the outcome separately. Silent no-op on
      // missing id (replayable event log).
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({ activities: charactersTable.downtimeActivities })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = asDowntimeActivitiesArray(c.activities);
      const next = cur.filter((a) => a.id !== m.activityId);
      if (next.length === cur.length) break;
      await tx
        .update(charactersTable)
        .set({ downtimeActivities: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'hire': {
      // Phase 13 (PHB §6): append a hireling engagement to
      // characters.hirelings. Idempotent on duplicate id.
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({ hirelings: charactersTable.hirelings })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = asHirelingsArray(c.hirelings);
      if (cur.some((h) => h.id === m.hireling.id)) break;
      const next: Hireling[] = [...cur, sanitizeHireling(m.hireling)];
      await tx
        .update(charactersTable)
        .set({ hirelings: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'dismiss_hireling': {
      // Phase 13: drop a hireling engagement from characters.hirelings.
      // Silent no-op when the id is not present.
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({ hirelings: charactersTable.hirelings })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = asHirelingsArray(c.hirelings);
      const next = cur.filter((h) => h.id !== m.hireId);
      if (next.length === cur.length) break;
      await tx
        .update(charactersTable)
        .set({ hirelings: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'set_bastion': {
      // Phase 13 (2024 PHB simplified): overwrite the PC's bastion
      // record. Pass null to clear; pass a Bastion to establish/replace.
      if (m.characterId !== ctx.characterId) break;
      const next: Bastion | null = m.bastion ? sanitizeBastion(m.bastion) : null;
      await tx
        .update(charactersTable)
        .set({ bastion: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'add_bastion_room': {
      // Phase 13: append a room to bastion.rooms. Silent no-op when
      // the PC has no bastion (master must call set_bastion first).
      if (m.characterId !== ctx.characterId) break;
      const [c] = await tx
        .select({ bastion: charactersTable.bastion })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const current = asBastion(c.bastion);
      if (!current) break;
      const room = sanitizeBastionRoom(m.room);
      if (!room) break;
      const next: Bastion = { ...current, rooms: [...current.rooms, room] };
      await tx
        .update(charactersTable)
        .set({ bastion: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'mount': {
      // Phase 14 (PHB §3.23): set characters.mounted_on to
      // { mountId, mode }. Default mode is 'controlled' when omitted
      // (the engine echoes the PHB default). Silent no-op when the
      // characterId doesn't match the PC.
      if (m.characterId !== ctx.characterId) break;
      const mode: MountMode = isValidMountMode(m.mode) ? m.mode : 'controlled';
      const next: MountedState = { mountId: m.mountId, mode };
      await tx
        .update(charactersTable)
        .set({ mountedOn: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'dismount': {
      // Phase 14: clear characters.mounted_on. Idempotent — the column
      // is set to NULL even if the PC was already dismounted.
      if (m.characterId !== ctx.characterId) break;
      await tx
        .update(charactersTable)
        .set({ mountedOn: null, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'set_mount_mode': {
      // Phase 14: update the mode on the existing mount state. Silent
      // no-op when the PC is not currently mounted (the master is
      // expected to call mount() first).
      if (m.characterId !== ctx.characterId) break;
      if (!isValidMountMode(m.mode)) break;
      const [c] = await tx
        .select({ mountedOn: charactersTable.mountedOn })
        .from(charactersTable)
        .where(eq(charactersTable.id, m.characterId))
        .limit(1);
      if (!c) break;
      const cur = hydrateMountedOnRaw(c.mountedOn);
      if (!cur) break;
      const next: MountedState = { mountId: cur.mountId, mode: m.mode };
      await tx
        .update(charactersTable)
        .set({ mountedOn: next, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'embark_vehicle': {
      // Phase 14 (PHB §9.6): overwrite characters.embarked_on with the
      // catalogued vehicle slug. Silent no-op when the slug is unknown
      // (the tool layer is the gate; the applicator stays defensive).
      if (m.characterId !== ctx.characterId) break;
      if (!isValidVehicleSlug(m.vehicleSlug)) break;
      await tx
        .update(charactersTable)
        .set({ embarkedOn: m.vehicleSlug, updatedAt: new Date() })
        .where(eq(charactersTable.id, m.characterId));
      break;
    }
    case 'disembark_vehicle': {
      // Phase 14: clear characters.embarked_on. Idempotent.
      if (m.characterId !== ctx.characterId) break;
      await tx
        .update(charactersTable)
        .set({ embarkedOn: null, updatedAt: new Date() })
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
 * Coerce whatever the jsonb crafting_projects column returned into a clean
 * `CraftingProject[]`. Drops malformed entries defensively so a corrupt
 * row can't bring down the applicator (mirrors the snapshot hydrator).
 */
function asProjectsArray(raw: unknown): CraftingProject[] {
  if (!Array.isArray(raw)) return [];
  const out: CraftingProject[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<CraftingProject>;
    if (typeof r.id !== 'string' || !r.id) continue;
    if (typeof r.recipeSlug !== 'string' || !r.recipeSlug) continue;
    if (typeof r.kind !== 'string') continue;
    if (typeof r.daysRemaining !== 'number') continue;
    if (typeof r.gpSpent !== 'number') continue;
    out.push({
      id: r.id,
      recipeSlug: r.recipeSlug,
      kind: r.kind,
      daysRemaining: Math.max(0, Math.floor(r.daysRemaining)),
      gpSpent: Math.max(0, Math.floor(r.gpSpent)),
      ...(typeof r.startedRound === 'number'
        ? { startedRound: Math.floor(r.startedRound) }
        : {}),
    });
  }
  return out;
}

/** Normalise a project payload coming in via a `start_crafting` mutation
 *  so days/gp are non-negative integers and stray fields are dropped. */
function sanitizeProject(p: CraftingProject): CraftingProject {
  const out: CraftingProject = {
    id: p.id,
    recipeSlug: p.recipeSlug,
    kind: p.kind,
    daysRemaining: Math.max(0, Math.floor(p.daysRemaining)),
    gpSpent: Math.max(0, Math.floor(p.gpSpent)),
  };
  if (typeof p.startedRound === 'number') {
    out.startedRound = Math.floor(p.startedRound);
  }
  return out;
}

// ─── Phase 13: downtime / hireling / bastion sanitisers ───────────────────

const VALID_DOWNTIME_KINDS: ReadonlySet<DowntimeActivityKind> = new Set([
  'practicing_profession',
  'recuperating',
  'researching',
  'training',
  'crafting',
]);

/** Coerce the jsonb downtime_activities column into a clean array. */
function asDowntimeActivitiesArray(raw: unknown): DowntimeActivity[] {
  if (!Array.isArray(raw)) return [];
  const out: DowntimeActivity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<DowntimeActivity>;
    if (typeof r.id !== 'string' || !r.id) continue;
    if (typeof r.kind !== 'string' || !VALID_DOWNTIME_KINDS.has(r.kind as DowntimeActivityKind)) {
      continue;
    }
    if (typeof r.daysRemaining !== 'number' || !Number.isFinite(r.daysRemaining)) continue;
    const gp =
      typeof r.gpSpent === 'number' && Number.isFinite(r.gpSpent)
        ? Math.max(0, Math.floor(r.gpSpent))
        : 0;
    const entry: DowntimeActivity = {
      id: r.id,
      kind: r.kind as DowntimeActivityKind,
      daysRemaining: Math.max(0, Math.floor(r.daysRemaining)),
      gpSpent: gp,
    };
    if (typeof r.startedAt === 'number' && Number.isFinite(r.startedAt)) {
      entry.startedAt = Math.floor(r.startedAt);
    }
    out.push(entry);
  }
  return out;
}

function sanitizeDowntimeActivity(a: DowntimeActivity): DowntimeActivity {
  const out: DowntimeActivity = {
    id: a.id,
    kind: a.kind,
    daysRemaining: Math.max(0, Math.floor(a.daysRemaining)),
    gpSpent: Math.max(0, Math.floor(a.gpSpent)),
  };
  if (typeof a.startedAt === 'number' && Number.isFinite(a.startedAt)) {
    out.startedAt = Math.floor(a.startedAt);
  }
  return out;
}

const VALID_HIRELING_KINDS: ReadonlySet<Hireling['kind']> = new Set(['skilled', 'unskilled']);

function asHirelingsArray(raw: unknown): Hireling[] {
  if (!Array.isArray(raw)) return [];
  const out: Hireling[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<Hireling>;
    if (typeof r.id !== 'string' || !r.id) continue;
    if (typeof r.kind !== 'string' || !VALID_HIRELING_KINDS.has(r.kind as Hireling['kind'])) {
      continue;
    }
    if (typeof r.count !== 'number' || !Number.isFinite(r.count) || r.count < 0) continue;
    if (typeof r.days !== 'number' || !Number.isFinite(r.days) || r.days < 0) continue;
    const gpCost =
      typeof r.gpCost === 'number' && Number.isFinite(r.gpCost) ? Math.max(0, Math.floor(r.gpCost)) : 0;
    const spCost =
      typeof r.spCost === 'number' && Number.isFinite(r.spCost) ? Math.max(0, Math.floor(r.spCost)) : 0;
    const entry: Hireling = {
      id: r.id,
      kind: r.kind as Hireling['kind'],
      count: Math.max(0, Math.floor(r.count)),
      days: Math.max(0, Math.floor(r.days)),
      gpCost,
      spCost,
    };
    if (typeof r.startedAt === 'number' && Number.isFinite(r.startedAt)) {
      entry.startedAt = Math.floor(r.startedAt);
    }
    out.push(entry);
  }
  return out;
}

function sanitizeHireling(h: Hireling): Hireling {
  const out: Hireling = {
    id: h.id,
    kind: h.kind,
    count: Math.max(0, Math.floor(h.count)),
    days: Math.max(0, Math.floor(h.days)),
    gpCost: Math.max(0, Math.floor(h.gpCost)),
    spCost: Math.max(0, Math.floor(h.spCost)),
  };
  if (typeof h.startedAt === 'number' && Number.isFinite(h.startedAt)) {
    out.startedAt = Math.floor(h.startedAt);
  }
  return out;
}

const VALID_BASTION_FORTIFICATIONS: ReadonlySet<Bastion['fortification']> = new Set([
  'modest',
  'fortified',
  'castle',
]);

const VALID_BASTION_ROOM_KINDS: ReadonlySet<BastionRoom['kind']> = new Set([
  'workshop',
  'library',
  'armory',
  'stable',
  'garden',
  'storage',
  'training',
  'shrine',
  'kitchen',
  'guesthouse',
]);

function asBastion(raw: unknown): Bastion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Bastion>;
  if (typeof r.name !== 'string') return null;
  if (typeof r.fortification !== 'string' || !VALID_BASTION_FORTIFICATIONS.has(r.fortification as Bastion['fortification'])) {
    return null;
  }
  if (typeof r.defenders !== 'number' || !Number.isFinite(r.defenders)) return null;
  const rooms: BastionRoom[] = [];
  if (Array.isArray(r.rooms)) {
    for (const room of r.rooms) {
      const clean = sanitizeBastionRoom(room as BastionRoom);
      if (clean) rooms.push(clean);
    }
  }
  return {
    name: r.name,
    fortification: r.fortification as Bastion['fortification'],
    rooms,
    defenders: Math.max(0, Math.floor(r.defenders)),
  };
}

function sanitizeBastion(b: Bastion): Bastion {
  return {
    name: b.name,
    fortification: b.fortification,
    rooms: (b.rooms ?? [])
      .map(sanitizeBastionRoom)
      .filter((r): r is BastionRoom => r != null),
    defenders: Math.max(0, Math.floor(b.defenders)),
  };
}

function sanitizeBastionRoom(r: BastionRoom | undefined | null): BastionRoom | null {
  if (!r || typeof r !== 'object') return null;
  const room = r as Partial<BastionRoom>;
  if (typeof room.kind !== 'string' || !VALID_BASTION_ROOM_KINDS.has(room.kind as BastionRoom['kind'])) {
    return null;
  }
  if (typeof room.level !== 'number' || ![1, 2, 3].includes(Math.floor(room.level))) {
    return null;
  }
  return {
    kind: room.kind as BastionRoom['kind'],
    level: Math.floor(room.level) as BastionRoom['level'],
  };
}

// ─── Phase 14: mounted-state defensive hydrator ────────────────────────────

function hydrateMountedOnRaw(raw: unknown): MountedState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<MountedState>;
  if (typeof r.mountId !== 'string' || !r.mountId) return null;
  if (!isValidMountMode(r.mode)) return null;
  return { mountId: r.mountId, mode: r.mode };
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
