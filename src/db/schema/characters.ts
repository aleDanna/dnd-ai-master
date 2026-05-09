import { pgTable, text, integer, jsonb, uuid, timestamp, index, boolean } from 'drizzle-orm/pg-core';
import { users } from './users';

export const characters = pgTable(
  'characters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    level: integer('level').notNull().default(1),
    xp: integer('xp').notNull().default(0),
    raceSlug: text('race_slug').notNull(),
    classSlug: text('class_slug').notNull(),
    backgroundSlug: text('background_slug').notNull(),
    abilities: jsonb('abilities').$type<{ STR: number; DEX: number; CON: number; INT: number; WIS: number; CHA: number }>().notNull(),
    proficiencyBonus: integer('proficiency_bonus').notNull(),
    hpMax: integer('hp_max').notNull(),
    ac: integer('ac').notNull(),
    speed: integer('speed').notNull(),
    proficiencies: jsonb('proficiencies').$type<{
      saves: string[];
      skills: string[];
      expertise: string[];
      weapons: string[];
      armor: string[];
      tools: string[];
      languages: string[];
    }>().notNull(),
    spellcasting: jsonb('spellcasting').$type<{
      ability: string;
      spellSaveDC: number;
      spellAttackBonus: number;
      slotsMax: Record<string, number>;
      spellsKnown: string[];
      spellsPrepared: string[];
    } | null>(),
    spellsKnown: text('spells_known').array().notNull().default([]),
    features: jsonb('features').$type<{ slug: string; source: string; usesMax: number | 'unlimited'; description: string }[]>().notNull().default([]),
    inventory: jsonb('inventory').$type<{ slug: string; qty: number; equipped: boolean }[]>().notNull().default([]),
    identity: jsonb('identity').$type<{
      alignment: string;
      trait?: string;
      bond?: string;
      flaw?: string;
      backstory?: string;
      portraitColor?: string;
    }>().notNull(),
    hitDiceMax: integer('hit_dice_max').notNull(),
    hitDieSize: integer('hit_die_size').notNull(),
    /**
     * PHB §18.1 Inspiration. Single boolean — the PC has it or doesn't.
     * The DM grants it; the PC spends it for ADV on one d20 roll.
     */
    inspiration: boolean('inspiration').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('characters_user_idx').on(t.userId),
  }),
);

export type Character = typeof characters.$inferSelect;
export type CharacterInsert = typeof characters.$inferInsert;
