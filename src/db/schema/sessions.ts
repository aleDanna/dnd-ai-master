import { pgTable, text, uuid, timestamp, pgEnum, index, varchar, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';
import { characters } from './characters';

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
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStatusIdx: index('sessions_user_status_idx').on(t.userId, t.status),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
