ALTER TABLE "ai_usage" ADD COLUMN "load_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "prompt_eval_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "eval_duration_ms" integer;