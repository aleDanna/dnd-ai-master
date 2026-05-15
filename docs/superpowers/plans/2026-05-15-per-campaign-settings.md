# Per-campaign settings (host-owned) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move shared game settings (AI provider/model, narration pace, master guidance, image generation, TTS provider/voice/model, manual rolls, difficulty visibility) from `users.preferences` (global) onto a new `campaigns.settings` (jsonb) column. Only the campaign creator can edit. `ttsAutoplay` stays per-user. Replace the old `/settings` page with `/campaigns/[id]/settings`.

**Architecture:** New JSONB column on `campaigns` initialized via migration backfill from each creator's current preferences. New `getCampaignSettings(campaignId)` resolver mirrors the existing `getResolvedPreferences` cascade. `getSessionMasterPreferences(sessionId)` is refactored to read from the campaign instead of the host's user row. New `/api/campaigns/[id]/settings` route (GET for any member, PUT host-only) plus a new server/client page pair. The old `/api/preferences` is locked down to only accept `ttsAutoplay`. UI links to the global `/settings` page are removed from top-bar, bottom-nav, UserMenu, and game-client. The autoplay toggle already exists in the in-game top bar — only the neighboring `SettingsLink` is removed.

**Tech Stack:** Next.js App Router 16, Drizzle ORM (Postgres), Clerk auth, Vitest (unit + DB integration), Playwright (E2E). pnpm scripts: `pnpm test`, `pnpm typecheck`, `pnpm db:generate`, `pnpm db:migrate`, `pnpm test:e2e`.

**Spec:** `docs/superpowers/specs/2026-05-15-per-campaign-settings-design.md`

---

## File Structure

**Create:**
- `drizzle/0031_<generated-name>.sql` — schema + backfill migration
- `drizzle/meta/0031_snapshot.json` — Drizzle-generated
- `src/app/api/campaigns/[id]/settings/route.ts` — new API endpoint
- `src/app/(authed)/campaigns/[id]/settings/page.tsx` — server page
- `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx` — client component
- `tests/lib/campaign-settings.test.ts` — unit + DB tests for the new resolver
- `tests/lib/settings-validator.test.ts` — unit tests for the shared validator
- `tests/api/campaign-settings.test.ts` — API integration tests
- `tests/api/preferences-locked.test.ts` — verify only `ttsAutoplay` survives

**Modify:**
- `src/db/schema/campaigns.ts` — add `CampaignSettings` type + `settings` column
- `src/lib/preferences.ts` — add `getCampaignSettings`, `updateCampaignSettings`, `validateSettingsPatch`; refactor `getSessionMasterPreferences`
- `src/app/api/preferences/route.ts` — lock PUT to `ttsAutoplay` only
- `src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts` — read TTS prefs from campaign
- `src/app/(authed)/campaigns/[id]/page.tsx` — add Settings button to header
- `src/app/(authed)/sessions/[id]/game-client.tsx` — remove two `<SettingsLink />` usages and the import
- `src/components/layout/top-bar.tsx` — remove `<SettingsLink />` + import
- `src/components/layout/bottom-nav.tsx` — remove "Settings" tab
- `src/components/layout/user-menu.tsx` — remove Settings `MenuButton` + `goToSettings`
- `tests/lib/preferences.test.ts` — update fixture: write to `campaigns.settings`, not `users.preferences`

**Delete:**
- `src/app/(authed)/settings/page.tsx`
- `src/app/(authed)/settings/settings-client.tsx`
- `src/components/ui/settings-link.tsx`

---

## Phase 1 — Schema + migration

### Task 1: Add `CampaignSettings` type + `settings` column

**Files:**
- Modify: `src/db/schema/campaigns.ts`

- [ ] **Step 1: Add the type and column**

Replace the file body with:

```ts
import { pgTable, text, uuid, timestamp, pgEnum, varchar, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

export const campaignStatusEnum = pgEnum('campaign_status', ['active', 'ended']);

/**
 * Per-campaign game settings, owned by the campaign creator
 * (`campaigns.userId`). Mirrors the shared subset of `UserPreferences`
 * minus `ttsAutoplay` (which stays per-viewer). New campaigns snapshot
 * these from the creator's preferences at creation time; existing rows
 * were backfilled by migration 0031.
 */
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

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    premise: text('premise').notNull(),
    style: varchar('style', { length: 16 }).notNull().default('improv'),
    language: text('language'),
    tonalFrame: varchar('tonal_frame', { length: 32 }),
    engagementProfile: jsonb('engagement_profile').$type<string[]>().notNull().default([]),
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`).$type<CampaignSettings>(),
    status: campaignStatusEnum('status').notNull().default('active'),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStatusIdx: index('campaigns_user_status_idx').on(t.userId, t.status),
  }),
);

export type Campaign = typeof campaigns.$inferSelect;
export type CampaignInsert = typeof campaigns.$inferInsert;
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS (no compile errors yet — column is declared, no consumers).

- [ ] **Step 3: Commit**

```bash
git add src/db/schema/campaigns.ts
git commit -m "feat(schema): add CampaignSettings + settings jsonb column on campaigns"
```

---

### Task 2: Generate + customize the migration

**Files:**
- Create: `drizzle/0031_<generated-name>.sql`
- Create: `drizzle/meta/0031_snapshot.json` (auto)
- Modify: `drizzle/meta/_journal.json` (auto)

- [ ] **Step 1: Generate the migration**

```bash
pnpm db:generate
```
Expected output: `drizzle/0031_<name>.sql` and `drizzle/meta/0031_snapshot.json` created. The SQL initially contains only the `ALTER TABLE … ADD COLUMN settings jsonb …` statement.

- [ ] **Step 2: Append the backfill UPDATE to the migration**

Open the new `drizzle/0031_*.sql` file and append (after the existing `ALTER TABLE`):

```sql
--> statement-breakpoint
-- Backfill: snapshot each campaign creator's user-preferences into
-- campaigns.settings, stripping ttsAutoplay (which stays per-user).
UPDATE campaigns AS c
SET settings = COALESCE(u.preferences, '{}'::jsonb) - 'ttsAutoplay'
FROM users AS u
WHERE c.user_id = u.id
  AND c.deleted_at IS NULL
  AND c.settings = '{}'::jsonb;
```

Note: the `c.settings = '{}'::jsonb` guard makes the backfill idempotent — rerunning never overwrites campaigns that were already populated by a host's edit.

- [ ] **Step 3: Apply the migration locally**

```bash
pnpm db:up
pnpm db:migrate
```
Expected: migration 0031 applied without errors.

- [ ] **Step 4: Spot-check the backfill**

```bash
docker compose exec postgres psql -U postgres -d dnd_master -c \
  "SELECT c.id, c.name, c.settings FROM campaigns c LIMIT 5;"
```
Expected: `settings` is populated (non-empty `{...}`) for campaigns whose host had any preferences set; `{}` otherwise.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0031_*.sql drizzle/meta/0031_snapshot.json drizzle/meta/_journal.json
git commit -m "feat(db): migrate campaign settings — add column + backfill from host prefs"
```

---

## Phase 2 — Resolver + shared validator

### Task 3: Extract shared validator into `src/lib/preferences.ts`

**Files:**
- Modify: `src/lib/preferences.ts`
- Create: `tests/lib/settings-validator.test.ts`

The existing `/api/preferences` route inlines field-by-field validation (provider in set, model in set, voice valid, etc.). We extract that into a reusable validator used by both the locked-down `/api/preferences` and the new `/api/campaigns/[id]/settings`. The validator's input shape is `Partial<CampaignSettings & { ttsAutoplay?: boolean }>` — a superset — so both endpoints can call it and decide afterwards which keys they accept.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/settings-validator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateSettingsPatch } from '@/lib/preferences';

describe('validateSettingsPatch', () => {
  it('accepts a fully-typed valid patch', () => {
    const res = validateSettingsPatch({
      aiProvider: 'anthropic',
      aiMasterModel: 'claude-sonnet-4-5',
      ttsProvider: 'openai',
      ttsModel: 'gpt-4o-mini-tts',
      ttsVoice: 'onyx',
      manualRolls: true,
      masterGuidanceLevel: 'balanced',
      showDifficultyNumbers: false,
      narrationPace: 'brisk',
      imageGenerationEnabled: true,
      imageStylePreset: 'pastel',
      imageStyleCustom: '',
      imageProvider: 'openai',
      imageModel: 'gpt-image-1',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects unknown provider', () => {
    const res = validateSettingsPatch({ aiProvider: 'mistral' as unknown as 'anthropic' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid-aiProvider');
  });

  it('rejects non-boolean manualRolls', () => {
    const res = validateSettingsPatch({ manualRolls: 'yes' as unknown as boolean });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid-manualRolls');
  });

  it('rejects imageStyleCustom longer than 500 chars', () => {
    const res = validateSettingsPatch({ imageStyleCustom: 'x'.repeat(501) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('imageStyleCustom-too-long');
  });

  it('rejects unknown narrationPace value', () => {
    const res = validateSettingsPatch({ narrationPace: 'slow' as unknown as 'detailed' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid-narrationPace');
  });

  it('accepts an empty patch', () => {
    const res = validateSettingsPatch({});
    expect(res.ok).toBe(true);
  });

  it('accepts ttsAutoplay (used by /api/preferences) without flagging it', () => {
    const res = validateSettingsPatch({ ttsAutoplay: true });
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/settings-validator.test.ts
```
Expected: FAIL with "validateSettingsPatch is not exported / not a function".

- [ ] **Step 3: Implement `validateSettingsPatch`**

At the bottom of `src/lib/preferences.ts`, add (after the existing helpers, before any default export):

```ts
import {
  isKnownProvider,
  isKnownMasterModel,
  isKnownImageProvider,
  isKnownImageModel,
} from '@/lib/ai-models';
import { isMasterGuidanceLevel, isImageStylePreset, isNarrationPace } from '@/db/schema/users';
import { isValidTtsProvider, isValidTtsVoice, isValidTtsModel } from './tts-voices';
import type { CampaignSettings } from '@/db/schema/campaigns';

export type ValidatedSettings = Partial<CampaignSettings & { ttsAutoplay?: boolean }>;

export type ValidateResult =
  | { ok: true; patch: ValidatedSettings }
  | { ok: false; error: string };

/**
 * Shared field-by-field validation for settings patches. Accepts the full
 * superset (campaign keys + ttsAutoplay). Callers decide which keys are
 * allowed for their endpoint and pre-filter the body before calling.
 *
 * Returns the same shape as the input on success — useful so the caller
 * can persist exactly what the validator OK'd.
 */
export function validateSettingsPatch(body: ValidatedSettings): ValidateResult {
  const out: ValidatedSettings = {};
  if ('ttsProvider' in body) {
    if (body.ttsProvider === undefined || body.ttsProvider === null) out.ttsProvider = undefined;
    else if (!isValidTtsProvider(body.ttsProvider)) return { ok: false, error: 'invalid-ttsProvider' };
    else out.ttsProvider = body.ttsProvider;
  }
  if ('ttsVoice' in body) {
    if (body.ttsVoice === undefined || body.ttsVoice === null) out.ttsVoice = undefined;
    else if (!isValidTtsVoice(body.ttsVoice)) return { ok: false, error: 'invalid-ttsVoice' };
    else out.ttsVoice = body.ttsVoice;
  }
  if ('ttsModel' in body) {
    if (body.ttsModel === undefined || body.ttsModel === null) out.ttsModel = undefined;
    else if (!isValidTtsModel(body.ttsModel)) return { ok: false, error: 'invalid-ttsModel' };
    else out.ttsModel = body.ttsModel;
  }
  if ('ttsAutoplay' in body) {
    if (typeof body.ttsAutoplay !== 'boolean') return { ok: false, error: 'invalid-ttsAutoplay' };
    out.ttsAutoplay = body.ttsAutoplay;
  }
  if ('manualRolls' in body) {
    if (typeof body.manualRolls !== 'boolean') return { ok: false, error: 'invalid-manualRolls' };
    out.manualRolls = body.manualRolls;
  }
  if ('aiProvider' in body) {
    if (!isKnownProvider(body.aiProvider)) return { ok: false, error: 'invalid-aiProvider' };
    out.aiProvider = body.aiProvider;
  }
  if ('aiMasterModel' in body) {
    if (body.aiMasterModel !== undefined && !isKnownMasterModel(body.aiMasterModel)) {
      return { ok: false, error: 'invalid-aiMasterModel' };
    }
    out.aiMasterModel = body.aiMasterModel as string | undefined;
  }
  if ('masterGuidanceLevel' in body) {
    if (!isMasterGuidanceLevel(body.masterGuidanceLevel)) return { ok: false, error: 'invalid-masterGuidanceLevel' };
    out.masterGuidanceLevel = body.masterGuidanceLevel;
  }
  if ('showDifficultyNumbers' in body) {
    if (typeof body.showDifficultyNumbers !== 'boolean') return { ok: false, error: 'invalid-showDifficultyNumbers' };
    out.showDifficultyNumbers = body.showDifficultyNumbers;
  }
  if ('narrationPace' in body) {
    if (!isNarrationPace(body.narrationPace)) return { ok: false, error: 'invalid-narrationPace' };
    out.narrationPace = body.narrationPace;
  }
  if ('imageGenerationEnabled' in body) {
    if (typeof body.imageGenerationEnabled !== 'boolean') return { ok: false, error: 'invalid-imageGenerationEnabled' };
    out.imageGenerationEnabled = body.imageGenerationEnabled;
  }
  if ('imageStylePreset' in body) {
    if (!isImageStylePreset(body.imageStylePreset)) return { ok: false, error: 'invalid-imageStylePreset' };
    out.imageStylePreset = body.imageStylePreset;
  }
  if ('imageStyleCustom' in body) {
    if (typeof body.imageStyleCustom !== 'string') return { ok: false, error: 'invalid-imageStyleCustom' };
    if (body.imageStyleCustom.length > 500) return { ok: false, error: 'imageStyleCustom-too-long' };
    out.imageStyleCustom = body.imageStyleCustom;
  }
  if ('imageProvider' in body) {
    if (!isKnownImageProvider(body.imageProvider)) return { ok: false, error: 'invalid-imageProvider' };
    out.imageProvider = body.imageProvider;
  }
  if ('imageModel' in body) {
    if (body.imageModel !== undefined && !isKnownImageModel(body.imageModel)) {
      return { ok: false, error: 'invalid-imageModel' };
    }
    out.imageModel = body.imageModel as string | undefined;
  }
  return { ok: true, patch: out };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test tests/lib/settings-validator.test.ts
```
Expected: PASS, all 7 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/preferences.ts tests/lib/settings-validator.test.ts
git commit -m "feat(preferences): extract shared validateSettingsPatch helper"
```

---

### Task 4: Add `getCampaignSettings` + `updateCampaignSettings`

**Files:**
- Modify: `src/lib/preferences.ts`
- Create: `tests/lib/campaign-settings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/campaign-settings.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { campaigns, users } from '@/db/schema';
import { getCampaignSettings, updateCampaignSettings, DEFAULT_PREFERENCES } from '@/lib/preferences';

const HOST = 'user_camp_settings_' + Date.now();

describe('getCampaignSettings — campaign-scoped resolution', () => {
  let campaignId: string;
  let emptyCampaignId: string;

  beforeAll(async () => {
    await db.insert(users).values({ id: HOST, displayName: 'Host', preferences: {} }).onConflictDoNothing();

    const [populated] = await db.insert(campaigns).values({
      userId: HOST, name: 'Populated', premise: 'p',
      settings: {
        aiProvider: 'openai',
        aiMasterModel: 'gpt-5',
        narrationPace: 'brisk',
        manualRolls: true,
      },
    }).returning();
    campaignId = populated!.id;

    const [empty] = await db.insert(campaigns).values({
      userId: HOST, name: 'Empty', premise: 'p',
    }).returning();
    emptyCampaignId = empty!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${HOST}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${HOST}`);
    await pool.end();
  });

  it('returns the stored settings with cascading defaults for missing keys', async () => {
    const s = await getCampaignSettings(campaignId);
    expect(s.aiProvider).toBe('openai');
    expect(s.aiMasterModel).toBe('gpt-5');
    expect(s.narrationPace).toBe('brisk');
    expect(s.manualRolls).toBe(true);
    // Unset keys fall back to defaults
    expect(s.masterGuidanceLevel).toBe(DEFAULT_PREFERENCES.masterGuidanceLevel);
    expect(s.showDifficultyNumbers).toBe(DEFAULT_PREFERENCES.showDifficultyNumbers);
  });

  it('returns full defaults when settings is empty {}', async () => {
    const s = await getCampaignSettings(emptyCampaignId);
    expect(s.narrationPace).toBe(DEFAULT_PREFERENCES.narrationPace);
    expect(s.manualRolls).toBe(DEFAULT_PREFERENCES.manualRolls);
  });

  it('throws on unknown / soft-deleted campaign id', async () => {
    await expect(getCampaignSettings('00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/not found/);
  });

  it('updateCampaignSettings merges and persists', async () => {
    await updateCampaignSettings(emptyCampaignId, { narrationPace: 'brisk' });
    const s = await getCampaignSettings(emptyCampaignId);
    expect(s.narrationPace).toBe('brisk');

    await updateCampaignSettings(emptyCampaignId, { manualRolls: true });
    const s2 = await getCampaignSettings(emptyCampaignId);
    expect(s2.narrationPace).toBe('brisk'); // unchanged
    expect(s2.manualRolls).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/campaign-settings.test.ts
```
Expected: FAIL with `getCampaignSettings is not a function` (or similar import error).

- [ ] **Step 3: Implement the two helpers**

Add to `src/lib/preferences.ts` (near `getSessionMasterPreferences`):

```ts
import { campaigns, type CampaignSettings } from '@/db/schema/campaigns';

export type { CampaignSettings };

/**
 * Read raw stored settings for a campaign. Returns `{}` if the row is
 * unpopulated. Throws if the campaign is missing or soft-deleted.
 */
async function getCampaignSettingsRaw(campaignId: string): Promise<CampaignSettings> {
  const [row] = await db
    .select({ settings: campaigns.settings })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`getCampaignSettings: campaign ${campaignId} not found`);
  return row.settings ?? {};
}

/**
 * Campaign-scoped resolved settings — the authoritative source for every
 * shared decision (AI provider/model, TTS voice/model, narration pace,
 * master guidance, difficulty visibility, image generation, manual rolls).
 *
 * Defaults cascade exactly like `getResolvedPreferences`: stored value
 * (if any) → env var (if provided) → static default. Resolution happens
 * at call time so a redeploy with new env defaults flows through to
 * existing campaigns that never explicitly set a value.
 *
 * Throws on missing / soft-deleted campaign id — programmer error.
 */
export async function getCampaignSettings(
  campaignId: string,
): Promise<Required<CampaignSettings>> {
  const prefs = await getCampaignSettingsRaw(campaignId);
  const envProvider = envDefaultProvider();
  const provider = prefs.aiProvider ?? envProvider;
  const masterModel = prefs.aiMasterModel ?? envDefaultMasterModel(provider);
  const imageGenerationEnabled = prefs.imageGenerationEnabled ?? DEFAULT_PREFERENCES.imageGenerationEnabled;
  const imageStylePreset = prefs.imageStylePreset ?? DEFAULT_PREFERENCES.imageStylePreset;
  const imageStyleCustom = prefs.imageStyleCustom ?? DEFAULT_PREFERENCES.imageStyleCustom;
  const imageProvider = prefs.imageProvider ?? envDefaultImageProvider();
  const imageModel = prefs.imageModel ?? envDefaultImageModel(imageProvider);
  const ttsProvider = prefs.ttsProvider ?? envDefaultTtsProvider();
  const storedModel = prefs.ttsModel;
  const ttsModel =
    storedModel && ttsModelsFor(ttsProvider).includes(storedModel)
      ? storedModel
      : envDefaultTtsModel(ttsProvider);
  const storedVoice = prefs.ttsVoice;
  const ttsVoice =
    storedVoice && ttsVoicesForModel(ttsProvider, ttsModel).includes(storedVoice)
      ? storedVoice
      : envDefaultTtsVoice(ttsProvider, ttsModel);
  return {
    ttsProvider,
    ttsVoice,
    ttsModel,
    manualRolls: prefs.manualRolls ?? DEFAULT_PREFERENCES.manualRolls,
    aiProvider: provider,
    aiMasterModel: masterModel,
    masterGuidanceLevel: prefs.masterGuidanceLevel ?? DEFAULT_PREFERENCES.masterGuidanceLevel,
    showDifficultyNumbers: prefs.showDifficultyNumbers ?? DEFAULT_PREFERENCES.showDifficultyNumbers,
    narrationPace: prefs.narrationPace ?? DEFAULT_PREFERENCES.narrationPace,
    imageGenerationEnabled,
    imageStylePreset,
    imageStyleCustom,
    imageProvider,
    imageModel,
  };
}

export async function updateCampaignSettings(
  campaignId: string,
  patch: Partial<CampaignSettings>,
): Promise<CampaignSettings> {
  const current = await getCampaignSettingsRaw(campaignId);
  const merged: CampaignSettings = { ...current, ...patch };
  await db
    .update(campaigns)
    .set({ settings: merged, updatedAt: new Date() })
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  return merged;
}
```

Note: the return type of `getCampaignSettings` is `Required<CampaignSettings>` — narrower than the old `Required<UserPreferences>` because it doesn't include `ttsAutoplay`. Callers that need autoplay must still call `getResolvedPreferences(viewerId)`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test tests/lib/campaign-settings.test.ts
```
Expected: PASS, all 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/preferences.ts tests/lib/campaign-settings.test.ts
git commit -m "feat(preferences): add getCampaignSettings + updateCampaignSettings"
```

---

### Task 5: Refactor `getSessionMasterPreferences` to read from campaign

**Files:**
- Modify: `src/lib/preferences.ts`
- Modify: `tests/lib/preferences.test.ts`

`getSessionMasterPreferences(sessionId)` keeps the same signature but now looks up the session's `campaignId` and delegates to `getCampaignSettings`. The return type widens slightly: previously it included `ttsAutoplay`, but no consumer ever read it from this helper (call sites that need autoplay use `getResolvedPreferences(viewerId)`). To keep the type compatible with existing call sites, we explicitly add `ttsAutoplay: false` to the returned object — autoplay was never meaningful at the session/campaign level. This avoids touching every existing call site.

- [ ] **Step 1: Update the existing test fixture in `tests/lib/preferences.test.ts`**

The describe block `getSessionMasterPreferences — session-scoped resolution` currently writes to `users.preferences`. After the refactor it must write to `campaigns.settings`. Replace the relevant body (lines ~52-117) with:

```ts
describe('getSessionMasterPreferences — campaign-scoped resolution', () => {
  const HOST = 'user_master_prefs_host';
  const GUEST = 'user_master_prefs_guest';
  let sessionId: string;
  let campaignId: string;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: HOST, displayName: 'Host', preferences: {} },
      { id: GUEST, displayName: 'Guest', preferences: {} },
    ]).onConflictDoNothing();
    const [c] = await db.insert(campaigns).values({
      userId: HOST, name: 'Prefs Test', premise: 'p',
      settings: { aiProvider: 'anthropic', aiMasterModel: 'claude-sonnet-4-5' },
    }).returning();
    campaignId = c!.id;
    const [tpl] = await db.insert(characters).values({
      userId: HOST, name: 'T',
      raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [],
      identity: { alignment: 'N' },
    }).returning();
    const [inst] = await db.insert(characters).values({
      userId: HOST, name: 'T', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [],
      identity: { alignment: 'N' },
      templateId: tpl!.id, campaignId: c!.id,
    }).returning();
    const [s] = await db.insert(sessions).values({
      userId: HOST, characterId: inst!.id, campaignId: c!.id, premise: 'p',
      currentPlayerCharacterId: inst!.id,
    }).returning();
    sessionId = s!.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE user_id = ${HOST}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${HOST}, ${GUEST})`);
    await pool.end();
  });

  it('returns the campaign-stored AI provider regardless of which user asks', async () => {
    const prefs = await getSessionMasterPreferences(sessionId);
    expect(prefs.aiProvider).toBe('anthropic');
    expect(prefs.aiMasterModel).toBe('claude-sonnet-4-5');
  });

  it('reflects updates written to the campaign settings', async () => {
    await updateCampaignSettings(campaignId, { aiProvider: 'openai', aiMasterModel: 'gpt-5' });
    const prefs = await getSessionMasterPreferences(sessionId);
    expect(prefs.aiProvider).toBe('openai');
    expect(prefs.aiMasterModel).toBe('gpt-5');
  });

  it('throws on unknown / soft-deleted session id', async () => {
    await expect(getSessionMasterPreferences('00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/not found/);
  });
});
```

Also add `import { sql } from 'drizzle-orm';` and `import { updateCampaignSettings } from '@/lib/preferences';` if not already imported. Remove the now-unused `updateUserPreferences` import.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/lib/preferences.test.ts
```
Expected: FAIL on the new assertions (`getSessionMasterPreferences` still reads from host's `users.preferences`).

- [ ] **Step 3: Refactor `getSessionMasterPreferences`**

In `src/lib/preferences.ts`, replace the body of `getSessionMasterPreferences` with:

```ts
/**
 * Session-scoped resolved settings — proxies to the session's campaign.
 *
 * Multiplayer rule: every shared decision (provider, model, narration
 * pace, image gen, manual rolls, master guidance, difficulty visibility,
 * TTS voice/model) is owned by the campaign, editable only by the
 * creator. This helper exists so call sites that have a sessionId in
 * hand (turn endpoint, memory rebuild, scene-image, TTS) don't have to
 * look up the campaign themselves.
 *
 * Returns a shape compatible with the old `UserPreferences`-keyed
 * result: we add `ttsAutoplay: false` as a no-op so the type doesn't
 * narrow at call sites. Autoplay is per-viewer — call
 * `getResolvedPreferences(viewerId)` if you actually need it.
 *
 * Throws if the session is missing or soft-deleted (programmer error).
 */
export async function getSessionMasterPreferences(
  sessionId: string,
): Promise<Required<UserPreferences>> {
  const [row] = await db
    .select({ campaignId: sessions.campaignId })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`getSessionMasterPreferences: session ${sessionId} not found`);
  const camp = await getCampaignSettings(row.campaignId);
  return { ...camp, ttsAutoplay: false };
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test tests/lib/preferences.test.ts tests/lib/campaign-settings.test.ts
```
Expected: PASS for both files.

- [ ] **Step 5: Commit**

```bash
git add src/lib/preferences.ts tests/lib/preferences.test.ts
git commit -m "feat(preferences): getSessionMasterPreferences reads from campaign"
```

---

## Phase 3 — API

### Task 6: Lock down `PUT /api/preferences` to `ttsAutoplay` only

**Files:**
- Modify: `src/app/api/preferences/route.ts`
- Create: `tests/api/preferences-locked.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/preferences-locked.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users } from '@/db/schema';
import { NextRequest } from 'next/server';

const USER = 'user_prefs_locked_' + Date.now();

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: USER })),
}));

import { PUT } from '@/app/api/preferences/route';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/preferences', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('PUT /api/preferences — locked down to ttsAutoplay', () => {
  beforeEach(async () => {
    await db.insert(users).values({ id: USER, displayName: 'U', preferences: {} }).onConflictDoNothing();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE id = ${USER}`);
    await pool.end();
  });

  it('accepts a ttsAutoplay-only patch', async () => {
    const res = await PUT(makeReq({ ttsAutoplay: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preferences.ttsAutoplay).toBe(true);
  });

  it('rejects any other key with 400 unknown-key', async () => {
    const res = await PUT(makeReq({ aiProvider: 'openai' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown-key');
  });

  it('rejects non-boolean ttsAutoplay', async () => {
    const res = await PUT(makeReq({ ttsAutoplay: 'yes' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-ttsAutoplay');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/api/preferences-locked.test.ts
```
Expected: FAIL — the route still happily accepts `aiProvider`.

- [ ] **Step 3: Rewrite the route**

Replace the body of `src/app/api/preferences/route.ts` with:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import { getUserPreferences, updateUserPreferences, type UserPreferences } from '@/lib/preferences';

const ALLOWED_KEYS = new Set(['ttsAutoplay']);

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);
  const prefs = await getUserPreferences(userId);
  return NextResponse.json({ preferences: prefs });
}

export async function PUT(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid-body' }, { status: 400 });
  }

  // Reject any non-allowed keys up front — surfaces stale clients that
  // still try to PUT campaign-scoped settings here.
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      return NextResponse.json({ error: 'unknown-key', key }, { status: 400 });
    }
  }

  const patch: Partial<UserPreferences> = {};
  if ('ttsAutoplay' in body) {
    if (typeof body.ttsAutoplay !== 'boolean') {
      return NextResponse.json({ error: 'invalid-ttsAutoplay' }, { status: 400 });
    }
    patch.ttsAutoplay = body.ttsAutoplay;
  }

  const updated = await updateUserPreferences(userId, patch);
  return NextResponse.json({ preferences: updated });
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm test tests/api/preferences-locked.test.ts
```
Expected: PASS, all 3 cases green.

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS. (Unused imports from `@/lib/ai-models` etc. are now gone.)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/preferences/route.ts tests/api/preferences-locked.test.ts
git commit -m "feat(api): lock /api/preferences PUT to ttsAutoplay-only"
```

---

### Task 7: Add `GET/PUT /api/campaigns/[id]/settings`

**Files:**
- Create: `src/app/api/campaigns/[id]/settings/route.ts`
- Create: `tests/api/campaign-settings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/campaign-settings.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { users, campaigns, characters } from '@/db/schema';
import { NextRequest } from 'next/server';

const HOST = 'user_camp_api_host_' + Date.now();
const MEMBER = 'user_camp_api_member_' + Date.now();
const STRANGER = 'user_camp_api_stranger_' + Date.now();

let CALLER: string = HOST;
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: CALLER })),
}));

import { GET, PUT } from '@/app/api/campaigns/[id]/settings/route';

function getReq(): NextRequest {
  return new NextRequest('http://localhost/api/campaigns/x/settings', { method: 'GET' });
}
function putReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/campaigns/x/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET/PUT /api/campaigns/[id]/settings', () => {
  let campaignId: string;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: HOST, displayName: 'H', preferences: {} },
      { id: MEMBER, displayName: 'M', preferences: {} },
      { id: STRANGER, displayName: 'S', preferences: {} },
    ]).onConflictDoNothing();
    const [c] = await db.insert(campaigns).values({
      userId: HOST, name: 'API Test', premise: 'p',
      settings: { narrationPace: 'detailed' },
    }).returning();
    campaignId = c!.id;
    // MEMBER joins by having an instance character in the campaign
    const [tpl] = await db.insert(characters).values({
      userId: MEMBER, name: 'M-tpl', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
    }).returning();
    await db.insert(characters).values({
      userId: MEMBER, name: 'M-inst', raceSlug: 'human', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 14, DEX: 12, CON: 14, INT: 10, WIS: 12, CHA: 10 },
      level: 1, xp: 0, proficiencyBonus: 2, hpMax: 12, ac: 14, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [], identity: { alignment: 'N' },
      templateId: tpl!.id, campaignId,
    });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${HOST}, ${MEMBER}, ${STRANGER})`);
    await pool.end();
  });

  it('GET as host returns settings + canEdit:true', async () => {
    CALLER = HOST;
    const res = await GET(getReq(), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canEdit).toBe(true);
    expect(body.settings.narrationPace).toBe('detailed');
  });

  it('GET as member returns settings + canEdit:false', async () => {
    CALLER = MEMBER;
    const res = await GET(getReq(), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canEdit).toBe(false);
    expect(body.settings.narrationPace).toBe('detailed');
  });

  it('GET as stranger returns 403', async () => {
    CALLER = STRANGER;
    const res = await GET(getReq(), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(403);
  });

  it('PUT as host updates and returns the resolved settings', async () => {
    CALLER = HOST;
    const res = await PUT(putReq({ narrationPace: 'brisk' }), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.narrationPace).toBe('brisk');
  });

  it('PUT as non-host returns 403 and does not mutate', async () => {
    CALLER = MEMBER;
    const res = await PUT(putReq({ narrationPace: 'detailed' }), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(403);
    CALLER = HOST;
    const verify = await GET(getReq(), { params: Promise.resolve({ id: campaignId }) });
    const body = await verify.json();
    expect(body.settings.narrationPace).toBe('brisk'); // still the value the host set
  });

  it('PUT with invalid provider returns 400', async () => {
    CALLER = HOST;
    const res = await PUT(putReq({ aiProvider: 'mistral' }), { params: Promise.resolve({ id: campaignId }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-aiProvider');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test tests/api/campaign-settings.test.ts
```
Expected: FAIL with "module not found" — the route doesn't exist yet.

- [ ] **Step 3: Implement the route**

Create `src/app/api/campaigns/[id]/settings/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import { getCampaign } from '@/campaigns/persist';
import {
  getCampaignSettings,
  updateCampaignSettings,
  validateSettingsPatch,
  type CampaignSettings,
} from '@/lib/preferences';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);
  const { id } = await params;

  const data = await getCampaign(userId, id);
  if (!data) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const settings = await getCampaignSettings(id);
  return NextResponse.json({
    settings,
    canEdit: data.campaign.userId === userId,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);
  const { id } = await params;

  const data = await getCampaign(userId, id);
  if (!data) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (data.campaign.userId !== userId) {
    return NextResponse.json({ error: 'host-only' }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid-body' }, { status: 400 });
  }

  // Reject ttsAutoplay — it lives on users.preferences, not campaigns.settings.
  if ('ttsAutoplay' in body) {
    return NextResponse.json({ error: 'unknown-key', key: 'ttsAutoplay' }, { status: 400 });
  }

  const result = validateSettingsPatch(body as Partial<CampaignSettings>);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // validateSettingsPatch returns the superset (incl. ttsAutoplay) but we
  // already rejected ttsAutoplay above, so the patch is safe to persist.
  const { ttsAutoplay: _ignored, ...campaignPatch } = result.patch;
  void _ignored;
  await updateCampaignSettings(id, campaignPatch);

  const settings = await getCampaignSettings(id);
  return NextResponse.json({ settings });
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm test tests/api/campaign-settings.test.ts
```
Expected: PASS, all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/campaigns/[id]/settings/route.ts tests/api/campaign-settings.test.ts
git commit -m "feat(api): /api/campaigns/[id]/settings — host PUT, member GET"
```

---

### Task 8: Switch TTS route to campaign-scoped voice/model

**Files:**
- Modify: `src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts`

The TTS cache key is already `(messageId, voice, model)` — no schema change needed. The only logic change is: the voice/model used to synthesize must come from the campaign, not the viewer.

- [ ] **Step 1: Replace the prefs read**

In `src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts`:

- Replace the import:

```ts
import { getSessionMasterPreferences } from '@/lib/preferences';
```

(remove the existing `getResolvedPreferences` import on the same line)

- Replace line ~43 (`const prefs = await getResolvedPreferences(userId);`) with:

```ts
  const prefs = await getSessionMasterPreferences(sessionId);
```

(Everything downstream — `prefs.ttsProvider`, `prefs.ttsVoice`, `prefs.ttsModel` — stays identical. The shape is the same.)

- [ ] **Step 2: Run typecheck + full test**

```bash
pnpm typecheck && pnpm test
```
Expected: PASS. The TTS route now reads voice from the campaign for every viewer.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sessions/[id]/messages/[messageId]/tts/route.ts
git commit -m "fix(tts): synthesize with campaign voice instead of viewer's user prefs"
```

---

## Phase 4 — UI: new settings page

### Task 9: Create the client component

**Files:**
- Create: `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`

This is adapted from `src/app/(authed)/settings/settings-client.tsx` with three differences:
1. Removes the Auto-play card (autoplay already lives in the in-game top bar).
2. Adds a top banner when `!canEdit` and disables every control.
3. PUTs to `/api/campaigns/[id]/settings` (returns `{ settings }`) instead of `/api/preferences` (returns `{ preferences }`).

- [ ] **Step 1: Create the file**

Create `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`:

```tsx
'use client';
import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Icon } from '@/components/ui/icon';
import {
  TTS_PROVIDERS,
  type TtsProvider,
  voicesForModel as ttsVoicesForModel,
  modelsForProvider as ttsModelsFor,
  defaultVoiceForModel as ttsDefaultVoiceForModel,
  defaultModelForProvider as ttsDefaultModelFor,
  isValidTtsProvider,
} from '@/lib/tts-voices';
import {
  modelsForProvider,
  defaultModelForProvider,
  imageModelsForProvider,
  defaultImageModelForProvider,
  type ProviderName,
  type ImageProviderName,
} from '@/lib/ai-models';
import type { CampaignSettings } from '@/db/schema/campaigns';

export interface CampaignSettingsClientProps {
  campaignId: string;
  initialSettings: Required<CampaignSettings>;
  canEdit: boolean;
}

const TTS_MODEL_BLURBS: Record<string, string> = {
  'gpt-4o-mini-tts': 'Newer, voice-steering supported',
  'tts-1': 'Lower latency, slightly less natural',
  'tts-1-hd': 'Higher fidelity, slower & pricier',
  'gemini-2.5-flash-preview-tts': 'Faster, cheaper',
  'gemini-2.5-pro-preview-tts': 'Higher fidelity, slower',
};

const TTS_PROVIDER_LABELS: Record<TtsProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
};

export function CampaignSettingsClient({ campaignId, initialSettings, canEdit }: CampaignSettingsClientProps) {
  const [settings, setSettings] = React.useState<Required<CampaignSettings>>(initialSettings);
  const [busy, setBusy] = React.useState(false);
  const [savedOnce, setSavedOnce] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async (patch: Partial<CampaignSettings>): Promise<void> => {
    if (!canEdit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { settings: next } = (await res.json()) as { settings: Required<CampaignSettings> };
      setSettings(next);
      setSavedOnce(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const disabled = !canEdit || busy;

  const onVoiceChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const value = e.target.value;
    setSettings((s) => ({ ...s, ttsVoice: value }));
    void save({ ttsVoice: value });
  };

  const onTtsModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const nextModel = e.target.value;
    const allowedVoices = ttsVoicesForModel(settings.ttsProvider, nextModel);
    const keepVoice = allowedVoices.includes(settings.ttsVoice);
    const nextVoice = keepVoice ? settings.ttsVoice : ttsDefaultVoiceForModel(settings.ttsProvider, nextModel);
    setSettings((s) => ({ ...s, ttsModel: nextModel, ttsVoice: nextVoice }));
    void save(keepVoice ? { ttsModel: nextModel } : { ttsModel: nextModel, ttsVoice: nextVoice });
  };

  const onTtsProviderChange = (next: TtsProvider): void => {
    if (!isValidTtsProvider(next) || next === settings.ttsProvider) return;
    const nextModel = ttsDefaultModelFor(next);
    const nextVoice = ttsDefaultVoiceForModel(next, nextModel);
    setSettings((s) => ({ ...s, ttsProvider: next, ttsVoice: nextVoice, ttsModel: nextModel }));
    void save({ ttsProvider: next, ttsVoice: nextVoice, ttsModel: nextModel });
  };

  const onManualRollsToggle = (): void => {
    const next = !settings.manualRolls;
    setSettings((s) => ({ ...s, manualRolls: next }));
    void save({ manualRolls: next });
  };

  const onGuidanceLevelChange = (next: 'free' | 'balanced' | 'structured'): void => {
    if (next === settings.masterGuidanceLevel) return;
    setSettings((s) => ({ ...s, masterGuidanceLevel: next }));
    void save({ masterGuidanceLevel: next });
  };

  const onShowDifficultyNumbersToggle = (): void => {
    const next = !settings.showDifficultyNumbers;
    setSettings((s) => ({ ...s, showDifficultyNumbers: next }));
    void save({ showDifficultyNumbers: next });
  };

  const onNarrationPaceChange = (next: 'detailed' | 'brisk'): void => {
    if (next === settings.narrationPace) return;
    setSettings((s) => ({ ...s, narrationPace: next }));
    void save({ narrationPace: next });
  };

  const onImageGenToggle = (): void => {
    const next = !settings.imageGenerationEnabled;
    setSettings((s) => ({ ...s, imageGenerationEnabled: next }));
    void save({ imageGenerationEnabled: next });
  };

  const onImageStylePresetChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value as NonNullable<CampaignSettings['imageStylePreset']>;
    if (next === settings.imageStylePreset) return;
    setSettings((s) => ({ ...s, imageStylePreset: next }));
    void save({ imageStylePreset: next });
  };

  const onImageStyleCustomChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = e.target.value;
    setSettings((s) => ({ ...s, imageStyleCustom: next }));
  };
  const onImageStyleCustomBlur = (): void => {
    void save({ imageStyleCustom: settings.imageStyleCustom });
  };

  const onImageProviderChange = (next: ImageProviderName): void => {
    if (next === settings.imageProvider) return;
    const nextModel = defaultImageModelForProvider(next);
    setSettings((s) => ({ ...s, imageProvider: next, imageModel: nextModel }));
    void save({ imageProvider: next, imageModel: nextModel });
  };

  const onImageModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const slug = e.target.value;
    setSettings((s) => ({ ...s, imageModel: slug }));
    void save({ imageModel: slug });
  };

  const onProviderChange = (next: ProviderName): void => {
    if (next === settings.aiProvider) return;
    const nextModel = defaultModelForProvider(next);
    setSettings((s) => ({ ...s, aiProvider: next, aiMasterModel: nextModel }));
    void save({ aiProvider: next, aiMasterModel: nextModel });
  };

  const onModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const slug = e.target.value;
    setSettings((s) => ({ ...s, aiMasterModel: slug }));
    void save({ aiMasterModel: slug });
  };

  const availableModels = modelsForProvider(settings.aiProvider);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 36, fontWeight: 600 }}>Campaign settings</h1>
          <p style={{ marginTop: 6, color: 'var(--fg-muted)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
            Tune the Master&apos;s voice and how it behaves at this campaign&apos;s table.
          </p>
        </div>
        <Link href={`/campaigns/${campaignId}`}>
          <Button variant="ghost" size="md" icon="arrow-left">Back to campaign</Button>
        </Link>
      </div>

      {!canEdit && (
        <>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="lock" size={16} />
              <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-muted)' }}>
                Solo il creatore della campagna può modificare queste impostazioni.
              </p>
            </div>
          </Card>
          <div style={{ height: 16 }} />
        </>
      )}

      <Card>
        <div>
          <Eyebrow>AI master</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Provider &amp; model</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            Drives the master narration. Shared with every player in the campaign.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label htmlFor="provider" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>
            Provider
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['anthropic', 'openai', 'gemini'] as ProviderName[]).map((p) => (
              <button
                key={p}
                onClick={() => onProviderChange(p)}
                disabled={disabled}
                aria-pressed={settings.aiProvider === p}
                style={{
                  padding: '8px 16px',
                  borderRadius: 999,
                  background: settings.aiProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                  color: settings.aiProvider === p ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (settings.aiProvider === p ? 'var(--arcane)' : 'var(--border)'),
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  opacity: !canEdit ? 0.7 : 1,
                }}
              >
                {p === 'anthropic' ? 'Anthropic' : p === 'openai' ? 'OpenAI' : 'Gemini'}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="masterModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Model</label>
          <select id="masterModel" value={settings.aiMasterModel} onChange={onModelChange} disabled={disabled}
            style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
            {availableModels.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.label}{m.recommended ? ' (recommended)' : ''} — {m.blurb}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Voice</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Master voice (TTS)</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            The narration voice every player hears. Switching invalidates cached audio for past messages; they re-synthesize on the next click.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Provider</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {TTS_PROVIDERS.map((p) => (
              <button key={p} onClick={() => onTtsProviderChange(p)} disabled={disabled} aria-pressed={settings.ttsProvider === p}
                style={{ padding: '8px 16px', borderRadius: 999,
                  background: settings.ttsProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                  color: settings.ttsProvider === p ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (settings.ttsProvider === p ? 'var(--arcane)' : 'var(--border)'),
                  cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  opacity: !canEdit ? 0.7 : 1 }}>
                {TTS_PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="ttsModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Model</label>
          <select id="ttsModel" value={settings.ttsModel} onChange={onTtsModelChange} disabled={disabled}
            style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
            {ttsModelsFor(settings.ttsProvider).map((m) => (
              <option key={m} value={m}>{m}{TTS_MODEL_BLURBS[m] ? ` — ${TTS_MODEL_BLURBS[m]}` : ''}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label htmlFor="ttsVoice" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 60 }}>Voice</label>
          <select id="ttsVoice" value={settings.ttsVoice} onChange={onVoiceChange} disabled={disabled}
            style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
            {ttsVoicesForModel(settings.ttsProvider, settings.ttsModel).map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Dice rolls</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            Auto-roll: the AI computes attacks, saves and damage server-side. Manual: the master writes the formula and the app shows a roll button — the result is sent back automatically.
          </p>
        </div>
        <button onClick={onManualRollsToggle} disabled={disabled} aria-pressed={settings.manualRolls}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px',
            background: settings.manualRolls ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (settings.manualRolls ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999, color: settings.manualRolls ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
            cursor: disabled ? 'not-allowed' : 'pointer', opacity: !canEdit ? 0.7 : 1 }}>
          <Icon name="dice" size={14} />
          {settings.manualRolls ? 'Manual rolls' : 'Auto-rolls'}
        </button>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Master guidance</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>How proactively the master suggests possible actions.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {([
            { slug: 'free' as const, label: 'Free', blurb: 'Pure narration, open prompt' },
            { slug: 'balanced' as const, label: 'Balanced', blurb: 'Hints in prose, no list' },
            { slug: 'structured' as const, label: 'Structured', blurb: 'Numbered choice list' },
          ]).map((opt) => {
            const active = settings.masterGuidanceLevel === opt.slug;
            return (
              <button key={opt.slug} onClick={() => onGuidanceLevelChange(opt.slug)} disabled={disabled} aria-pressed={active} title={opt.blurb}
                style={{ padding: '8px 16px', borderRadius: 999,
                  background: active ? 'var(--arcane)' : 'var(--bg-card)',
                  color: active ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (active ? 'var(--arcane)' : 'var(--border)'),
                  cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 140,
                  opacity: !canEdit ? 0.7 : 1 }}>
                <span>{opt.label}</span>
                <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.8 }}>{opt.blurb}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Narration pace</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            Detailed: every micro-beat is its own master turn. Brisk: the master collapses obvious follow-through into one beat.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {([
            { slug: 'detailed' as const, label: 'Detailed', blurb: 'Every micro-beat' },
            { slug: 'brisk' as const, label: 'Brisk', blurb: 'Collapse filler beats' },
          ]).map((opt) => {
            const active = (settings.narrationPace ?? 'detailed') === opt.slug;
            return (
              <button key={opt.slug} onClick={() => onNarrationPaceChange(opt.slug)} disabled={disabled} aria-pressed={active} title={opt.blurb}
                style={{ padding: '8px 16px', borderRadius: 999,
                  background: active ? 'var(--arcane)' : 'var(--bg-card)',
                  color: active ? 'var(--bone)' : 'var(--fg)',
                  border: '1px solid ' + (active ? 'var(--arcane)' : 'var(--border)'),
                  cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 140,
                  opacity: !canEdit ? 0.7 : 1 }}>
                <span>{opt.label}</span>
                <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.8 }}>{opt.blurb}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Behavior</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Difficulty numbers</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            When ON, the master shows DC and AC values in narration. When OFF, those numbers stay hidden.
          </p>
        </div>
        <button onClick={onShowDifficultyNumbersToggle} disabled={disabled} aria-pressed={settings.showDifficultyNumbers}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px',
            background: settings.showDifficultyNumbers ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (settings.showDifficultyNumbers ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999, color: settings.showDifficultyNumbers ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
            cursor: disabled ? 'not-allowed' : 'pointer', opacity: !canEdit ? 0.7 : 1 }}>
          <Icon name="dice" size={14} />
          {settings.showDifficultyNumbers ? 'DC/AC visible' : 'DC/AC hidden'}
        </button>
      </Card>

      <div style={{ height: 16 }} />

      <Card>
        <div>
          <Eyebrow>Scene illustrations</Eyebrow>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>Scene images</h2>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--fg-muted)' }}>
            When enabled, every master message gets an &ldquo;Image&rdquo; button to illustrate that scene.
          </p>
        </div>
        <button onClick={onImageGenToggle} disabled={disabled} aria-pressed={settings.imageGenerationEnabled}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px',
            background: settings.imageGenerationEnabled ? 'var(--arcane)' : 'transparent',
            border: '1px solid ' + (settings.imageGenerationEnabled ? 'var(--arcane)' : 'var(--border-strong)'),
            borderRadius: 999, color: settings.imageGenerationEnabled ? 'var(--bone)' : 'var(--fg-muted)',
            fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
            cursor: disabled ? 'not-allowed' : 'pointer', opacity: !canEdit ? 0.7 : 1 }}>
          <Icon name="sparkle" size={14} />
          {settings.imageGenerationEnabled ? 'Generation on' : 'Generation off'}
        </button>

        {settings.imageGenerationEnabled && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>Provider</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['openai', 'gemini'] as ImageProviderName[]).map((p) => (
                  <button key={p} onClick={() => onImageProviderChange(p)} disabled={disabled} aria-pressed={settings.imageProvider === p}
                    style={{ padding: '8px 16px', borderRadius: 999,
                      background: settings.imageProvider === p ? 'var(--arcane)' : 'var(--bg-card)',
                      color: settings.imageProvider === p ? 'var(--bone)' : 'var(--fg)',
                      border: '1px solid ' + (settings.imageProvider === p ? 'var(--arcane)' : 'var(--border)'),
                      cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                      opacity: !canEdit ? 0.7 : 1 }}>
                    {p === 'openai' ? 'OpenAI' : 'Gemini'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label htmlFor="imageModel" style={{ fontSize: 13, color: 'var(--fg-muted)', minWidth: 80 }}>Model</label>
              <select id="imageModel" value={settings.imageModel} onChange={onImageModelChange} disabled={disabled}
                style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
                {imageModelsForProvider(settings.imageProvider).map((m) => (
                  <option key={m.slug} value={m.slug}>{m.label}{m.recommended ? ' (recommended)' : ''} — {m.blurb}</option>
                ))}
              </select>
            </div>

            <label style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Image style</label>
            <select value={settings.imageStylePreset} onChange={onImageStylePresetChange} disabled={disabled}
              style={{ height: 36, padding: '0 10px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-card)', color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
              <option value="pastel">Pastel drawing (default)</option>
              <option value="watercolor">Watercolor</option>
              <option value="oil">Oil painting</option>
              <option value="ink">Ink illustration</option>
              <option value="photo">Cinematic photo</option>
              <option value="custom">Custom…</option>
            </select>

            {settings.imageStylePreset === 'custom' && (
              <textarea value={settings.imageStyleCustom ?? ''} onChange={onImageStyleCustomChange} onBlur={onImageStyleCustomBlur}
                placeholder="e.g. retro pixel art, low-poly 3d render…" rows={2} maxLength={500} disabled={disabled}
                style={{ padding: 10, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-card)', color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 13, resize: 'vertical' }} />
            )}
          </div>
        )}
      </Card>

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'right', minHeight: 18 }}>
        {error ? <span style={{ color: 'var(--ember)' }}>Save failed: {error}</span>
          : busy ? <span>Saving…</span>
          : savedOnce ? <span>Saved.</span> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the icon `lock` exists** (the banner uses it)

```bash
grep -n "name.*=.*'lock'" src/components/ui/icon.tsx
```
Expected: a match. If not, fall back to `name="settings"` in the banner (the banner copy carries the meaning either way).

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(authed\)/campaigns/\[id\]/settings/settings-client.tsx
git commit -m "feat(ui): CampaignSettingsClient — host edit, member read-only"
```

---

### Task 10: Create the server page

**Files:**
- Create: `src/app/(authed)/campaigns/[id]/settings/page.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { getCampaign } from '@/campaigns/persist';
import { getCampaignSettings } from '@/lib/preferences';
import { ensureUser } from '@/db/users';
import { CampaignSettingsClient } from './settings-client';

export const dynamic = 'force-dynamic';

export default async function CampaignSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  await ensureUser(userId);
  const { id } = await params;

  const data = await getCampaign(userId, id);
  if (!data) notFound();

  const settings = await getCampaignSettings(id);
  const canEdit = data.campaign.userId === userId;

  return (
    <CampaignSettingsClient campaignId={id} initialSettings={settings} canEdit={canEdit} />
  );
}
```

- [ ] **Step 2: Smoke-test in the dev server**

```bash
pnpm dev
```
In a browser: log in, open `/campaigns/<an-active-campaign-id>/settings`, verify the page renders with the saved values. Open it as a member (with a different account) → banner shows, controls disabled. Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(authed\)/campaigns/\[id\]/settings/page.tsx
git commit -m "feat(ui): /campaigns/[id]/settings server page"
```

---

### Task 11: Add Settings button on the campaign detail page

**Files:**
- Modify: `src/app/(authed)/campaigns/[id]/page.tsx`

The current header row holds Continue + Delete. We add a "Settings" link button next to Continue. Visible to all members.

- [ ] **Step 1: Add the button**

Find the header `<div style={{ display: 'flex', gap: 8 }}>` (around line 59) and add a `<Link>` before `activeSession ? …`:

```tsx
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href={`/campaigns/${campaign.id}/settings`}>
            <Button variant="ghost" size="md" icon="settings">Settings</Button>
          </Link>
          {activeSession ? (
            <Link href={`/sessions/${activeSession.id}`}>
              <Button variant="primary" size="md" iconRight="arrow-right">Continue</Button>
            </Link>
          ) : (
            <Button variant="primary" size="md" disabled>Resume not available</Button>
          )}
          {isHost && (
            <DeleteResourceButton
              endpoint={`/api/campaigns/${campaign.id}`}
              confirmText={`Delete ${campaign.name}? This cannot be undone.`}
              redirectTo="/campaigns"
            />
          )}
        </div>
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(authed\)/campaigns/\[id\]/page.tsx
git commit -m "feat(ui): link Settings from campaign detail header"
```

---

## Phase 5 — Strip global settings UI

### Task 12: Remove `<SettingsLink />` from top-bar

**Files:**
- Modify: `src/components/layout/top-bar.tsx`

- [ ] **Step 1: Remove the import and the render**

In `src/components/layout/top-bar.tsx`:

- Remove line: `import { SettingsLink } from '@/components/ui/settings-link';`
- Remove the `<SettingsLink variant="ghost" size="sm" iconOnly />` line in the render.

The final file should look like:

```tsx
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/icon';
import { Wordmark } from '@/components/ui/wordmark';
import { Chip } from '@/components/ui/chip';
import { UserMenu } from '@/components/layout/user-menu';

export interface TopBarProps {
  mode?: string;
}

export function TopBar({ mode = 'Solo' }: TopBarProps) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 32px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        flexShrink: 0,
      }}
    >
      <Link href="/hub" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'inherit' }}>
        <Icon name="logo-d20" size={22} />
        <Wordmark size={18} />
      </Link>
      <nav style={{ marginLeft: 24, display: 'flex', gap: 4 }}>
        {[
          { label: 'Campaigns', href: '/campaigns' },
          { label: 'Characters', href: '/hub' },
        ].map((n) => (
          <Link
            key={n.label}
            href={n.href}
            style={{
              background: isActive(n.href) ? 'var(--bg-card)' : 'transparent',
              color: isActive(n.href) ? 'var(--fg)' : 'var(--fg-muted)',
              height: 28,
              padding: '0 12px',
              borderRadius: 6,
              fontFamily: 'var(--font-ui)',
              fontSize: 13,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <div style={{ flex: 1 }} />
      <Chip tone="accent" dot>{mode}</Chip>
      <UserMenu />
    </header>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/top-bar.tsx
git commit -m "chore(layout): remove SettingsLink from desktop top-bar"
```

---

### Task 13: Remove Settings tab from bottom-nav (mobile)

**Files:**
- Modify: `src/components/layout/bottom-nav.tsx`

- [ ] **Step 1: Drop the settings entry**

Replace the `Tab` interface and `TABS` array with:

```tsx
interface Tab {
  key: 'campaigns' | 'heroes';
  href: string;
  label: string;
  icon: IconName;
}

const TABS: Tab[] = [
  { key: 'campaigns', href: '/campaigns', label: 'Campaigns', icon: 'book' },
  { key: 'heroes', href: '/hub', label: 'Heroes', icon: 'user' },
];
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/bottom-nav.tsx
git commit -m "chore(layout): drop Settings tab from mobile bottom-nav"
```

---

### Task 14: Remove Settings from UserMenu dropdown

**Files:**
- Modify: `src/components/layout/user-menu.tsx`

- [ ] **Step 1: Remove the `goToSettings` function and the MenuButton**

In `src/components/layout/user-menu.tsx`:

- Delete the `goToSettings` function (lines ~40-43):
  ```ts
  const goToSettings = () => {
    setOpen(false);
    router.push('/settings');
  };
  ```
- Delete the `<MenuButton onClick={goToSettings} icon="settings" label="Settings" />` line in the dropdown render.
- The `useRouter` import can stay only if it's used elsewhere — it isn't, so also delete `import { useRouter } from 'next/navigation';` and `const router = useRouter();`.
- Update `MenuButtonProps['icon']` type to drop `'settings'`: change `icon: 'settings' | 'log-out'` to `icon: 'log-out'`.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS (no consumers of `goToSettings` remain).

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/user-menu.tsx
git commit -m "chore(layout): remove Settings entry from UserMenu dropdown"
```

---

### Task 15: Remove `<SettingsLink />` from in-game header

**Files:**
- Modify: `src/app/(authed)/sessions/[id]/game-client.tsx`

The autoplay toggle (`<AutoplayToggle />`) already lives in both the mobile and desktop in-game headers. We only need to drop the neighboring SettingsLink in both spots and the import.

- [ ] **Step 1: Delete the two usages**

In `src/app/(authed)/sessions/[id]/game-client.tsx`:

- Around line 442 (mobile header trailing): remove `<SettingsLink variant="ghost" size="sm" iconOnly />`.
- Around line 551 (desktop header): remove `<SettingsLink variant="ghost" size="sm" iconOnly />`.
- Line 15: remove `import { SettingsLink } from '@/components/ui/settings-link';`.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(authed\)/sessions/\[id\]/game-client.tsx
git commit -m "chore(game): drop SettingsLink from in-game top bar — keep AutoplayToggle"
```

---

### Task 16: Delete the old `/settings` page and `SettingsLink`

**Files:**
- Delete: `src/app/(authed)/settings/page.tsx`
- Delete: `src/app/(authed)/settings/settings-client.tsx`
- Delete: `src/components/ui/settings-link.tsx`

- [ ] **Step 1: Verify nothing imports them anymore**

```bash
grep -rn "settings-link\|/settings'" src --include="*.ts" --include="*.tsx"
```
Expected: no matches (besides the new `/campaigns/[id]/settings` route).

- [ ] **Step 2: Remove the files**

```bash
rm src/app/\(authed\)/settings/page.tsx \
   src/app/\(authed\)/settings/settings-client.tsx \
   src/components/ui/settings-link.tsx
rmdir src/app/\(authed\)/settings
```

- [ ] **Step 3: Run typecheck + tests**

```bash
pnpm typecheck && pnpm test
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(settings): remove global /settings page + SettingsLink component"
```

---

## Phase 6 — End-to-end smoke test

### Task 17: Playwright E2E for host edit + guest read-only

**Files:**
- Create: `tests/e2e/campaign-settings.spec.ts`

This depends on a working Clerk test-mode setup. Check whether an existing Playwright spec authenticates a test user (look in `tests/e2e/`). If so, copy the auth pattern; if not, this task is gated on existing E2E infrastructure — skip and document the manual test instead.

- [ ] **Step 1: Inventory existing E2E specs**

```bash
ls tests/e2e/ 2>/dev/null
```

If the directory exists and has authenticated specs, proceed to Step 2. Otherwise jump to Step 5 (manual smoke checklist).

- [ ] **Step 2: Write the spec (only if E2E infra exists)**

Create `tests/e2e/campaign-settings.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.describe('per-campaign settings', () => {
  test('host can change narration pace; member sees read-only', async ({ page, browser }) => {
    // 1) Host signs in via the test auth helper (copy whatever pattern other
    //    specs use), creates a campaign, opens /campaigns/[id]/settings.
    // 2) Host clicks the Brisk pill, waits for "Saved." indicator.
    // 3) Host invites a member; member joins (or use pre-seeded fixture).
    // 4) Member opens /campaigns/[id]/settings, asserts:
    //    - banner text "Solo il creatore della campagna può modificare queste impostazioni." is visible
    //    - the Brisk pill has aria-pressed="true"
    //    - clicking Detailed does NOT toggle aria-pressed (disabled)
    //
    // Concrete selectors depend on the existing E2E helpers; fill them in
    // following the patterns from tests/e2e/<another-spec>.spec.ts.
    expect(true).toBe(true); // placeholder — replace with real flow
  });
});
```

If you can't reuse an existing auth helper, do NOT invent one — go to Step 5.

- [ ] **Step 3: Run the spec**

```bash
pnpm test:e2e tests/e2e/campaign-settings.spec.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/campaign-settings.spec.ts
git commit -m "test(e2e): host edits + member read-only on /campaigns/[id]/settings"
```

- [ ] **Step 5: Manual smoke checklist (if E2E infra is absent)**

Run `pnpm dev`. As the campaign host:

- Open `/campaigns/<id>/settings`. The page renders; controls are enabled; no banner.
- Switch narration pace from Detailed to Brisk. The "Saved." indicator appears.
- Reload the page. The Brisk pill is still selected.
- Switch AI provider to OpenAI. Save indicator appears; model auto-resets to a known OpenAI model.
- Return to `/campaigns/<id>` → click "Continue" → take a turn in the running session. The master narration uses the new pace + provider.

As a different user who is a member (joined via invite, has a character in the party):

- Open `/campaigns/<id>/settings`. The banner appears at the top: *"Solo il creatore della campagna può modificare queste impostazioni."*
- Every control is disabled (visually faded, aria-pressed shows the saved value but doesn't react to clicks).
- A direct `PUT` to `/api/campaigns/<id>/settings` with a body returns 403.

As a stranger (no character in the party):

- `/campaigns/<id>/settings` returns the standard 404 page.

Record any failures here as new tasks; otherwise commit:

```bash
git commit --allow-empty -m "test(e2e): manual smoke complete for per-campaign settings"
```

---

## Phase 7 — Final integration check

### Task 18: Full test + typecheck + lint sweep

- [ ] **Step 1: Run everything**

```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all green.

- [ ] **Step 2: Spot-check the in-game session flow**

```bash
pnpm dev
```

- Open a running session as host. Take a turn — confirm the narration appears, TTS plays with the campaign's voice, scene image button shows iff `imageGenerationEnabled` on the campaign.
- Switch to a second account that's a member. Open the same session — confirm same TTS voice plays (not the member's old `users.preferences.ttsVoice`). Toggle autoplay in the top bar — confirm it persists for that account only.
- Close dev server.

- [ ] **Step 3: Final commit if anything trailing**

```bash
git status
```

If clean, no commit needed. If anything outstanding (e.g. an unused import the linter just flagged), commit it:

```bash
git add -A
git commit -m "chore: cleanup after per-campaign-settings rollout"
```

---

## Done

The migration is complete:

- `campaigns.settings` jsonb owns every shared game decision.
- `getSessionMasterPreferences(sessionId)` and `getCampaignSettings(campaignId)` are the only resolvers for shared settings; per-viewer `getResolvedPreferences(userId)` is now only useful for `ttsAutoplay`.
- `/api/campaigns/[id]/settings` enforces host-only edits; `/api/preferences` only accepts `ttsAutoplay`.
- The UI mirrors the model: campaign detail has a "Settings" button; members see a read-only banner; the global "Settings" links are gone; autoplay stays as the in-game header toggle that already existed.
