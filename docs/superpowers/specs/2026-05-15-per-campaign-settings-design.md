# Per-campaign settings (host-owned)

**Date:** 2026-05-15
**Status:** Approved design — ready for implementation plan
**Author:** brainstorming session

## Problem

Game settings (AI provider/model, narration pace, master guidance, image
generation, TTS voice/model, manual rolls, difficulty visibility, etc.) live
today in `users.preferences` and are global per user. In multiplayer this
already half-broke: `getSessionMasterPreferences(sessionId)` reads the
**host's** preferences as a workaround, so guests' settings are silently
ignored.

Two consequences:

1. A user who plays multiple campaigns can't tune the experience per
   campaign — flipping narration pace for a dark gritty one also flips it
   for a high-heroic one.
2. The "host wins" override is invisible: a guest opening `/settings`
   thinks they're changing what they'll experience, but most of those
   choices are dead-letters in any campaign they don't own.

## Goal

Move shared/world-affecting settings onto the campaign, owned by the
creator (`campaigns.userId`). Make the ownership obvious in the UI: only
the host can edit; everyone else sees a read-only snapshot with a banner.

## Scope decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| What moves to campaign | Everything **except** `ttsAutoplay` |
| Where in the UI | New page `/campaigns/[id]/settings` |
| New-campaign defaults | Snapshot from creator's current `users.preferences` at creation time |
| Existing campaigns | One-time backfill snapshot from creator's preferences (migration) |
| Non-host view | Full read-only page with banner *"Solo il creatore della campagna può modificare queste impostazioni"* |
| Global `/settings` link | Removed from top-bar, bottom-nav, UserMenu; old page deleted |
| `ttsAutoplay` location | Toggle in the in-game top bar (sessione di gioco), per viewer |

## Settings classification

**Per-campaign (host-owned, stored in `campaigns.settings`):**
- `aiProvider`, `aiMasterModel`
- `ttsProvider`, `ttsVoice`, `ttsModel`
- `manualRolls`
- `masterGuidanceLevel`
- `showDifficultyNumbers`
- `narrationPace`
- `imageGenerationEnabled`, `imageStylePreset`, `imageStyleCustom`,
  `imageProvider`, `imageModel`

**Per-user (stays in `users.preferences`):**
- `ttsAutoplay`

**Already on the campaign (untouched):**
- `language`, `tonalFrame`, `engagementProfile`, `style`, `premise`

## Architecture

### 1. Data model

Add a `settings: jsonb` column on `campaigns` (mirrors the
`users.preferences` pattern). New `CampaignSettings` interface defined in
`src/db/schema/campaigns.ts`:

```ts
export interface CampaignSettings {
  aiProvider?: 'anthropic' | 'openai' | 'gemini';
  aiMasterModel?: string;
  ttsProvider?: 'openai' | 'gemini';
  ttsVoice?: string;
  ttsModel?: string;
  manualRolls?: boolean;
  masterGuidanceLevel?: 'free' | 'balanced' | 'structured';
  showDifficultyNumbers?: boolean;
  narrationPace?: 'detailed' | 'brisk';
  imageGenerationEnabled?: boolean;
  imageStylePreset?: 'pastel' | 'watercolor' | 'oil' | 'ink' | 'photo' | 'custom';
  imageStyleCustom?: string;
  imageProvider?: 'openai' | 'gemini';
  imageModel?: string;
}
```

`UserPreferences` continues to declare the same shape but in practice only
`ttsAutoplay` is read/written from the UI going forward. The other fields
remain in the type for one release (so the migration code can read them)
and will be pruned in a follow-up.

### 2. Migration

New `drizzle/00XX_*.sql`:

1. `ALTER TABLE campaigns ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;`
2. Backfill: for each campaign row, set `settings` to a JSON snapshot
   built from `users.preferences` of `campaigns.user_id`, **excluding**
   `ttsAutoplay`.
3. (Optional companion migration in a follow-up: drop the
   non-`ttsAutoplay` keys from `users.preferences`. Out of scope for this
   spec.)

Backfill is idempotent: rerunning produces the same snapshot.

### 3. Preference resolution

New helper in `src/lib/preferences.ts`:

```ts
export async function getCampaignSettings(
  campaignId: string,
): Promise<Required<CampaignSettings>>
```

Reads `campaigns.settings` and applies the same cascading defaults already
used by `getResolvedPreferences` (env vars → static defaults). Throws if
the campaign doesn't exist or has been soft-deleted (programmer error
upstream).

Refactor `getSessionMasterPreferences(sessionId)`:
- Signature unchanged.
- Body: look up `sessions.campaignId` (not `sessions.userId`), then call
  `getCampaignSettings(campaignId)`.

`getResolvedPreferences(userId)` keeps existing behavior. In practice only
`ttsAutoplay` is consumed from its result going forward — the other
fields still default-cascade for safety but no UI writes them.

**Call-site review:** every site that decides AI provider/model,
narration tone, image generation, manual rolls, master guidance,
difficulty visibility, or TTS for **shared** synthesis must go through
`getSessionMasterPreferences` / `getCampaignSettings`. Sites that decide
per-viewer behavior (autoplay) keep using `getResolvedPreferences`.

### 4. API

**New: `src/app/api/campaigns/[id]/settings/route.ts`**

- `GET`
  - Auth required. Caller must be a member of the campaign (owner or
    has a character in the party — same predicate as
    `getCampaign(userId, id)`).
  - Response: `{ settings: Required<CampaignSettings>, canEdit: boolean }`.
  - `canEdit = userId === campaign.userId`.
  - Non-member → 403.

- `PUT`
  - Caller must be the campaign owner. Non-host → 403.
  - Body: `Partial<CampaignSettings>`.
  - Validation reuses the existing field-by-field checks from
    `/api/preferences` (provider in set, model in provider's set, voice
    valid for model, guidance level, narration pace, style preset, etc.).
    The shared validation is extracted into
    `validateCampaignSettingsPatch(body)` in `src/lib/preferences.ts` (or
    a sibling file) and consumed by both endpoints.
  - Response: `{ settings: Required<CampaignSettings> }` (fully resolved).

**Modified: `src/app/api/preferences/route.ts`**

- `GET`: unchanged (used to read `ttsAutoplay` client-side).
- `PUT`: accepts only `ttsAutoplay`. Any other key → 400 `unknown-key`
  (fail-fast, surfaces stragglers).

**Membership helper:** the existing `getCampaign(userId, id)` already
encodes the member predicate. We use it for `GET`. For `PUT` we just
compare `campaign.userId === userId`.

### 5. UI

**New: `src/app/(authed)/campaigns/[id]/settings/page.tsx`**

Server component:
1. Auth → `userId`.
2. `getCampaign(userId, id)` → 404 if not a member.
3. Compute `canEdit = userId === campaign.userId`.
4. `getCampaignSettings(id)`.
5. Render `<CampaignSettingsClient settings canEdit campaignId />`.

**New: `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`**

Adapted from the current `settings-client.tsx`:
- Same card layout, same controls for: AI master provider/model, TTS
  provider/voice/model, manual rolls, master guidance, narration pace,
  difficulty numbers, scene images (toggle + provider/model + style
  preset + custom textarea).
- **Removed**: the Auto-play card (moves to the in-game top bar).
- All controls gated on `disabled={!canEdit || busy}`.
- Banner `Card` at the top when `!canEdit`: *"Solo il creatore della
  campagna può modificare queste impostazioni."* (Italian, matches the
  project's user-facing language.)
- `save(patch)` calls `PUT /api/campaigns/${campaignId}/settings`.
- "Back to campaign" link → `/campaigns/${campaignId}`.

**Modified: `src/app/(authed)/campaigns/[id]/page.tsx`**

Add a "Settings" button next to "Continue" in the header row. Visible to
all members. Links to `/campaigns/[id]/settings`.

**Modified: in-game top bar (sessione di gioco)**

Locate the top-bar component used by `src/app/(authed)/sessions/[id]/...`
and add a small autoplay toggle (icon `volume`, like today's settings
page). Reads `ttsAutoplay` from server-resolved preferences at initial
render, toggles via `PUT /api/preferences { ttsAutoplay }`. Per-viewer,
no host/membership restrictions.

**Deleted:**
- `src/app/(authed)/settings/page.tsx`
- `src/app/(authed)/settings/settings-client.tsx`
- `src/components/ui/settings-link.tsx`
- `settings` entry in `src/components/layout/bottom-nav.tsx`
- `goToSettings` function + `MenuButton` in
  `src/components/layout/user-menu.tsx`
- `<SettingsLink />` import + render in
  `src/components/layout/top-bar.tsx`

### 6. Edge cases

- **Empty `settings` blob** (anomaly even after migration):
  `getCampaignSettings` applies the same default cascade as
  `getResolvedPreferences`. No surprises.
- **Host switches provider mid-session**: the next master turn reads
  fresh from the campaign and uses the new value. Identical to today's
  behavior when an owner changed `/settings`.
- **TTS cache invalidation**: verify the existing `tts-cache` key
  already includes voice + model. If not, add them. The cache should
  not be keyed by user — keying by `(sessionId, messageId, voice,
  model)` (or `(messageId, voice, model)`) is correct now that voice/
  model are per-campaign.
- **Non-member opens the settings page**: 404 (same predicate as the
  campaign detail page).
- **Patch contains an unknown key**: 400, no partial save.

## Testing

- **Unit (`vitest`)**
  - `getCampaignSettings` default cascade (env → static), and overrides
    from a populated jsonb.
  - `validateCampaignSettingsPatch`: valid patch, invalid provider,
    invalid model-for-provider, invalid voice-for-model, etc.
- **API integration**
  - `GET /api/campaigns/[id]/settings`: owner OK, member OK, non-member
    403.
  - `PUT`: owner OK, member 403, non-member 403, invalid patch 400.
  - `PUT /api/preferences` with non-`ttsAutoplay` key → 400.
- **Migration smoke**
  - Seed a campaign with a creator who has non-default preferences.
    Run the migration. Assert `campaigns.settings` matches the
    creator's preferences excluding `ttsAutoplay`.
- **E2E (Playwright)**
  - Host opens `/campaigns/[id]/settings`, changes narration pace from
    `detailed` to `brisk`, returns to the session, next master turn
    uses the new value.
  - Guest (second user with a character in the party) opens the same
    URL, sees all controls disabled and the banner.
  - Guest visits without a character → 404.

## Non-goals

- Pruning the deprecated keys from `users.preferences` (follow-up).
- A way to copy settings from one campaign to another / templates
  (could be useful, not in this scope).
- Allowing the host to lock a guest's autoplay (still per-viewer).
- A "default settings for new campaigns" surface (current behavior
  already snapshots from creator's prefs at creation; that's enough).
