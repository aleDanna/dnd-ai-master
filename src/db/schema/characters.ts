import { pgTable, text, integer, jsonb, uuid, timestamp, index, boolean } from 'drizzle-orm/pg-core';
import { users } from './users';
import type { EquippedFocus, Senses } from '@/engine/types';

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
    /**
     * PHB §10.1 attunement: slugs of magic items the PC is currently bonded
     * to. Capped at MAX_ATTUNED (3) by the engine; the DB column does not
     * enforce the cap so historic over-counts (if any) survive a migration.
     */
    attunedItems: jsonb('attuned_items').$type<string[]>().notNull().default([]),
    /**
     * PHB §6.4 special senses (darkvision, blindsight, tremorsense,
     * truesight) and an optional passive Perception override. NULL for
     * humans/standard humanoids with no special senses; populated by
     * race/feature derivation or the master via set_senses.
     */
    senses: jsonb('senses').$type<Senses | null>().default(null),
    /**
     * PHB §8.4 — currently held spellcasting focus. NULL when the PC
     * has no focus declared. The shape is `{ kind, itemSlug }`; the
     * snapshot validates the kind defensively (drops if outside the
     * arcane/druidic/holy/instrument set) so legacy data can't crash
     * component validation.
     */
    equippedFocus: jsonb('equipped_focus').$type<EquippedFocus | null>().default(null),
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
