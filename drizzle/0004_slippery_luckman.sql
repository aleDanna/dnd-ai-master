CREATE TABLE "tts_cache" (
	"message_id" uuid NOT NULL,
	"voice" text NOT NULL,
	"audio_mp3" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tts_cache_message_id_voice_pk" PRIMARY KEY("message_id","voice")
);
--> statement-breakpoint
ALTER TABLE "tts_cache" ADD CONSTRAINT "tts_cache_message_id_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."session_messages"("id") ON DELETE cascade ON UPDATE no action;