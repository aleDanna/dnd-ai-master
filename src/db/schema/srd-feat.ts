import { pgTable, text } from 'drizzle-orm/pg-core';

export const srdFeat = pgTable('srd_feat', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  prerequisites: text('prerequisites').notNull(),
  benefits: text('benefits').notNull(),
  source: text('source').notNull(),
});

export type SrdFeat = typeof srdFeat.$inferSelect;
export type SrdFeatInsert = typeof srdFeat.$inferInsert;
