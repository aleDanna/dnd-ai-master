ALTER TABLE "characters" ADD COLUMN "senses" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "session_state" ADD COLUMN "travel" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "combat_actors" ADD COLUMN "senses" jsonb DEFAULT 'null'::jsonb;