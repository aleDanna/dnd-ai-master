import { pgTable, text, integer, boolean } from 'drizzle-orm/pg-core';

export const srdArmor = pgTable('srd_armor', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  category: text('category').notNull(),         // Light | Medium | Heavy | Shield
  acFormula: text('ac_formula').notNull(),       // e.g. "11 + DEX mod"
  strengthRequired: integer('strength_required'),
  stealthDisadvantage: boolean('stealth_disadvantage').notNull(),
  costCp: integer('cost_cp').notNull(),
  weightLb: integer('weight_lb').notNull(),
  donTime: text('don_time').notNull(),
  doffTime: text('doff_time').notNull(),
  source: text('source').notNull(),
});

export type SrdArmor = typeof srdArmor.$inferSelect;
export type SrdArmorInsert = typeof srdArmor.$inferInsert;
