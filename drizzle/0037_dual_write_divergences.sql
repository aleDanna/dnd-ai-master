CREATE TABLE "dual_write_divergences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"character_id" uuid,
	"event_type" text,
	"vault_state" jsonb,
	"postgres_state" jsonb,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dual_write_divergences" ADD CONSTRAINT "dual_write_divergences_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dual_write_divergences" ADD CONSTRAINT "dual_write_divergences_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dual_write_divergences_session_idx" ON "dual_write_divergences" USING btree ("session_id","created_at" DESC NULLS LAST);