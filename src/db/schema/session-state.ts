import { pgTable, uuid, integer, jsonb, boolean, text } from 'drizzle-orm/pg-core';
import { bytea } from '../types';
import { sessions } from './sessions';

export const sessionState = pgTable('session_state', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  hpCurrent: integer('hp_current').notNull(),
  tempHp: integer('temp_hp').notNull().default(0),
  hitDiceRemaining: integer('hit_dice_remaining').notNull(),
  spellSlotsUsed: jsonb('spell_slots_used').$type<Record<string, number>>().notNull().default({}),
  conditions: jsonb('conditions').$type<{ slug: string; source: string; durationRounds: number | 'until_removed'; appliedRound: number }[]>().notNull().default([]),
  resourcesUsed: jsonb('resources_used').$type<Record<string, number>>().notNull().default({}),
  inCombat: boolean('in_combat').notNull().default(false),
  combat: jsonb('combat').$type<{ round: number; turnOrder: { actorId: string; initiative: number }[]; currentIdx: number } | null>(),
  scene: text('scene').notNull().default(''),
  inventoryDelta: jsonb('inventory_delta').$type<unknown[]>().notNull().default([]),
  statusFlag: text('status_flag'),
  sceneImageData: bytea('scene_image_data'),
  sceneImagePrompt: text('scene_image_prompt'),
  sceneImageVersion: integer('scene_image_version').notNull().default(0),
});

export type SessionState = typeof sessionState.$inferSelect;
export type SessionStateInsert = typeof sessionState.$inferInsert;
