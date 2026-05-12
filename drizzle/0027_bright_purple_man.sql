CREATE TYPE "public"."campaign_status" AS ENUM('active', 'ended');--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"premise" text NOT NULL,
	"style" varchar(16) DEFAULT 'improv' NOT NULL,
	"language" text,
	"tonal_frame" varchar(32),
	"engagement_profile" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "campaign_status" DEFAULT 'active' NOT NULL,
	"last_played_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_user_status_idx" ON "campaigns" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "characters_campaign_idx" ON "characters" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "sessions_campaign_idx" ON "sessions" USING btree ("campaign_id");
--> statement-breakpoint
-- ── Campaign backfill ──
-- One campaign per existing non-deleted session. Long-lived fields move from
-- sessions to campaigns. Instance characters inherit campaign_id from their
-- session. Legacy sessions whose character is a template are handled by
-- scripts/migrate-legacy-template-sessions.ts (run separately post-migration).

CREATE TEMP TABLE session_to_campaign ON COMMIT DROP AS
SELECT s.id AS session_id, gen_random_uuid() AS campaign_id
FROM sessions s
WHERE s.campaign_id IS NULL;

INSERT INTO campaigns (
  id, user_id, name, premise, language, tonal_frame, engagement_profile,
  status, last_played_at, deleted_at, created_at, updated_at
)
SELECT
  stc.campaign_id, s.user_id,
  COALESCE(c.name, 'Untitled') || '''s tale',
  s.premise, s.language, s.tonal_frame, s.engagement_profile,
  CASE WHEN s.status = 'active' THEN 'active' ELSE 'ended' END::campaign_status,
  s.updated_at, s.deleted_at, s.created_at, s.updated_at
FROM session_to_campaign stc
JOIN sessions s        ON s.id = stc.session_id
LEFT JOIN characters c ON c.id = s.character_id;

UPDATE sessions s SET campaign_id = stc.campaign_id
FROM session_to_campaign stc
WHERE stc.session_id = s.id;

UPDATE characters c SET campaign_id = s.campaign_id
FROM sessions s
WHERE s.character_id = c.id
  AND c.template_id IS NOT NULL
  AND c.campaign_id IS NULL;
