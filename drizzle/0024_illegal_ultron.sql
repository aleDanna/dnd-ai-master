ALTER TABLE "tts_cache" ADD COLUMN "model" text DEFAULT 'gpt-4o-mini-tts' NOT NULL;--> statement-breakpoint
-- Earlier hand-applied reshape renamed the PK to include `provider`, so the
-- live DB has constraint `tts_cache_message_id_provider_voice_pk` even though
-- Drizzle's snapshot expects `tts_cache_message_id_voice_pk`. Drop whichever
-- one is actually present so this migration works on both lineages.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tts_cache'::regclass
      AND conname = 'tts_cache_message_id_provider_voice_pk'
  ) THEN
    ALTER TABLE "tts_cache" DROP CONSTRAINT "tts_cache_message_id_provider_voice_pk";
  ELSIF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tts_cache'::regclass
      AND conname = 'tts_cache_message_id_voice_pk'
  ) THEN
    ALTER TABLE "tts_cache" DROP CONSTRAINT "tts_cache_message_id_voice_pk";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "tts_cache" ADD CONSTRAINT "tts_cache_message_id_voice_model_pk" PRIMARY KEY("message_id","voice","model");