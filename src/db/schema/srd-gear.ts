import { pgTable, text, integer } from 'drizzle-orm/pg-core';

export const srdGear = pgTable('srd_gear', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  category: text('category').notNull(),
  costCp: integer('cost_cp').notNull(),
  weightLb: integer('weight_lb').notNull(),
  description: text('description').notNull(),
  source: text('source').notNull(),
});

export type SrdGear = typeof srdGear.$inferSelect;
export type SrdGearInsert = typeof srdGear.$inferInsert;
