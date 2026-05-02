import { pgTable, text } from 'drizzle-orm/pg-core';

export const srdCondition = pgTable('srd_condition', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  effects: text('effects').notNull(),
  source: text('source').notNull(),
});

export type SrdCondition = typeof srdCondition.$inferSelect;
export type SrdConditionInsert = typeof srdCondition.$inferInsert;
