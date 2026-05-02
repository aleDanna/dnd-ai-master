CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"race_slug" text NOT NULL,
	"class_slug" text NOT NULL,
	"background_slug" text NOT NULL,
	"abilities" jsonb NOT NULL,
	"proficiency_bonus" integer NOT NULL,
	"hp_max" integer NOT NULL,
	"ac" integer NOT NULL,
	"speed" integer NOT NULL,
	"proficiencies" jsonb NOT NULL,
	"spellcasting" jsonb,
	"spells_known" text[] DEFAULT '{}' NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identity" jsonb NOT NULL,
	"hit_dice_max" integer NOT NULL,
	"hit_die_size" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "characters_user_idx" ON "characters" USING btree ("user_id");