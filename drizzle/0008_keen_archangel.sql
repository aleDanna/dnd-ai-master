CREATE TYPE "public"."codex_kind" AS ENUM('npc', 'location', 'quest', 'faction', 'lore_fact', 'named_item', 'relationship');--> statement-breakpoint
CREATE TABLE "session_chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"chapter_index" integer NOT NULL,
	"first_msg_id" uuid NOT NULL,
	"last_msg_id" uuid NOT NULL,
	"message_count" integer NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "codex_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "codex_kind" NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	"last_seen_msg_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_chapters" ADD CONSTRAINT "session_chapters_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_chapters" ADD CONSTRAINT "session_chapters_first_msg_id_session_messages_id_fk" FOREIGN KEY ("first_msg_id") REFERENCES "public"."session_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_chapters" ADD CONSTRAINT "session_chapters_last_msg_id_session_messages_id_fk" FOREIGN KEY ("last_msg_id") REFERENCES "public"."session_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD CONSTRAINT "codex_entities_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_entities" ADD CONSTRAINT "codex_entities_last_seen_msg_id_session_messages_id_fk" FOREIGN KEY ("last_seen_msg_id") REFERENCES "public"."session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_chapters_session_chapter_idx" ON "session_chapters" USING btree ("session_id","chapter_index");--> statement-breakpoint
CREATE UNIQUE INDEX "session_chapters_session_chapter_uniq" ON "session_chapters" USING btree ("session_id","chapter_index");--> statement-breakpoint
CREATE INDEX "codex_entities_session_kind_idx" ON "codex_entities" USING btree ("session_id","kind");--> statement-breakpoint
CREATE INDEX "codex_entities_session_last_seen_idx" ON "codex_entities" USING btree ("session_id","last_seen_msg_id");--> statement-breakpoint
CREATE UNIQUE INDEX "codex_entities_session_kind_slug_uniq" ON "codex_entities" USING btree ("session_id","kind","slug");