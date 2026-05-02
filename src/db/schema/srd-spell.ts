import { pgTable, text, integer, boolean } from 'drizzle-orm/pg-core';

export const srdSpell = pgTable('srd_spell', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  level: integer('level').notNull(),               // 0 = cantrip
  school: text('school').notNull(),
  castingTime: text('casting_time').notNull(),
  range: text('range').notNull(),
  components: text('components').notNull(),
  duration: text('duration').notNull(),
  concentration: boolean('concentration').notNull(),
  ritual: boolean('ritual').notNull(),
  classes: text('classes').array().notNull(),
  description: text('description').notNull(),
  source: text('source').notNull(),
});

export type SrdSpell = typeof srdSpell.$inferSelect;
export type SrdSpellInsert = typeof srdSpell.$inferInsert;
