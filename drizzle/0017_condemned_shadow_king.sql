ALTER TABLE "sessions" ADD COLUMN "tonal_frame" varchar(32);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "engagement_profile" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "want" text;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "fear" text;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "quirk" text;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD COLUMN "attitude" varchar(16);