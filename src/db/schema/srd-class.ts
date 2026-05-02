import { pgTable, text, integer, jsonb } from 'drizzle-orm/pg-core';

export const srdClass = pgTable('srd_class', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  hitDie: text('hit_die').notNull(),                   // e.g. "d12"
  primaryAbility: text('primary_ability').array().notNull(),  // ["Strength"]
  savingThrows: text('saving_throws').array().notNull(),       // ["STR","CON"]
  proficiencies: jsonb('proficiencies').$type<{
    armor: string[];
    weapons: string[];
    tools: string[];
    skillsChoose: number;
    skillsFrom: string[];
  }>().notNull(),
  spellcasting: jsonb('spellcasting').$type<{
    ability: string;
    type: 'Full' | 'Half' | 'Third' | 'Pact';
  } | null>(),
  subclassName: text('subclass_name'),
  subclassChoiceLevel: integer('subclass_choice_level'),
  subclasses: jsonb('subclasses').$type<{ name: string; source: string }[]>().notNull().default([]),
  keyFeatures: jsonb('key_features').$type<{ level: number; features: string[] }[]>().notNull().default([]),
  startingEquipmentSummary: text('starting_equipment_summary').notNull(),
  source: text('source').notNull(),
});

export type SrdClass = typeof srdClass.$inferSelect;
export type SrdClassInsert = typeof srdClass.$inferInsert;
