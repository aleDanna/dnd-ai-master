import { pgTable, uuid, integer, jsonb, boolean, text, timestamp } from 'drizzle-orm/pg-core';
import { bytea } from '../types';
import { sessions } from './sessions';
import type { TurnState, Position, TravelState } from '@/engine/types';

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
  deathSaves: jsonb('death_saves').$type<{ successes: number; failures: number }>().notNull().default({ successes: 0, failures: 0 }),
  flags: jsonb('flags').$type<{ stable?: boolean; dead?: boolean }>().notNull().default({}),
  exhaustionLevel: integer('exhaustion_level').notNull().default(0),
  concentratingOn: jsonb('concentrating_on').$type<{ spellSlug: string; slotLevel: number; startedRound: number } | null>().default(null),
  turnState: jsonb('turn_state').$type<TurnState | null>().default(null),
  position: jsonb('position').$type<Position | null>().default(null),
  inCombat: boolean('in_combat').notNull().default(false),
  combat: jsonb('combat').$type<{ round: number; turnOrder: { actorId: string; initiative: number }[]; currentIdx: number } | null>(),
  scene: text('scene').notNull().default(''),
  inventoryDelta: jsonb('inventory_delta').$type<unknown[]>().notNull().default([]),
  statusFlag: text('status_flag'),
  sceneImageData: bytea('scene_image_data'),
  sceneImagePrompt: text('scene_image_prompt'),
  sceneImageVersion: integer('scene_image_version').notNull().default(0),
  /** True while a scene-image generation job is in flight; UI renders a
   *  shared spinner across all clients. Set false on success/failure. */
  sceneImagePending: boolean('scene_image_pending').notNull().default(false),
  /** Lock timestamp for TTL-based orphan re-claim (60s). */
  sceneImagePendingAt: timestamp('scene_image_pending_at', { withTimezone: true }),
  /** Provider/error message when the last image attempt failed. NULL after
   *  success or while pending. */
  sceneImageFailedReason: text('scene_image_failed_reason'),
  /**
   * PHB §5.2: timestamp of the most recent successful long rest. Used to
   * enforce the "at most one long rest per 24 hours" cooldown. NULL when
   * the PC has never long-rested since the session started.
   */
  lastLongRestAt: timestamp('last_long_rest_at'),
  /**
   * PHB §6 — exploration/travel context: pace (Fast/Normal/Slow), ambient
   * light level (bright/dim/darkness), marching order (front/middle/back).
   * NULL when the session is in plain combat/scene mode without explicit
   * travel context.
   */
  travel: jsonb('travel').$type<TravelState | null>().default(null),
});

export type SessionState = typeof sessionState.$inferSelect;
export type SessionStateInsert = typeof sessionState.$inferInsert;
