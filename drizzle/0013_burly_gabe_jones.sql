ALTER TABLE "session_state" ADD COLUMN "turn_state" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "session_state" ADD COLUMN "position" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "combat_actors" ADD COLUMN "turn_state" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "combat_actors" ADD COLUMN "position" jsonb DEFAULT 'null'::jsonb;