ALTER TABLE "session_state" ADD COLUMN "scene_image_data" "bytea";--> statement-breakpoint
ALTER TABLE "session_state" ADD COLUMN "scene_image_prompt" text;--> statement-breakpoint
ALTER TABLE "session_state" ADD COLUMN "scene_image_version" integer DEFAULT 0 NOT NULL;