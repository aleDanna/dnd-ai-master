ALTER TABLE "campaigns" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
-- Backfill: snapshot each campaign creator's user-preferences into
-- campaigns.settings, stripping ttsAutoplay (which stays per-user).
UPDATE campaigns AS c
SET settings = COALESCE(u.preferences, '{}'::jsonb) - 'ttsAutoplay'
FROM users AS u
WHERE c.user_id = u.id
  AND c.deleted_at IS NULL
  AND c.settings = '{}'::jsonb;