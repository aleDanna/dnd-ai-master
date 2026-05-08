ALTER TABLE "sessions" ADD COLUMN "memory_lock_holder" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "memory_lock_expires_at" timestamp with time zone;