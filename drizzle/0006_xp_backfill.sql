-- One-time backfill for characters that existed before the xp column was added.
-- Migration 0005 added "xp" with default 0; pre-existing characters who had
-- already been leveled up therefore showed 0/300 on the new XP bar despite
-- being at level 3, 5, etc. We can't recover the actual XP they earned
-- (there were no records), but we can at least seat each one at the
-- threshold of their current level so the bar reads as "freshly arrived
-- at this level, no progress yet."
--
-- Only touches characters whose xp is currently 0. Anyone who's already
-- been awarded XP via the new award_xp tool keeps their actual total.
-- Level-1 characters stay at 0 — that's their correct value.

UPDATE "characters" SET "xp" = CASE "level"
  WHEN 1 THEN 0
  WHEN 2 THEN 300
  WHEN 3 THEN 900
  WHEN 4 THEN 2700
  WHEN 5 THEN 6500
  WHEN 6 THEN 14000
  WHEN 7 THEN 23000
  WHEN 8 THEN 34000
  WHEN 9 THEN 48000
  WHEN 10 THEN 64000
  WHEN 11 THEN 85000
  WHEN 12 THEN 100000
  WHEN 13 THEN 120000
  WHEN 14 THEN 140000
  WHEN 15 THEN 165000
  WHEN 16 THEN 195000
  WHEN 17 THEN 225000
  WHEN 18 THEN 265000
  WHEN 19 THEN 305000
  WHEN 20 THEN 355000
  ELSE 0
END
WHERE "xp" = 0 AND "level" > 1;
