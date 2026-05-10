import { pgTable, text, integer, jsonb, uuid, timestamp, index, boolean } from 'drizzle-orm/pg-core';
import { users } from './users';
import type {
  Bastion,
  ClassLevel,
  CraftingProject,
  DowntimeActivity,
  EquippedFocus,
  Hireling,
  MountedState,
  Senses,
} from '@/engine/types';

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
    /**
     * PHB §2.5 — full multi-class breakdown. Each entry is a
     * `{ slug, level, subclass? }` record; the FIRST entry is the starting
     * class (matches `classSlug`). The sum of `level` across entries equals
     * the row's top-level `level`. Default `[]` so legacy single-class rows
     * survive the migration; the snapshot hydrator backfills the array from
     * `classSlug` + `level` when empty.
     */
    classes: jsonb('classes').$type<ClassLevel[]>().notNull().default([]),
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
    /**
     * PHB §5 + DMG crafting rules: in-flight crafting projects pinned to
     * the PC. Each entry is a `{ id, recipeSlug, kind, daysRemaining,
     * gpSpent, startedRound? }` record. Default `[]` so legacy rows
     * survive the migration; the snapshot hydrator coerces null/missing
     * to an empty array. Mutations: start_crafting (append),
     * progress_crafting (decrement days/increment gp), complete_crafting
     * (remove + emit add_inventory), cancel_crafting (remove).
     */
    craftingProjects: jsonb('crafting_projects').$type<CraftingProject[]>().notNull().default([]),
    /**
     * PHB §6 — in-flight downtime activities (practicing_profession,
     * recuperating, researching, training, crafting). Each entry tracks
     * the activity kind, days remaining, and any gp spent. Default `[]`
     * so legacy rows survive the migration. Mutations:
     * start_downtime_activity (append), complete_downtime_activity
     * (remove from array). The 'crafting' kind exists for completeness;
     * actual crafting projects live on `craftingProjects`.
     */
    downtimeActivities: jsonb('downtime_activities')
      .$type<DowntimeActivity[]>()
      .notNull()
      .default([]),
    /**
     * PHB §6 — currently retained hirelings. Each entry holds the wage
     * tier (skilled = 2 gp/day or unskilled = 2 sp/day), count, days,
     * and pre-computed gp/sp cost. Default `[]`. Mutations: hire
     * (append), dismiss_hireling (remove).
     */
    hirelings: jsonb('hirelings').$type<Hireling[]>().notNull().default([]),
    /**
     * 2024 PHB simplified Bastion record — the PC's owned property.
     * NULL until `set_bastion` is called for the first time. Holds a
     * name, fortification tier (modest/fortified/castle), array of
     * rooms (kind + level 1..3), and defender count. Mutations:
     * set_bastion (overwrite), add_bastion_room (append room — no-op
     * when bastion is null).
     */
    bastion: jsonb('bastion').$type<Bastion | null>().default(null),
    /**
     * PHB §3.23 — current mounted state (rider POV). NULL when the PC
     * is not on a mount. Holds `{ mountId, mode }` where `mountId` is
     * the id of a `combat_actors` row in the same scene and `mode` is
     * controlled/independent. Mutations: mount (overwrite),
     * dismount (clear), set_mount_mode (update mode).
     */
    mountedOn: jsonb('mounted_on').$type<MountedState | null>().default(null),
    /**
     * PHB §9.6 — current vehicle the PC is embarked on (slug into the
     * `VEHICLE_CATALOG`). NULL when the PC is on foot. Mutations:
     * embark_vehicle (overwrite), disembark_vehicle (clear).
     */
    embarkedOn: text('embarked_on'),
    /**
     * Per-campaign character isolation: when a session is created, the
     * selected character is deep-copied and the copy gets `templateId` =
     * the original character's id. The copy ("instance") is what the
     * session mutates — level, xp, inventory, spells, etc. The template
     * stays pristine so it can be reused in another campaign without
     * carrying over progression.
     *
     * - NULL → this row is a template (shown in character lists).
     * - non-NULL → this row is an instance bound to one session (hidden
     *   from the user-facing list; only the linked session reads it).
     */
    templateId: uuid('template_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('characters_user_idx').on(t.userId),
    templateIdx: index('characters_template_idx').on(t.templateId),
  }),
);

export type Character = typeof characters.$inferSelect;
export type CharacterInsert = typeof characters.$inferInsert;
