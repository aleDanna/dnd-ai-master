ALTER TABLE "tts_cache" ALTER COLUMN "audio_mp3" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tts_cache" ALTER COLUMN "mime_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tts_cache" ALTER COLUMN "mime_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_state" ADD COLUMN "scene_image_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session_state" ADD COLUMN "scene_image_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_state" ADD COLUMN "scene_image_failed_reason" text;--> statement-breakpoint
ALTER TABLE "tts_cache" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "tts_cache" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tts_cache" ADD COLUMN "failed_reason" text;
--> statement-breakpoint
ALTER TABLE "tts_cache" ADD CONSTRAINT "tts_cache_status_check"
  CHECK (status IN ('pending', 'ready', 'failed'));