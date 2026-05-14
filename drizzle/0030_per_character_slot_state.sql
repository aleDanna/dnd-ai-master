ALTER TABLE "characters" ADD COLUMN "spell_slots_used" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "resources_used" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

-- Backfill: the pre-migration architecture stored spell slots and class
-- resources on `session_state` (one row per session, tracking the *active*
-- PG only). Move the existing data to the active PG's `characters` row for
-- each session so the post-migration code sees their used slots. Non-active
-- party members had no persistent slot state under the old schema, so they
-- start at the default {} (a clean rest). Templates (templateId IS NULL)
-- and rows missing a campaign join are skipped.
UPDATE "characters" c
SET
  "spell_slots_used" = COALESCE(ss."spell_slots_used", '{}'::jsonb),
  "resources_used" = COALESCE(ss."resources_used", '{}'::jsonb)
FROM "sessions" s
JOIN "session_state" ss ON ss."session_id" = s."id"
WHERE c."id" = s."current_player_character_id"
  AND c."deleted_at" IS NULL
  AND c."template_id" IS NOT NULL;