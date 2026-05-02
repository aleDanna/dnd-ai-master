import { pgTable, text, integer, jsonb } from 'drizzle-orm/pg-core';

export const srdRace = pgTable('srd_race', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  parentRaceSlug: text('parent_race_slug'),
  abilityScoreIncrease: jsonb('ability_score_increase').$type<Record<string, number | 'choice'>>().notNull(),
  size: text('size').notNull(),
  speed: integer('speed').notNull(),
  ageNote: text('age_note'),
  languages: text('languages').array().notNull(),
  traits: jsonb('traits').$type<{ name: string; description: string }[]>().notNull().default([]),
  subraceOptions: text('subrace_options').array().notNull().default([]),
  source: text('source').notNull(),
});

export type SrdRace = typeof srdRace.$inferSelect;
export type SrdRaceInsert = typeof srdRace.$inferInsert;
