import { pgTable, uuid, text, integer, jsonb, boolean, index, varchar } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';
import type { TurnState, Position, Senses } from '@/engine/types';

export const combatActors = pgTable(
  'combat_actors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    monsterSlug: text('monster_slug'),
    custom: jsonb('custom').$type<Record<string, unknown> | null>(),
    name: text('name').notNull(),
    hpCurrent: integer('hp_current').notNull(),
    hpMax: integer('hp_max').notNull(),
    conditions: jsonb('conditions').$type<{ slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[]>().notNull().default([]),
    initiative: integer('initiative').notNull().default(0),
    isAlive: boolean('is_alive').notNull().default(true),
    turnState: jsonb('turn_state').$type<TurnState | null>().default(null),
    position: jsonb('position').$type<Position | null>().default(null),
    /**
     * PHB §6.4 special senses for this combat actor (typically derived
     * from the monster stat block). NULL when not provided.
     */
    senses: jsonb('senses').$type<Senses | null>().default(null),
    /**
     * PHB §1 / monster manual sizing. Used by the mounted-combat
     * helpers (PHB §3.23) to validate `canBeMount`. NULL when the
     * size data is not provided; the master should default to allowing
     * the mount when one of the two creatures lacks size data.
     */
    size: varchar('size', { length: 16 }),
  },
  (t) => ({
    sessionIdx: index('combat_actors_session_idx').on(t.sessionId),
  }),
);

export type CombatActor = typeof combatActors.$inferSelect;
export type CombatActorInsert = typeof combatActors.$inferInsert;
