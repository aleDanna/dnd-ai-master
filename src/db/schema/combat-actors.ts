import { pgTable, uuid, text, integer, jsonb, boolean, index } from 'drizzle-orm/pg-core';
import { sessions } from './sessions';
import type { TurnState, Position } from '@/engine/types';

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
  },
  (t) => ({
    sessionIdx: index('combat_actors_session_idx').on(t.sessionId),
  }),
);

export type CombatActor = typeof combatActors.$inferSelect;
export type CombatActorInsert = typeof combatActors.$inferInsert;
