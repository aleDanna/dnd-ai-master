CREATE TYPE "public"."session_status" AS ENUM('active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('player', 'master', 'system');--> statement-breakpoint
CREATE TYPE "public"."dice_kind" AS ENUM('attack', 'damage', 'save', 'check', 'init', 'generic');--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"character_id" uuid NOT NULL,
	"premise" text NOT NULL,
	"language" text,
	"status" "session_status" DEFAULT 'active' NOT NULL,
	"turn_lock_holder" uuid,
	"turn_lock_expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_state" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"hp_current" integer NOT NULL,
	"temp_hp" integer DEFAULT 0 NOT NULL,
	"hit_dice_remaining" integer NOT NULL,
	"spell_slots_used" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resources_used" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_combat" boolean DEFAULT false NOT NULL,
	"combat" jsonb,
	"scene" text DEFAULT '' NOT NULL,
	"inventory_delta" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status_flag" text
);
--> statement-breakpoint
CREATE TABLE "session_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"cache_breakpoint" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dice_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid,
	"kind" "dice_kind" NOT NULL,
	"formula" text NOT NULL,
	"rolls" integer[] NOT NULL,
	"modifier" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "combat_actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"monster_slug" text,
	"custom" jsonb,
	"name" text NOT NULL,
	"hp_current" integer NOT NULL,
	"hp_max" integer NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"initiative" integer DEFAULT 0 NOT NULL,
	"is_alive" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_state" ADD CONSTRAINT "session_state_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dice_log" ADD CONSTRAINT "dice_log_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dice_log" ADD CONSTRAINT "dice_log_message_id_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combat_actors" ADD CONSTRAINT "combat_actors_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_status_idx" ON "sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "session_messages_session_created_idx" ON "session_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "dice_log_session_created_idx" ON "dice_log" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "combat_actors_session_idx" ON "combat_actors" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");