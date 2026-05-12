import { pgTable, text, uuid, timestamp, pgEnum, varchar, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export const campaignStatusEnum = pgEnum('campaign_status', ['active', 'ended']);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    premise: text('premise').notNull(),
    style: varchar('style', { length: 16 }).notNull().default('improv'),
    language: text('language'),
    tonalFrame: varchar('tonal_frame', { length: 32 }),
    engagementProfile: jsonb('engagement_profile').$type<string[]>().notNull().default([]),
    status: campaignStatusEnum('status').notNull().default('active'),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStatusIdx: index('campaigns_user_status_idx').on(t.userId, t.status),
  }),
);

export type Campaign = typeof campaigns.$inferSelect;
export type CampaignInsert = typeof campaigns.$inferInsert;
