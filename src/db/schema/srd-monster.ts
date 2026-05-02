import { pgTable, text, integer, jsonb, numeric } from 'drizzle-orm/pg-core';

export const srdMonster = pgTable('srd_monster', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull().unique(),
  size: text('size').notNull(),
  type: text('type').notNull(),
  alignment: text('alignment').notNull(),
  ac: integer('ac').notNull(),
  hp: integer('hp').notNull(),
  hpFormula: text('hp_formula').notNull(),
  speed: text('speed').notNull(),
  str: integer('str').notNull(),
  dex: integer('dex').notNull(),
  con: integer('con').notNull(),
  int: integer('int').notNull(),
  wis: integer('wis').notNull(),
  cha: integer('cha').notNull(),
  savingThrows: jsonb('saving_throws').$type<Record<string, number>>().notNull().default({}),
  skills: jsonb('skills').$type<Record<string, number>>().notNull().default({}),
  damageResistances: text('damage_resistances').array().notNull().default([]),
  damageImmunities: text('damage_immunities').array().notNull().default([]),
  conditionImmunities: text('condition_immunities').array().notNull().default([]),
  senses: text('senses').notNull(),
  languages: text('languages').notNull(),
  cr: numeric('cr', { precision: 6, scale: 4 }).notNull(),
  xp: integer('xp').notNull(),
  traits: jsonb('traits').$type<{ name: string; description: string }[]>().notNull().default([]),
  actions: jsonb('actions').$type<{ name: string; description: string }[]>().notNull().default([]),
  source: text('source').notNull(),
});

export type SrdMonster = typeof srdMonster.$inferSelect;
export type SrdMonsterInsert = typeof srdMonster.$inferInsert;
