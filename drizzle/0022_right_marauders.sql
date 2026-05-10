ALTER TABLE "characters" ADD COLUMN "mounted_on" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "embarked_on" text;--> statement-breakpoint
ALTER TABLE "combat_actors" ADD COLUMN "size" varchar(16);