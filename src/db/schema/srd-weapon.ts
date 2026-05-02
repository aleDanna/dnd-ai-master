import { pgTable, text, integer } from 'drizzle-orm/pg-core';

export const srdWeapon = pgTable('srd_weapon', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  category: text('category').notNull(),                 // "Simple Melee" | "Martial Ranged" | ...
  proficiencyGroup: text('proficiency_group').notNull(),// "Simple" | "Martial"
  damage: text('damage').notNull(),                     // "1d8"
  damageType: text('damage_type').notNull(),
  properties: text('properties').array().notNull(),
  costCp: integer('cost_cp').notNull(),
  weightLb: integer('weight_lb').notNull(),
  range: text('range'),
  source: text('source').notNull(),
});

export type SrdWeapon = typeof srdWeapon.$inferSelect;
export type SrdWeaponInsert = typeof srdWeapon.$inferInsert;
