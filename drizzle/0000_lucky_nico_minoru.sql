CREATE TABLE "srd_class" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hit_die" text NOT NULL,
	"primary_ability" text[] NOT NULL,
	"saving_throws" text[] NOT NULL,
	"proficiencies" jsonb NOT NULL,
	"spellcasting" jsonb,
	"subclass_name" text,
	"subclass_choice_level" integer,
	"subclasses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starting_equipment_summary" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "srd_class_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_race" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_race_slug" text,
	"ability_score_increase" jsonb NOT NULL,
	"size" text NOT NULL,
	"speed" integer NOT NULL,
	"age_note" text,
	"languages" text[] NOT NULL,
	"traits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subrace_options" text[] DEFAULT '{}' NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "srd_race_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_background" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"skill_proficiencies" text[] NOT NULL,
	"tool_proficiencies" text[] NOT NULL,
	"languages" text NOT NULL,
	"starting_equipment" text NOT NULL,
	"feature" text NOT NULL,
	"suggested_traits" text,
	"source" text NOT NULL,
	CONSTRAINT "srd_background_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_feat" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prerequisites" text NOT NULL,
	"benefits" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "srd_feat_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_condition" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"effects" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "srd_condition_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_spell" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"level" integer NOT NULL,
	"school" text NOT NULL,
	"casting_time" text NOT NULL,
	"range" text NOT NULL,
	"components" text NOT NULL,
	"duration" text NOT NULL,
	"concentration" boolean NOT NULL,
	"ritual" boolean NOT NULL,
	"classes" text[] NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "srd_spell_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_monster" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"size" text NOT NULL,
	"type" text NOT NULL,
	"alignment" text NOT NULL,
	"ac" integer NOT NULL,
	"hp" integer NOT NULL,
	"hp_formula" text NOT NULL,
	"speed" text NOT NULL,
	"str" integer NOT NULL,
	"dex" integer NOT NULL,
	"con" integer NOT NULL,
	"int" integer NOT NULL,
	"wis" integer NOT NULL,
	"cha" integer NOT NULL,
	"saving_throws" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"skills" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"damage_resistances" text[] DEFAULT '{}' NOT NULL,
	"damage_immunities" text[] DEFAULT '{}' NOT NULL,
	"condition_immunities" text[] DEFAULT '{}' NOT NULL,
	"senses" text NOT NULL,
	"languages" text NOT NULL,
	"cr" numeric(6, 4) NOT NULL,
	"xp" integer NOT NULL,
	"traits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "srd_monster_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_armor" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"ac_formula" text NOT NULL,
	"strength_required" integer,
	"stealth_disadvantage" boolean NOT NULL,
	"cost_cp" integer NOT NULL,
	"weight_lb" integer NOT NULL,
	"don_time" text NOT NULL,
	"doff_time" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "srd_armor_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_weapon" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"proficiency_group" text NOT NULL,
	"damage" text NOT NULL,
	"damage_type" text NOT NULL,
	"properties" text[] NOT NULL,
	"cost_cp" integer NOT NULL,
	"weight_lb" integer NOT NULL,
	"range" text,
	"source" text NOT NULL,
	CONSTRAINT "srd_weapon_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_gear" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"cost_cp" integer NOT NULL,
	"weight_lb" integer NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "srd_gear_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "srd_rule_doc" (
	"id" serial PRIMARY KEY NOT NULL,
	"section_path" text NOT NULL,
	"anchor" text NOT NULL,
	"markdown" text NOT NULL,
	CONSTRAINT "srd_rule_doc_section_path_unique" UNIQUE("section_path")
);
