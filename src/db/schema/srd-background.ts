import { pgTable, text } from 'drizzle-orm/pg-core';

export const srdBackground = pgTable('srd_background', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  skillProficiencies: text('skill_proficiencies').array().notNull(),
  toolProficiencies: text('tool_proficiencies').array().notNull(),
  languages: text('languages').notNull(),               // free text e.g. "Two of choice"
  startingEquipment: text('starting_equipment').notNull(),
  feature: text('feature').notNull(),
  suggestedTraits: text('suggested_traits'),
  source: text('source').notNull(),
});

export type SrdBackground = typeof srdBackground.$inferSelect;
export type SrdBackgroundInsert = typeof srdBackground.$inferInsert;
