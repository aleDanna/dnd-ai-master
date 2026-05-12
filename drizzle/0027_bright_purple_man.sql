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