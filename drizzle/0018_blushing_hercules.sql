ALTER TABLE "characters" ADD COLUMN IF NOT EXISTS "equipped_focus" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "tts_cache" ADD COLUMN IF NOT EXISTS "provider" text DEFAULT 'openai' NOT NULL;
