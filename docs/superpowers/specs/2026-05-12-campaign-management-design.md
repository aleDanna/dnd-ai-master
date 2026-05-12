# Campaign Management (Sub-project #5) — Minimum Slice Design Document

> Status: approved during brainstorming on 2026-05-12. Implementation plan to follow.

## 0. Context and goals

The MVP (Plans A–D) is shipped end-to-end: single-user solo play with a custom-built character against the AI Master, backed by a ~93% complete D&D 5e deterministic engine. The current model conflates "campaign" with "session": every `sessions` row owns the premise, the detected language, the master tonal frame, the engagement profile, and the active play state all at once. There is no concept of a long-running narrative shell that survives a session ending or that could be shared with other players.

This document specifies the **minimum slice of sub-project #5 (Campaign management)** as defined in [2026-05-02-dnd-ai-master-mvp-design.md](2026-05-02-dnd-ai-master-mvp-design.md). The minimum slice introduces a first-class `Campaign` entity that owns the long-lived narrative state, while `Session` retains the active play state. This is the **smallest change that prepares the ground for sub-project #6 (Multiplayer)** without taking on the full scope of styles (module / hybrid), milestones, or pre-written modules.

Three explicit non-goals of this slice (deferred to follow-ups of the same sub-project):

- Pre-written module style and module format.
- Hybrid style with narrative milestones.
- Multiple sessions per campaign (sittings, side adventures).

The slice covers the **"Fully improvised" style only**, which matches the current single-style behavior of the MVP. The schema, however, includes a `style` column with default `'improv'` so future styles enter without a schema migration.

## 1. Scope of this document

This spec covers all the changes needed to ship the minimum slice in two PRs:

| PR | Contains |
|---|---|
| **PR 1** | New `campaigns` table, additive columns on `sessions` and `characters`, backfill of existing rows, application code switched to read/write through `campaigns`, new API routes, new UI routes, deprecation of `POST /api/sessions` and `GET /api/sessions`. Old session columns kept as deprecated. |
| **PR 2** (follow-up, after ≥1 week of stable production) | Drop deprecated columns on `sessions`. |

Anything not listed in §6 is out of scope.

## 2. High-level architecture

```
                       ┌──────────────────────────┐
                       │ Character (template)     │  user-visible roster
                       │ template_id = NULL       │  (templates only)
                       │ campaign_id  = NULL      │
                       └────────────┬─────────────┘
                                    │ POST /api/campaigns
                                    │ forks deep-copy
                                    ▼
                       ┌──────────────────────────┐
                       │ Campaign (NEW)           │  long-lived state
                       │ name, premise, style,    │
                       │ language, tonal_frame,   │
                       │ engagement_profile,      │
                       │ status, last_played_at   │
                       └────────────┬─────────────┘
                                    │ FK
                  ┌─────────────────┼─────────────────┐
                  │                                   │
                  ▼                                   ▼
        ┌──────────────────┐               ┌──────────────────┐
        │ Character        │               │ Session          │  active play state
        │ (instance)       │               │ campaign_id NEW  │  - chat log
        │ template_id NN   │               │ character_id     │  - combat
        │ campaign_id  NN  │◄──────────────┤ status, locks    │  - dice / chapters
        └──────────────────┘  character_id └──────────────────┘
                                                     │ owns (unchanged)
                                                     ▼
                       session_state, session_messages, session_chapters,
                       dice_log, combat_actors
```

### Architectural principles

1. **Campaign owns identity and intent.** Premise, language, tonal frame, engagement profile — anything the master treats as persistent setup — lives on `campaigns`.
2. **Session owns play state.** Turn locks, combat, message log, dice rolls, chapters — anything that ticks during play — stays on `sessions` and its dependent tables.
3. **Character fork moves from session-time to campaign-time.** Existing template/instance pattern (commit `29e40ce`) is preserved; the fork happens at `POST /api/campaigns` instead of `POST /api/sessions`.
4. **Schema is multiplayer-ready.** The DB allows N characters per campaign and N sessions per campaign. The application enforces 1 of each in this slice. Sub-project #6 will relax application enforcement, no schema change required.
5. **Additive migration with deferred drop.** PR 1 only adds; PR 2 drops after verification.

## 3. Data model

### 3.1 New table: `campaigns`

```
campaigns
  id                 uuid PK
  user_id            text NOT NULL → users.id  ON DELETE CASCADE
  name               text NOT NULL              -- short title, shown in lists
  premise            text NOT NULL              -- initial narrative seed (immutable after creation)
  style              varchar(16) NOT NULL DEFAULT 'improv'
                                                -- enum-like, only 'improv' valid in this slice
  language           text                        -- auto-detected at first master turn
  tonal_frame        varchar(32)                 -- Master World Lore §5.1
  engagement_profile jsonb NOT NULL DEFAULT '[]'::jsonb
                                                -- Master Handbook §2.1
  status             campaign_status NOT NULL DEFAULT 'active'
                                                -- enum('active','ended')
  last_played_at     timestamptz                 -- updated at end of every master turn
  deleted_at         timestamptz                 -- soft delete
  created_at         timestamptz NOT NULL DEFAULT now()
  updated_at         timestamptz NOT NULL DEFAULT now()

  INDEX campaigns_user_status_idx (user_id, status)
```

### 3.2 Changes to existing tables

```
sessions  (modified)
  +  campaign_id        uuid → campaigns.id  ON DELETE CASCADE
                        -- nullable during backfill, NOT NULL after Step C
  ~  premise            text                 -- DEPRECATED, read path moves to campaigns
  ~  language           text                 -- DEPRECATED
  ~  tonal_frame        varchar(32)          -- DEPRECATED
  ~  engagement_profile jsonb                -- DEPRECATED
  +  INDEX sessions_campaign_idx (campaign_id)

characters  (modified)
  +  campaign_id        uuid → campaigns.id  ON DELETE CASCADE   (nullable)
  +  INDEX characters_campaign_idx (campaign_id)
```

### 3.3 Application invariants

- **Template character:** `template_id IS NULL` and `campaign_id IS NULL`.
- **Instance character:** `template_id IS NOT NULL` and `campaign_id IS NOT NULL`.
- **One active session per campaign:** enforced at the application layer, not the DB. A second `POST /api/campaigns/[id]/sessions` (future endpoint, not in this slice) would return `409 Conflict` if one is already active.
- **One character per campaign (for now):** enforced at the application layer. The schema allows N. Multiplayer (#6) lifts this constraint.

### 3.4 Notes

- `scene` stays on `session_state.scene`. It is updated every turn by the master and, with one active session per campaign, is indistinguishable from a campaign-level `scene`. Moving it would add complexity for no gain in this slice.
- `session_messages`, `session_chapters`, `dice_log`, `combat_actors` are not modified. They remain tied to the active session.
- `campaign_status` enum (`'active'`, `'ended'`) is separate from `session_status` to keep their lifecycles independent. A campaign is `'ended'` when its session is ended *and* the user has not started a new one (in this slice: never, since 1 session per campaign).

## 4. API routes

### 4.1 New routes

| Route | Method | Description |
|---|---|---|
| `/api/campaigns` | GET | List user's campaigns. Query: `?status=active|ended`. Sort: `last_played_at DESC`. Filter: `user_id = auth.subject AND deleted_at IS NULL`. |
| `/api/campaigns` | POST | Create campaign. Body: `{ name, premise, characterTemplateId }`. Transaction: insert campaign → fork template → set instance.`campaign_id` → insert session + session_state. Returns `{ campaign, sessionId }`. UI redirects to `/sessions/[sessionId]`. |
| `/api/campaigns/[id]` | GET | Detail. Returns `{ campaign, character, activeSession }`. 404 on wrong owner or non-existent. |
| `/api/campaigns/[id]` | PATCH | Rename only. Body: `{ name }`. Premise mutation rejected with 422. |
| `/api/campaigns/[id]` | DELETE | Soft delete. Cascading soft-deletes: the active session and the character instance, in a transaction. |

All routes are protected by Clerk middleware; queries filter on `user_id = auth.subject`.

### 4.2 Changes to existing session routes

| Route | Change |
|---|---|
| `POST /api/sessions` | **Deprecated.** Returns `410 Gone` with message "use POST /api/campaigns instead." |
| `GET /api/sessions` | **Deprecated.** Returns `410 Gone`. UI replaced by `/campaigns`. |
| `GET /api/sessions/[id]` | Response shape extended: `{ session, campaign, state, ... }`. The UI reads long-lived fields from `campaign`. |
| `POST /api/sessions/[id]/turn` | Master loop reads `premise`, `language`, `tonal_frame`, `engagement_profile` from a join with `campaigns`. Tool handlers `set_tonal_frame` and `set_engagement_profile` write to `campaigns` (not `sessions`). At end of turn: `UPDATE campaigns SET last_played_at = now() WHERE id = ...`. |
| `GET /api/sessions/[id]/state` | Unchanged. |
| `DELETE /api/sessions/[id]` | Unchanged. Kept for future use (#6: ending a session without ending the campaign). |

### 4.3 Key API decisions

- **Atomic campaign creation.** The inserts (campaign, instance character forked from template, session, session_state) all happen in one transaction. Any failure rolls back.
- **Premise is immutable.** Editing it after creation would split the master's view of the narrative (history vs new instruction). The user's escape hatch is to create a new campaign.
- **No `POST /api/campaigns/[id]/sessions` in this slice.** With one session per campaign, the session is created by `POST /api/campaigns`. A future endpoint will add "start a new session in this campaign" when sittings arrive.

## 5. UI

### 5.1 Routes

```
+ /campaigns                  list (filter active/ended)
+ /campaigns/new              creation wizard (2 steps: Character + Premise)
+ /campaigns/[id]             detail: character card · premise · "Continue" button
~ /hub                        "Open tables" section → "Campaigns" section
~ TopBar "Campaigns" link     now points to /campaigns (was placeholder pointing to /hub)
- /sessions                   removed, 301 → /campaigns
- /sessions/new               removed, 301 → /campaigns/new
= /sessions/[id]              unchanged (game screen)
= /characters, /characters/*  unchanged
```

### 5.2 Hub (`/hub`)

The existing "Heroes" + "Open tables" layout becomes "Campaigns" + "Heroes". Campaign cards show: name, status chip (active/ended), language chip, character name & race/class/level, short premise excerpt, last-played-at relative time. Order: `last_played_at DESC`. CTAs: "New character" and "New campaign". Up to 3 campaigns shown, with "View all →" link to `/campaigns`.

### 5.3 New campaign wizard (`/campaigns/new`)

Two-step linear flow:

1. **Character.** Grid of the user's character templates (filtered: `template_id IS NULL`). Empty state: "Roll a new character first" CTA → `/characters/new`.
2. **Premise.** Five preset cards from `src/sessions/campaign-presets.ts` (already in the codebase) plus a "Custom…" option that opens a textarea. Below: a `name` input pre-filled from the preset name or auto-derived; the user can edit.

CTA "Begin the tale" → `POST /api/campaigns` → redirect to `/sessions/[sessionId]`.

The richer 4-step wizard in the design handoff (`design/prototype/app/screens-campaign-wizard.jsx`) — Mode / Style / Party / Premise — is deferred until multiplayer and styles arrive. The Character step replaces the Party step in the simplified slice.

### 5.4 Campaign detail (`/campaigns/[id]`)

Layout:

- **Header**: name (inline-editable), status chip, style chip ("improv"), language chip.
- **Primary action**: "Continue →" button. Resolves `activeSession.id` server-side and links to `/sessions/[sessionId]`.
- **Hero card** (left): character portrait, name, race/class/level, HP/AC summary, link to `/characters/[templateId]` for the read-only sheet.
- **Premise card** (right): read-only text.
- **Footer meta**: last-played-at, created-at.
- **Overflow menu** (`⋯`): Rename · End campaign · Delete campaign.

### 5.5 Defensive UI states

- Campaign with `activeSession === null` (edge case from manual SQL or future sittings): the Continue button is disabled; an inline notice shows "Resume not available" with a Delete CTA.

## 6. Out of scope

### 6.1 Deferred to sub-project #5 follow-ups

- Pre-written module style: JSON module format, importer, master tooling to read locations / NPCs / encounters as structured data.
- Hybrid style: skeleton generation, narrative milestones, milestone tracking UI.
- Multiple sessions per campaign (sittings): side adventures, parallel sessions, session archive.
- Automatic session prep: master pre-reading the latest chapter summary and current milestone on session open.
- Premise editing after creation.

### 6.2 Deferred to sub-project #6 (multiplayer)

- Party management (N characters per campaign at the application layer).
- Mode selection (`solo` / `local-mp` / `remote-mp`).
- Invite link / lobby UI.
- Cross-player turn ownership.
- Real-time presence / websocket / pub-sub layer.

## 7. Migration

PR 1 ships migration `0024_campaigns.sql` containing three SQL steps in sequence (transactional), plus a TypeScript helper script for legacy template forking.

### 7.1 Step A — DDL (additive)

```sql
CREATE TYPE campaign_status AS ENUM ('active', 'ended');

CREATE TABLE campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  premise            text NOT NULL,
  style              varchar(16) NOT NULL DEFAULT 'improv',
  language           text,
  tonal_frame        varchar(32),
  engagement_profile jsonb NOT NULL DEFAULT '[]'::jsonb,
  status             campaign_status NOT NULL DEFAULT 'active',
  last_played_at     timestamptz,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_user_status_idx ON campaigns(user_id, status);

ALTER TABLE sessions   ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE;
CREATE INDEX sessions_campaign_idx ON sessions(campaign_id);

ALTER TABLE characters ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE;
CREATE INDEX characters_campaign_idx ON characters(campaign_id);
```

### 7.2 Step B — Backfill (idempotent, transactional)

```sql
BEGIN;

-- 1a. Pair every campaign-less session with a freshly-generated campaign id.
CREATE TEMP TABLE session_to_campaign ON COMMIT DROP AS
SELECT s.id AS session_id, gen_random_uuid() AS campaign_id
FROM sessions s
WHERE s.campaign_id IS NULL;   -- idempotent guard

-- 1b. Insert one campaign row per pair, copying long-lived fields from the session.
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

-- 1c. Point each session at its new campaign.
UPDATE sessions s SET campaign_id = stc.campaign_id
FROM session_to_campaign stc
WHERE stc.session_id = s.id;

-- 2. Instance characters inherit campaign_id from their session.
UPDATE characters c SET campaign_id = s.campaign_id
FROM sessions s
WHERE s.character_id = c.id
  AND c.template_id IS NOT NULL
  AND c.campaign_id IS NULL;

COMMIT;
```

The temp-table pattern is portable (`gen_random_uuid()` is evaluated once per source row, then reused both for the insert and the back-pointer update). Drizzle's `db.execute(sql.raw(...))` accepts the block as-is; alternatively the implementer can split it into three statements within a single Drizzle transaction.

### 7.3 Step B-bis — Legacy template fork (TS script)

For sessions created before commit `29e40ce` (when the fork-on-create logic was introduced), `sessions.character_id` may point to a **template** (`template_id IS NULL`) instead of an instance. The migration cannot leave a template carrying a `campaign_id` (that would violate the §3.3 invariants).

A TypeScript helper (`scripts/migrate-legacy-template-sessions.ts`) runs after the SQL migration:

```
For each session where:
  s.campaign_id IS NOT NULL
  AND characters.id = s.character_id
  AND characters.template_id IS NULL

  1. Deep-copy the template into a new instance row
     (set template_id = original.id, campaign_id = s.campaign_id).
  2. UPDATE sessions SET character_id = <new instance id> WHERE id = s.id.
```

This script is **idempotent** (selects only sessions whose character is still a template) and safe to run multiple times.

### 7.4 Step C — Constraint tightening

```sql
ALTER TABLE sessions ALTER COLUMN campaign_id SET NOT NULL;
```

### 7.5 Application switch (same PR)

- Read path: all queries that previously read `sessions.premise|language|tonal_frame|engagement_profile` now join `campaigns` and read from there.
- Write path: master loop and tool handlers (`set_tonal_frame`, `set_engagement_profile`) write to `campaigns` via the session's `campaign_id`.
- New inserts: `POST /api/campaigns` inserts the full row into `campaigns`. New `sessions` rows leave the deprecated columns at their defaults (or NULL if alterable — see §7.6).
- `POST /api/sessions` and `GET /api/sessions` start returning `410 Gone`.
- `/sessions` and `/sessions/new` routes added to `next.config` as `301` redirects.

### 7.6 Deprecated column behavior in PR 1

Current schema state for the four columns being deprecated:

| Column | Today | Note |
|---|---|---|
| `sessions.premise` | `NOT NULL` | no default |
| `sessions.language` | nullable | — |
| `sessions.tonal_frame` | nullable | — |
| `sessions.engagement_profile` | `NOT NULL DEFAULT '[]'` | — |

To avoid altering NOT NULL constraints in PR 1, the application **double-writes** during the transition window: `POST /api/campaigns` writes the new row to `campaigns` *and* writes the same `premise` / `language` / `tonal_frame` / `engagement_profile` to the new `sessions` row. All read paths use `campaigns`. Data is duplicated until PR 2 drops the columns.

This trades a small write redundancy for migration simplicity: no `ALTER COLUMN DROP NOT NULL` in PR 1, no risk of partial NULLs if a code path is missed during the cutover. Rollback (§7.9) requires no special handling — the deprecated columns still carry the original data.

### 7.7 PR 2 — Drop deprecated columns

Migration `0025_drop_session_deprecated_columns.sql`:

```sql
ALTER TABLE sessions DROP COLUMN premise;
ALTER TABLE sessions DROP COLUMN language;
ALTER TABLE sessions DROP COLUMN tonal_frame;
ALTER TABLE sessions DROP COLUMN engagement_profile;
```

Trigger: ≥1 week of stable production on the new flow, plus all four verification queries from §7.8 returning `0`.

### 7.8 Verification queries (CI + post-deploy)

```sql
-- No orphan session
SELECT COUNT(*) FROM sessions
  WHERE campaign_id IS NULL AND deleted_at IS NULL;
-- expected: 0

-- Every instance has a campaign
SELECT COUNT(*) FROM characters
  WHERE template_id IS NOT NULL AND campaign_id IS NULL;
-- expected: 0

-- No template carries a campaign
SELECT COUNT(*) FROM characters
  WHERE template_id IS NULL AND campaign_id IS NOT NULL;
-- expected: 0

-- No orphan campaign
SELECT COUNT(*) FROM campaigns c
  LEFT JOIN sessions s ON s.campaign_id = c.id
  WHERE s.id IS NULL;
-- expected: 0
```

### 7.9 Rollback

`0024_down.sql`:

```sql
ALTER TABLE characters DROP COLUMN campaign_id;
ALTER TABLE sessions   ALTER COLUMN campaign_id DROP NOT NULL;
ALTER TABLE sessions   DROP COLUMN campaign_id;
DROP TABLE campaigns;
DROP TYPE  campaign_status;
```

No data loss as long as PR 2 has not run: the deprecated `sessions` columns still carry the original premise / language / etc.

## 8. Errors and edge cases

| Case | Behavior |
|---|---|
| `POST /api/campaigns` with `characterTemplateId` not owned by user | `403 Forbidden` |
| `POST /api/campaigns` with template that has `template_id IS NOT NULL` (someone passed an instance id) | `422 Unprocessable Entity`, message "characterTemplateId must reference a template" |
| `PATCH /api/campaigns/[id]` body includes `premise` | `422`, message "premise is immutable" |
| `DELETE /api/campaigns/[id]` while a turn is in flight | Soft delete succeeds; the session lock is released by its 90s TTL; the master loop's final response is discarded (lock owner check) |
| Concurrent `POST /api/campaigns` from two tabs | Both succeed independently — they create separate campaigns; this is expected and not a bug |
| Backfill encounters a session with a missing character | `LEFT JOIN`: name defaults to `"Untitled's tale"`. Logged for inspection. |
| Backfill is re-run after partial success | Idempotent: `WHERE campaign_id IS NULL` guards. No duplicate campaigns. |
| Active session lock not released and migration runs | The migration itself does not touch session locks; backfill only writes new columns. Application code reads through `campaigns` after the migration; the lock semantics are unchanged. |

## 9. Testing

### 9.1 Unit (no DB)

- `src/campaigns/__tests__/default-name.test.ts` — backfill name generator (`${character.name}'s tale`, fallback "Untitled's tale" if character name missing).
- `src/campaigns/__tests__/validate-create-input.test.ts` — Zod (or hand-rolled) body validator: required fields, slug shapes.

### 9.2 DB integration

- Migration `0024` applies cleanly against a snapshot of production data (snapshot stored in `/.snapshots/`).
- Backfill is idempotent: running it twice produces the same row count as once.
- All four verification queries return `0` post-backfill.
- Legacy template sessions: `scripts/migrate-legacy-template-sessions.ts` forks each, no template ends up with `campaign_id`.
- FK cascade: `DELETE campaigns WHERE id = X` removes the session and instance character. (Soft delete in production; cascade is the safety net.)

### 9.3 API integration

- `POST /api/campaigns` — happy path: returns `{ campaign, sessionId }`, both DB rows exist, instance character forked.
- `POST /api/campaigns` — auth + ownership: 401 unauthenticated; 403 on foreign `characterTemplateId`; 422 on instance id.
- `GET /api/campaigns` — filters by `user_id`, sorts by `last_played_at DESC`, supports `?status=`.
- `GET /api/campaigns/[id]` — includes `character` and `activeSession`; 404 on cross-user access.
- `PATCH /api/campaigns/[id]` — rename succeeds, `premise` field in body returns 422.
- `DELETE /api/campaigns/[id]` — soft delete; the active session and the instance character also gain `deleted_at`.
- `POST /api/sessions` — `410 Gone`.
- `GET /api/sessions` — `410 Gone`.
- `POST /api/sessions/[id]/turn` — master loop reads `premise` / `language` from `campaigns` (assert via fixture / spy).
- Tool `set_tonal_frame` (and `set_engagement_profile`) writes to `campaigns`, not `sessions`.

### 9.4 E2E (Playwright)

- **Golden path**: Hub → "New campaign" → wizard step 1 (pick character) → step 2 (pick preset) → "Begin the tale" → game screen reachable → one master turn round-trips → back to hub → click campaign card → "Continue" → game screen state preserved.
- **Rename**: open detail → inline-edit name → save → hub reflects new name.
- **Delete**: open detail → overflow → Delete → confirm → hub no longer shows campaign; visiting `/sessions/[oldSessionId]` returns 404.
- **Legacy redirects**: `GET /sessions` and `GET /sessions/new` return `301` to `/campaigns` and `/campaigns/new` respectively.

### 9.5 Coverage target

- New module `src/campaigns/` ≥ 85% line coverage.
- No regression on existing engine / character-wizard / game-session test suites.

## 10. Acceptance criteria

The minimum slice is "done" when all of these hold:

- [ ] All four §7.8 verification queries return `0` against the production database after the migration runs.
- [ ] Every previously-existing session is reachable via a `/campaigns/[id]` page, with an auto-generated name.
- [ ] Creating a new campaign and playing one master turn works end-to-end (verified by E2E).
- [ ] The master loop reads `premise`, `language`, `tonal_frame`, `engagement_profile` from `campaigns`, not `sessions` (verified by integration test).
- [ ] `POST /api/sessions` and `GET /api/sessions` return `410 Gone`.
- [ ] `/sessions` and `/sessions/new` return `301` redirects.
- [ ] The schema permits N characters per campaign and N sessions per campaign (verified by direct SQL); the application enforces 1 of each in this slice.
- [ ] Coverage on `src/campaigns/` ≥ 85%; no regression on existing test suites.
- [ ] Design handoff alignment: hub matches `design/prototype/app/screens-hub.jsx`'s campaign section; wizard is the simplified 2-step variant of `screens-campaign-wizard.jsx`.

## 11. Open questions deferred to implementation

- Whether to enable inline name editing on the detail page in PR 1 or defer to a small follow-up. (Default: include in PR 1; small additional surface.)
- Whether `GET /api/sessions/[id]` should return the full campaign object embedded, or just a `campaignId` that the client resolves with a separate GET. (Default: embed, to save a round trip.)
- Whether the backfill TS script for legacy template sessions (§7.3) runs inside the same Drizzle migration or as a separate `pnpm` script invoked post-migration. (Default: separate script — keeps SQL migrations data-pure.)
