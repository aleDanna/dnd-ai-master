import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessionState as sessionStateTable,
  combatActors as combatActorsTable,
  diceLog as diceLogTable,
  sessions as sessionsTable,
  characters as charactersTable,
  type DiceLogInsert,
} from '@/db/schema';
import type { ConditionInstance, DiceRoll, Mutation } from '@/engine/types';

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
        const cur = await getPcHp(tx, sessionId);
        const next = m.op === 'set_hp' ? m.hpCurrent
                   : m.op === 'apply_damage' ? Math.max(0, cur - m.amount)
                   : Math.min(ctx.hpMax, cur + m.amount);
        await tx.update(sessionStateTable).set({ hpCurrent: next }).where(eq(sessionStateTable.sessionId, sessionId));
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
      if (isPc) {
        const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
        if (!s) return;
        const conds = (s.conditions as ConditionInstance[]).filter((c) => c.slug !== (m.op === 'add_condition' ? m.condition.slug : m.conditionSlug));
        if (m.op === 'add_condition') conds.push(m.condition);
        await tx.update(sessionStateTable).set({ conditions: conds }).where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        // FIX I1: scope by session_id too
        const [a] = await tx.select().from(combatActorsTable).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId))).limit(1);
        if (!a) return;
        const conds = (a.conditions as ConditionInstance[]).filter((c) => c.slug !== (m.op === 'add_condition' ? m.condition.slug : m.conditionSlug));
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

async function getPcHp(tx: Tx, sessionId: string): Promise<number> {
  const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
  return s?.hpCurrent ?? 0;
}
