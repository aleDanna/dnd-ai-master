CREATE TABLE "campaign_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"max_uses" integer,
	"uses_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "campaign_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "current_player_character_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "turn_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "turns_since_master_advance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "author_character_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_invites" ADD CONSTRAINT "campaign_invites_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_invites" ADD CONSTRAINT "campaign_invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_invites_token_idx" ON "campaign_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "campaign_invites_campaign_idx" ON "campaign_invites" USING btree ("campaign_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_current_player_character_id_characters_id_fk" FOREIGN KEY ("current_player_character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_author_character_id_characters_id_fk" FOREIGN KEY ("author_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- ── Multiplayer backfill ──
-- Existing sessions: current_player_character_id = the (only) character
-- Existing player messages: author_character_id = session's character

UPDATE sessions
SET current_player_character_id = character_id
WHERE current_player_character_id IS NULL;

UPDATE session_messages sm
SET author_character_id = s.character_id
FROM sessions s
WHERE sm.session_id = s.id
  AND sm.role = 'player'
  AND sm.author_character_id IS NULL;
