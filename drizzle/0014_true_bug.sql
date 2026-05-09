ALTER TABLE "characters" ADD COLUMN "inspiration" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session_state" ADD COLUMN "last_long_rest_at" timestamp;