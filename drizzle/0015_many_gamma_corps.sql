ALTER TABLE "characters" ADD COLUMN "attuned_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "rarity" varchar(16);--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "category" varchar(16);--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "attunement_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "attunement_prereq" text;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "cursed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "sentient" boolean DEFAULT false NOT NULL;