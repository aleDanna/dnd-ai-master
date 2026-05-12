import { pgTable, text, uuid, timestamp, pgEnum, index, varchar, jsonb, integer } from 'drizzle-orm/pg-core';
import { users } from './users';
import { characters } from './characters';
import { campaigns } from './campaigns';

export const sessionStatusEnum = pgEnum('session_status', ['active', 'ended']);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' }),
    premise: text('premise').notNull(),
    language: text('language'),
    status: sessionStatusEnum('status').notNull().default('active'),
    turnLockHolder: uuid('turn_lock_holder'),
    turnLockExpiresAt: timestamp('turn_lock_expires_at', { withTimezone: true }),
    memoryLockHolder: uuid('memory_lock_holder'),
    memoryLockExpiresAt: timestamp('memory_lock_expires_at', { withTimezone: true }),
    /**
     * Master World Lore §5.1 — campaign tonal frame (high_heroic,
     * sword_sorcery, dark, mythic, cosmic_horror, swashbuckling, wuxia,
     * steampunk). NULL until the master picks one via `set_tonal_frame`.
     */
    tonalFrame: varchar('tonal_frame', { length: 32 }),
    /**
     * Master Handbook §2.1 — detected player engagement profiles. Empty
     * array by default; the master populates via `set_engagement_profile`
     * after observing the first few turns.
     */
    engagementProfile: jsonb('engagement_profile').$type<string[]>().notNull().default([]),
    /**
     * Multiplayer (#6): the character whose turn it is to act. NULL until
     * the session has its first character (solo backfill sets this at
     * migration time; multiplayer create sets it to host's character).
     * Updated by master tool set_current_player or server-side round-robin
     * fallback after 3 consecutive turns without a tool call.
     */
    currentPlayerCharacterId: uuid('current_player_character_id').references(() => characters.id),
    /**
     * Multiplayer (#6): monotonic turn counter. Incremented at the end of
     * every master turn, including fallback turns.
     */
    turnSeq: integer('turn_seq').notNull().default(0),
    /**
     * Multiplayer (#6): counts turns since the master last called
     * set_current_player. Reset to 0 by the tool handler. When the
     * post-loop hook reads >= 3, server-side round-robin advances the
     * current player and resets the counter.
     */
    turnsSinceMasterAdvance: integer('turns_since_master_advance').notNull().default(0),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStatusIdx: index('sessions_user_status_idx').on(t.userId, t.status),
    campaignIdx: index('sessions_campaign_idx').on(t.campaignId),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
