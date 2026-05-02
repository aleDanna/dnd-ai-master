import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  sessionState as sessionStateTable,
  combatActors as combatActorsTable,
  diceLog as diceLogTable,
  type DiceLogInsert,
} from '@/db/schema';
import type { DiceRoll, Mutation, ConditionInstance } from '@/engine/types';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const VALID_KINDS = new Set(['attack', 'damage', 'save', 'check', 'init', 'generic']);

export async function applyMutations(sessionId: string, mutations: Mutation[], rolls: DiceRoll[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const m of mutations) {
      await applyOne(tx, sessionId, m);
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

async function applyOne(tx: Tx, sessionId: string, m: Mutation): Promise<void> {
  switch (m.op) {
    case 'set_hp':
    case 'apply_damage':
    case 'heal': {
      const isPc = await isPlayerCharacter(tx, sessionId, m.actorId);
      if (isPc) {
        const cur = await getPcHp(tx, sessionId);
        const next = m.op === 'set_hp' ? m.hpCurrent : m.op === 'apply_damage' ? Math.max(0, cur - m.amount) : Math.min(getPcHpMax(tx, sessionId, cur), cur + m.amount);
        await tx.update(sessionStateTable).set({ hpCurrent: next }).where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        const [actor] = await tx.select().from(combatActorsTable).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, m.actorId))).limit(1);
        if (!actor) return;
        const cur = actor.hpCurrent;
        const next = m.op === 'set_hp' ? m.hpCurrent : m.op === 'apply_damage' ? Math.max(0, cur - m.amount) : Math.min(actor.hpMax, cur + m.amount);
        await tx.update(combatActorsTable).set({ hpCurrent: next, isAlive: next > 0 }).where(eq(combatActorsTable.id, m.actorId));
      }
      break;
    }
    case 'set_temp_hp': {
      await tx.update(sessionStateTable).set({ tempHp: m.amount }).where(eq(sessionStateTable.sessionId, sessionId));
      break;
    }
    case 'add_condition':
    case 'remove_condition': {
      const isPc = await isPlayerCharacter(tx, sessionId, m.actorId);
      if (isPc) {
        const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
        if (!s) return;
        const conds = (s.conditions as ConditionInstance[]).filter((c) => c.slug !== (m.op === 'add_condition' ? m.condition.slug : m.conditionSlug));
        if (m.op === 'add_condition') conds.push(m.condition);
        await tx.update(sessionStateTable).set({ conditions: conds }).where(eq(sessionStateTable.sessionId, sessionId));
      } else {
        const [a] = await tx.select().from(combatActorsTable).where(eq(combatActorsTable.id, m.actorId)).limit(1);
        if (!a) return;
        const conds = (a.conditions as ConditionInstance[]).filter((c) => c.slug !== (m.op === 'add_condition' ? m.condition.slug : m.conditionSlug));
        if (m.op === 'add_condition') conds.push(m.condition);
        await tx.update(combatActorsTable).set({ conditions: conds }).where(eq(combatActorsTable.id, m.actorId));
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
    // Ops Plan B emits but Plan D1 does not yet act on; ignore safely.
    case 'add_inventory':
    case 'remove_inventory':
    case 'set_equipped':
    case 'recompute_ac':
    case 'level_up':
    case 'death_save':
    case 'reset_death_saves':
      break;
  }
}

async function isPlayerCharacter(tx: Tx, sessionId: string, actorId: string): Promise<boolean> {
  const [a] = await tx.select({ id: combatActorsTable.id }).from(combatActorsTable).where(and(eq(combatActorsTable.sessionId, sessionId), eq(combatActorsTable.id, actorId))).limit(1);
  return !a;
}

async function getPcHp(tx: Tx, sessionId: string): Promise<number> {
  const [s] = await tx.select().from(sessionStateTable).where(eq(sessionStateTable.sessionId, sessionId)).limit(1);
  return s?.hpCurrent ?? 0;
}

function getPcHpMax(_tx: Tx, _sessionId: string, current: number): number {
  // Plan D1 does not re-fetch the character row on every heal; cap at current+999.
  // The engine's heal mutation is bounded by Plan B's hpMax in actions, so this is safe.
  return current + 999;
}
