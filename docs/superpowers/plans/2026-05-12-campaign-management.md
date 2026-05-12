# Campaign Management Minimum Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a first-class `Campaign` entity that owns long-lived narrative state (premise, language, tonal_frame, engagement_profile) while `Session` retains active play state. Prerequisite for sub-project #6 (Multiplayer).

**Architecture:** New `campaigns` table; additive `campaign_id` FKs on `sessions` and `characters`. Character template→instance fork moves from session-creation time to campaign-creation time. New `/api/campaigns/*` routes wrap existing session creation logic. UI gains `/campaigns`, `/campaigns/new`, `/campaigns/[id]`. Migration is two-PR: PR 1 additive with backfill and double-write, PR 2 drops deprecated columns after ≥1 week of stable production.

**Tech Stack:** Next.js 16 App Router · TypeScript · Drizzle ORM (Postgres) · Clerk auth · Vitest · Playwright.

**Spec:** [docs/superpowers/specs/2026-05-12-campaign-management-design.md](../specs/2026-05-12-campaign-management-design.md)

**Diagram:** [docs/superpowers/specs/2026-05-12-campaign-management-design.excalidraw](../specs/2026-05-12-campaign-management-design.excalidraw)

---

## File structure

**Create**
- `src/db/schema/campaigns.ts` — Drizzle schema for `campaigns` table + enum
- `src/campaigns/types.ts` — re-exported Campaign types
- `src/campaigns/default-name.ts` — `defaultCampaignName(character)` helper
- `src/campaigns/validate.ts` — request body validation for `POST` and `PATCH`
- `src/campaigns/persist.ts` — `listCampaigns`, `getCampaign`, `softDeleteCampaign`, `renameCampaign`, `touchCampaign`
- `src/campaigns/forge.ts` — atomic `createCampaign({ userId, name, premise, characterTemplateId })` transaction
- `src/campaigns/fork.ts` — `forkTemplateForCampaign(template, campaignId)` extracted from current session route
- `src/app/api/campaigns/route.ts` — `GET` (list) + `POST` (create)
- `src/app/api/campaigns/[id]/route.ts` — `GET` + `PATCH` + `DELETE`
- `src/app/(authed)/campaigns/page.tsx` — list page
- `src/app/(authed)/campaigns/new/page.tsx` — wizard server component
- `src/app/(authed)/campaigns/new/wizard-client.tsx` — wizard client component (2 steps)
- `src/app/(authed)/campaigns/[id]/page.tsx` — detail page
- `src/components/campaigns/campaign-card.tsx` — shared card
- `scripts/migrate-legacy-template-sessions.ts` — one-off TS script for retroactive forks
- Tests: `tests/campaigns/default-name.test.ts`, `tests/campaigns/validate.test.ts`, `tests/campaigns/forge.test.ts`, `tests/api/campaigns.test.ts`, `tests/e2e/campaigns.spec.ts`

**Modify**
- `src/db/schema/sessions.ts` — add `campaignId` column + index
- `src/db/schema/characters.ts` — add `campaignId` column + index
- `src/db/schema/index.ts` — export campaigns module
- `src/app/api/sessions/route.ts` — `POST` and `GET` return `410 Gone`
- `src/app/api/sessions/[id]/route.ts` — `GET` returns joined `campaign`
- `src/app/api/sessions/[id]/turn/route.ts` (or wherever the master loop builds its input) — read premise/language/tonal_frame/engagement_profile from `campaigns`; write tonal_frame and engagement_profile to `campaigns`; update `campaign.last_played_at` at end-of-turn
- `src/app/(authed)/hub/page.tsx` — replace "Open tables" section with "Campaigns" section
- `src/components/layout/top-bar.tsx` — fix Campaigns link to `/campaigns`
- `next.config.ts` (or middleware) — `301` redirects for `/sessions` and `/sessions/new`
- `drizzle/<NNNN>_<auto>.sql` — generated migration; backfill SQL appended manually

**Delete** (replaced by 301 redirects)
- `src/app/(authed)/sessions/page.tsx`
- `src/app/(authed)/sessions/new/page.tsx`

---

## Phase 1 — Database schema & migration

### Task 1: Drizzle schema for `campaigns`

**Files:**
- Create: `src/db/schema/campaigns.ts`
- Modify: `src/db/schema/index.ts`

- [ ] **Step 1: Create the schema file**

```typescript
// src/db/schema/campaigns.ts
import { pgTable, text, uuid, timestamp, pgEnum, varchar, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export const campaignStatusEnum = pgEnum('campaign_status', ['active', 'ended']);

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

- [ ] **Step 2: Export from the schema index**

In `src/db/schema/index.ts`, add the line `export * from './campaigns';` next to the other `export * from './session-*'` lines.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/campaigns.ts src/db/schema/index.ts
git commit -m "feat(db): add campaigns Drizzle schema"
```

---

### Task 2: Add `campaignId` to `sessions` and `characters` schemas

**Files:**
- Modify: `src/db/schema/sessions.ts`
- Modify: `src/db/schema/characters.ts`

- [ ] **Step 1: Add `campaignId` to `sessions.ts`**

Open `src/db/schema/sessions.ts`. Import `campaigns` from `./campaigns`. After the existing columns (just before the `deletedAt` line), insert:

```typescript
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
```

In the index callback, add:

```typescript
    campaignIdx: index('sessions_campaign_idx').on(t.campaignId),
```

- [ ] **Step 2: Add `campaignId` to `characters.ts`**

Open `src/db/schema/characters.ts`. Import `campaigns` from `./campaigns`. Near the existing `templateId` column, add:

```typescript
    /**
     * NULL on a template row. Non-NULL on an instance row, pointing at the
     * campaign that owns the fork. Combined with `templateId`, enforces the
     * application invariant: templates have both NULL, instances have both
     * NOT NULL.
     */
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
```

In the index callback, add:

```typescript
    campaignIdx: index('characters_campaign_idx').on(t.campaignId),
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/sessions.ts src/db/schema/characters.ts
git commit -m "feat(db): add campaign_id columns to sessions and characters"
```

---

### Task 3: Generate Drizzle migration 0024

**Files:**
- Create: `drizzle/<NNNN>_<auto>.sql` (auto-generated, expected `0024_*`)
- Create: `drizzle/meta/_journal.json` and snapshot (auto-generated)

- [ ] **Step 1: Run Drizzle generate**

Run: `pnpm db:generate`
Expected: a new file `drizzle/0024_<adjective_noun>.sql` is created, plus updates to `drizzle/meta/_journal.json` and a new snapshot under `drizzle/meta/`.

- [ ] **Step 2: Inspect the generated SQL**

Read the new `drizzle/0024_*.sql`. Verify it contains (in any order):
- `CREATE TYPE "public"."campaign_status" AS ENUM('active', 'ended');`
- `CREATE TABLE ... "campaigns" (...)` with all the expected columns
- `ALTER TABLE "sessions" ADD COLUMN "campaign_id" uuid ... ON DELETE cascade`
- `ALTER TABLE "characters" ADD COLUMN "campaign_id" uuid ... ON DELETE cascade`
- 3 `CREATE INDEX` statements

If anything is missing, go back to Task 1/2 and fix the schema before regenerating.

- [ ] **Step 3: Commit the generated migration**

```bash
git add drizzle/0024_*.sql drizzle/meta/
git commit -m "feat(db): generate migration 0024 for campaigns"
```

---

### Task 4: Append backfill SQL to migration 0024

**Files:**
- Modify: `drizzle/0024_*.sql` (the file generated in Task 3)

- [ ] **Step 1: Append the backfill block at the end of the migration file**

Open the migration. After all `CREATE/ALTER` statements, append the backfill exactly as below:

```sql
--> statement-breakpoint
-- ── Campaign backfill ──
-- One campaign per existing non-deleted session. Long-lived fields move from
-- sessions to campaigns. Instance characters inherit campaign_id from their
-- session. Legacy sessions whose character is a template are handled by
-- scripts/migrate-legacy-template-sessions.ts (run separately post-migration).

CREATE TEMP TABLE session_to_campaign ON COMMIT DROP AS
SELECT s.id AS session_id, gen_random_uuid() AS campaign_id
FROM sessions s
WHERE s.campaign_id IS NULL;

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

UPDATE sessions s SET campaign_id = stc.campaign_id
FROM session_to_campaign stc
WHERE stc.session_id = s.id;

UPDATE characters c SET campaign_id = s.campaign_id
FROM sessions s
WHERE s.character_id = c.id
  AND c.template_id IS NOT NULL
  AND c.campaign_id IS NULL;
```

- [ ] **Step 2: Run the migration locally**

Run: `pnpm db:up && pnpm db:migrate`
Expected: migration applies successfully.

- [ ] **Step 3: Verify the backfill in the local DB**

Run:
```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM campaigns;" \
                     -c "SELECT COUNT(*) FROM sessions WHERE campaign_id IS NULL AND deleted_at IS NULL;" \
                     -c "SELECT COUNT(*) FROM characters WHERE template_id IS NOT NULL AND campaign_id IS NULL;"
```
Expected: first count > 0 if there were sessions; second and third counts = 0.

- [ ] **Step 4: Commit**

```bash
git add drizzle/0024_*.sql
git commit -m "feat(db): backfill campaigns from existing sessions in 0024"
```

---

### Task 5: Tighten `sessions.campaign_id` to NOT NULL

**Files:**
- Modify: `src/db/schema/sessions.ts`
- Create: another auto-generated migration (expected `0025_*`)

- [ ] **Step 1: Make `campaignId` non-null in the schema**

In `src/db/schema/sessions.ts`, change the `campaignId` line from:

```typescript
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
```

to:

```typescript
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `drizzle/0025_*.sql` containing `ALTER TABLE "sessions" ALTER COLUMN "campaign_id" SET NOT NULL;`.

- [ ] **Step 3: Apply locally**

Run: `pnpm db:migrate`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/sessions.ts drizzle/0025_*.sql drizzle/meta/
git commit -m "feat(db): tighten sessions.campaign_id to NOT NULL"
```

---

## Phase 2 — Domain logic

### Task 6: Default campaign name helper

**Files:**
- Create: `src/campaigns/default-name.ts`
- Create: `tests/campaigns/default-name.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/campaigns/default-name.test.ts
import { describe, it, expect } from 'vitest';
import { defaultCampaignName } from '@/campaigns/default-name';

describe('defaultCampaignName', () => {
  it('formats from a character name', () => {
    expect(defaultCampaignName({ name: 'Tharion' })).toBe("Tharion's tale");
  });
  it('falls back when the character is null', () => {
    expect(defaultCampaignName(null)).toBe("Untitled's tale");
  });
  it('falls back when the character has no name', () => {
    expect(defaultCampaignName({ name: '' })).toBe("Untitled's tale");
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm vitest run tests/campaigns/default-name.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// src/campaigns/default-name.ts
export function defaultCampaignName(character: { name: string } | null): string {
  const name = character?.name?.trim();
  return `${name && name.length > 0 ? name : 'Untitled'}'s tale`;
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm vitest run tests/campaigns/default-name.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/default-name.ts tests/campaigns/default-name.test.ts
git commit -m "feat(campaigns): defaultCampaignName helper"
```

---

### Task 7: Request body validators

**Files:**
- Create: `src/campaigns/validate.ts`
- Create: `tests/campaigns/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/campaigns/validate.test.ts
import { describe, it, expect } from 'vitest';
import { validateCreateBody, validatePatchBody } from '@/campaigns/validate';

describe('validateCreateBody', () => {
  it('accepts a valid body', () => {
    const r = validateCreateBody({ name: 'Adventure', premise: 'A long premise text.', characterTemplateId: '11111111-1111-1111-1111-111111111111' });
    expect(r.ok).toBe(true);
  });
  it('rejects missing fields', () => {
    const r = validateCreateBody({ name: 'x' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/premise|characterTemplateId/);
  });
  it('rejects non-uuid characterTemplateId', () => {
    const r = validateCreateBody({ name: 'x', premise: 'y', characterTemplateId: 'not-a-uuid' });
    expect(r.ok).toBe(false);
  });
});

describe('validatePatchBody', () => {
  it('accepts a rename', () => {
    const r = validatePatchBody({ name: 'new title' });
    expect(r.ok).toBe(true);
  });
  it('rejects premise changes', () => {
    const r = validatePatchBody({ premise: 'changed' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/immutable/);
  });
  it('rejects empty body', () => {
    const r = validatePatchBody({});
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm vitest run tests/campaigns/validate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/campaigns/validate.ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CreateBody = { name: string; premise: string; characterTemplateId: string };
export type PatchBody = { name: string };

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function validateCreateBody(input: unknown): ValidateResult<CreateBody> {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'body-not-object' };
  const o = input as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.trim().length === 0) return { ok: false, reason: 'name-required' };
  if (typeof o.premise !== 'string' || o.premise.trim().length === 0) return { ok: false, reason: 'premise-required' };
  if (typeof o.characterTemplateId !== 'string' || !UUID_RE.test(o.characterTemplateId)) return { ok: false, reason: 'characterTemplateId-required' };
  return { ok: true, value: { name: o.name.trim(), premise: o.premise.trim(), characterTemplateId: o.characterTemplateId } };
}

export function validatePatchBody(input: unknown): ValidateResult<PatchBody> {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'body-not-object' };
  const o = input as Record<string, unknown>;
  if ('premise' in o) return { ok: false, reason: 'premise-is-immutable' };
  if (typeof o.name !== 'string' || o.name.trim().length === 0) return { ok: false, reason: 'name-required' };
  return { ok: true, value: { name: o.name.trim() } };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm vitest run tests/campaigns/validate.test.ts`
Expected: PASS (all 6 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/validate.ts tests/campaigns/validate.test.ts
git commit -m "feat(campaigns): body validators for create + patch"
```

---

### Task 8: Extract template→instance fork into a reusable helper

**Files:**
- Create: `src/campaigns/fork.ts`
- Reference: `src/app/api/sessions/route.ts` (existing fork logic to extract)

- [ ] **Step 1: Read the existing fork logic**

Open `src/app/api/sessions/route.ts`. The fork block runs between the `template` lookup and the `db.insert(sessions)` call. It deep-copies a template character into an instance with `templateId` set and a fresh-L1 reset of mutable fields. Note: it depends on `abilityModifier`, `deriveLevel1Spellcasting`, and uses `characters` table.

- [ ] **Step 2: Create the reusable fork helper**

```typescript
// src/campaigns/fork.ts
import { eq, and, isNull } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { characters } from '@/db/schema';
import { abilityModifier } from '@/engine/modifiers';
import { deriveLevel1Spellcasting } from '@/characters/derive';

type Tx = typeof db | PgTransaction<any, any, any>;

export type ForkResult = { instanceId: string; hpMax: number; hitDiceMax: number };

/**
 * Deep-copy a character template into a session-bound instance owned by a
 * campaign. All mutable fields reset to fresh-L1; identity / abilities /
 * race / class / background are preserved from the template.
 *
 * Idempotent on instance ids: if the passed character is already an
 * instance (templateId NOT NULL), returns it as-is.
 */
export async function forkTemplateForCampaign(opts: {
  tx: Tx;
  userId: string;
  characterId: string;
  campaignId: string;
}): Promise<ForkResult> {
  const { tx, userId, characterId, campaignId } = opts;

  const [template] = await tx
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.userId, userId), isNull(characters.deletedAt)))
    .limit(1);
  if (!template) throw new Error('character-not-found');

  if (template.templateId) {
    // Reject instance ids: re-binding an instance to a new campaign would
    // silently change its `campaignId`, contaminating the old campaign's
    // character. The API contract is "pass a template (template_id IS NULL)".
    throw new Error('not-a-template');
  }

  const conMod = abilityModifier(template.abilities.CON);
  const dexMod = abilityModifier(template.abilities.DEX);
  const freshHpMax = template.hitDieSize + conMod;
  const freshAc = 10 + dexMod;
  const freshSpellcasting = deriveLevel1Spellcasting(template.classSlug, template.abilities, 2);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _ignore, createdAt: _c, updatedAt: _u, ...templateData } = template;
  const [instance] = await tx
    .insert(characters)
    .values({
      ...templateData,
      templateId: template.id,
      campaignId,
      level: 1,
      xp: 0,
      proficiencyBonus: 2,
      hpMax: freshHpMax,
      ac: freshAc,
      hitDiceMax: 1,
      classes: [{ slug: template.classSlug, level: 1 }],
      spellcasting: freshSpellcasting,
      spellsKnown: freshSpellcasting?.spellsKnown ?? [],
      features: [],
      inventory: [],
      inspiration: false,
      attunedItems: [],
      senses: null,
      equippedFocus: null,
      craftingProjects: [],
      downtimeActivities: [],
      hirelings: [],
      bastion: null,
      mountedOn: null,
      embarkedOn: null,
    })
    .returning();
  if (!instance) throw new Error('fork-failed');

  return { instanceId: instance.id, hpMax: freshHpMax, hitDiceMax: 1 };
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/campaigns/fork.ts
git commit -m "feat(campaigns): reusable template→instance fork helper"
```

---

### Task 9: Atomic `createCampaign` forge

**Files:**
- Create: `src/campaigns/forge.ts`
- Create: `tests/campaigns/forge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/campaigns/forge.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, characters, sessions, sessionState, users } from '@/db/schema';
import { createCampaign } from '@/campaigns/forge';

describe('createCampaign', () => {
  const userId = 'user_forge_test_' + Math.random().toString(36).slice(2);
  let templateId: string;

  beforeEach(async () => {
    await db.insert(users).values({ id: userId, displayName: 'Forge Test' }).onConflictDoNothing();
    const [tpl] = await db.insert(characters).values({
      userId, name: 'Tharion', level: 1, xp: 0,
      raceSlug: 'half-elf', classSlug: 'fighter', backgroundSlug: 'soldier',
      classes: [{ slug: 'fighter', level: 1 }],
      abilities: { STR: 15, DEX: 14, CON: 13, INT: 10, WIS: 12, CHA: 8 },
      proficiencyBonus: 2, hpMax: 11, ac: 16, speed: 30, hitDieSize: 10, hitDiceMax: 1,
      proficiencies: { saves: ['STR','CON'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
      spellcasting: null, spellsKnown: [], features: [], inventory: [],
      identity: { name: 'Tharion', alignment: 'N', traits: [], ideals: [], bonds: [], flaws: [], backstory: '' },
    }).returning();
    templateId = tpl!.id;
  });

  it('creates campaign + instance + session + session_state atomically', async () => {
    const result = await createCampaign({
      userId, name: 'Goblin Warren', premise: 'A cramped warren beneath an old mill.',
      characterTemplateId: templateId,
    });

    expect(result.campaign.name).toBe('Goblin Warren');
    expect(result.sessionId).toBeDefined();

    const [instance] = await db.select().from(characters).where(eq(characters.templateId, templateId));
    expect(instance).toBeDefined();
    expect(instance!.campaignId).toBe(result.campaign.id);

    const [session] = await db.select().from(sessions).where(eq(sessions.campaignId, result.campaign.id));
    expect(session).toBeDefined();
    expect(session!.characterId).toBe(instance!.id);

    const [state] = await db.select().from(sessionState).where(eq(sessionState.sessionId, session!.id));
    expect(state).toBeDefined();
  });

  it('rejects a template owned by a different user', async () => {
    await expect(
      createCampaign({ userId: 'someone-else', name: 'X', premise: 'Y', characterTemplateId: templateId })
    ).rejects.toThrow(/character-not-found/);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `pnpm vitest run tests/campaigns/forge.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/campaigns/forge.ts
import { db } from '@/db/client';
import { campaigns, sessions, sessionState, type Campaign } from '@/db/schema';
import { forkTemplateForCampaign } from './fork';

export type CreateCampaignInput = {
  userId: string;
  name: string;
  premise: string;
  characterTemplateId: string;
};

export type CreateCampaignResult = { campaign: Campaign; sessionId: string };

/**
 * Atomic creation: campaign + character instance (fork from template) +
 * session + session_state. Any failure rolls back the entire transaction.
 *
 * During the PR1 → PR2 transition window the session row is double-written
 * with the deprecated long-lived columns so a rollback of the application
 * code can fall back to reading from `sessions.*` without data loss.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  return await db.transaction(async (tx) => {
    const [campaign] = await tx
      .insert(campaigns)
      .values({
        userId: input.userId,
        name: input.name,
        premise: input.premise,
        // language / tonalFrame / engagementProfile keep their defaults; they will be set as the master interacts.
      })
      .returning();
    if (!campaign) throw new Error('campaign-insert-failed');

    const fork = await forkTemplateForCampaign({
      tx,
      userId: input.userId,
      characterId: input.characterTemplateId,
      campaignId: campaign.id,
    });

    const [session] = await tx
      .insert(sessions)
      .values({
        userId: input.userId,
        characterId: fork.instanceId,
        campaignId: campaign.id,
        // Deprecated double-write: PR2 drops these columns.
        premise: input.premise,
      })
      .returning();
    if (!session) throw new Error('session-insert-failed');

    await tx.insert(sessionState).values({
      sessionId: session.id,
      hpCurrent: fork.hpMax,
      hitDiceRemaining: fork.hitDiceMax,
    });

    return { campaign, sessionId: session.id };
  });
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `pnpm vitest run tests/campaigns/forge.test.ts`
Expected: PASS — both cases.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/forge.ts tests/campaigns/forge.test.ts
git commit -m "feat(campaigns): createCampaign atomic transaction"
```

---

### Task 10: Read-side persist module

**Files:**
- Create: `src/campaigns/persist.ts`

- [ ] **Step 1: Implement the read/update queries**

```typescript
// src/campaigns/persist.ts
import { and, eq, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns, sessions, characters, type Campaign } from '@/db/schema';

export async function listCampaigns(userId: string, status?: 'active' | 'ended') {
  const conditions = [eq(campaigns.userId, userId), isNull(campaigns.deletedAt)];
  if (status) conditions.push(eq(campaigns.status, status));
  return db
    .select()
    .from(campaigns)
    .where(and(...conditions))
    .orderBy(desc(campaigns.lastPlayedAt), desc(campaigns.updatedAt));
}

export async function getCampaign(userId: string, campaignId: string) {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId), isNull(campaigns.deletedAt)))
    .limit(1);
  if (!campaign) return null;

  const [instance] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.campaignId, campaignId), isNull(characters.deletedAt)))
    .limit(1);

  const [activeSession] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.campaignId, campaignId), isNull(sessions.deletedAt)))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);

  return { campaign, character: instance ?? null, activeSession: activeSession ?? null };
}

export async function renameCampaign(userId: string, campaignId: string, name: string): Promise<Campaign | null> {
  const [row] = await db
    .update(campaigns)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId), isNull(campaigns.deletedAt)))
    .returning();
  return row ?? null;
}

export async function softDeleteCampaign(userId: string, campaignId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(campaigns)
      .set({ deletedAt: now, status: 'ended', updatedAt: now })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId), isNull(campaigns.deletedAt)))
      .returning({ id: campaigns.id });
    if (!row) return false;

    await tx
      .update(sessions)
      .set({ deletedAt: now, updatedAt: now, status: 'ended' })
      .where(and(eq(sessions.campaignId, campaignId), isNull(sessions.deletedAt)));

    await tx
      .update(characters)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(characters.campaignId, campaignId), isNull(characters.deletedAt)));

    return true;
  });
}

export async function touchCampaign(campaignId: string): Promise<void> {
  const now = new Date();
  await db.update(campaigns).set({ lastPlayedAt: now, updatedAt: now }).where(eq(campaigns.id, campaignId));
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/campaigns/persist.ts
git commit -m "feat(campaigns): list/get/rename/softDelete/touch queries"
```

---

## Phase 3 — Legacy backfill + verification

### Task 11: Legacy template fork script

**Files:**
- Create: `scripts/migrate-legacy-template-sessions.ts`
- Modify: `package.json` (add `db:fork-legacy` script)

- [ ] **Step 1: Write the script**

```typescript
// scripts/migrate-legacy-template-sessions.ts
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../src/db/client';
import { characters, sessions } from '../src/db/schema';
import { forkTemplateForCampaign } from '../src/campaigns/fork';

/**
 * Pre-commit 29e40ce sessions point sessions.character_id at a template
 * (templates_id IS NULL) instead of an instance. After the campaigns
 * backfill, those characters still have campaign_id IS NULL — violating
 * our invariant that instances must have campaign_id NOT NULL.
 *
 * This script forks the template into an instance bound to the session's
 * campaign, then repoints the session at the instance. Idempotent — safe
 * to re-run.
 */
async function main() {
  const legacy = await db
    .select({ session: sessions, character: characters })
    .from(sessions)
    .innerJoin(characters, eq(characters.id, sessions.characterId))
    .where(and(
      isNotNull(sessions.campaignId),
      isNull(characters.templateId),
    ));

  console.log(`Found ${legacy.length} legacy template session(s).`);
  for (const row of legacy) {
    if (!row.session.campaignId) continue;
    const fork = await forkTemplateForCampaign({
      tx: db,
      userId: row.session.userId,
      characterId: row.character.id,
      campaignId: row.session.campaignId,
    });
    await db.update(sessions).set({ characterId: fork.instanceId }).where(eq(sessions.id, row.session.id));
    console.log(`  · session ${row.session.id} → new instance ${fork.instanceId}`);
  }
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the package script**

In `package.json` `scripts`, add:

```json
"db:fork-legacy": "tsx scripts/migrate-legacy-template-sessions.ts"
```

- [ ] **Step 3: Run against local DB**

Run: `pnpm db:fork-legacy`
Expected: prints number of legacy rows and processes them. If 0, it just exits.

- [ ] **Step 4: Verify the invariant queries are all zero**

Run:
```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM characters WHERE template_id IS NULL AND campaign_id IS NOT NULL;" \
                     -c "SELECT COUNT(*) FROM characters WHERE template_id IS NOT NULL AND campaign_id IS NULL;" \
                     -c "SELECT COUNT(*) FROM sessions WHERE campaign_id IS NULL AND deleted_at IS NULL;" \
                     -c "SELECT COUNT(*) FROM campaigns c LEFT JOIN sessions s ON s.campaign_id = c.id WHERE s.id IS NULL;"
```
Expected: all four counts = 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-legacy-template-sessions.ts package.json
git commit -m "feat(campaigns): legacy template fork migration script"
```

---

## Phase 4 — API routes

### Task 12: `POST /api/campaigns` route

**Files:**
- Create: `src/app/api/campaigns/route.ts`
- Create: `tests/api/campaigns.test.ts`

- [ ] **Step 1: Write the failing test for POST**

```typescript
// tests/api/campaigns.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { POST as postCampaign, GET as getCampaigns } from '@/app/api/campaigns/route';
import { db } from '@/db/client';
import { characters, users } from '@/db/schema';
import { eq } from 'drizzle-orm';

// NOTE: tests assume Clerk auth is stubbed via a vitest setup. If your
// existing API tests use a different pattern (e.g. NextRequest with a
// custom header parsed by middleware), follow that pattern instead.

const TEST_USER = 'user_campaigns_test_001';
let templateId: string;

beforeAll(async () => {
  await db.insert(users).values({ id: TEST_USER, displayName: 'C Test' }).onConflictDoNothing();
  const [tpl] = await db.insert(characters).values({
    userId: TEST_USER, name: 'Lyra',
    raceSlug: 'tiefling', classSlug: 'cleric', backgroundSlug: 'acolyte',
    classes: [{ slug: 'cleric', level: 1 }],
    abilities: { STR: 10, DEX: 12, CON: 14, INT: 10, WIS: 16, CHA: 14 },
    level: 1, xp: 0, proficiencyBonus: 2, hpMax: 10, ac: 14, speed: 30, hitDieSize: 8, hitDiceMax: 1,
    proficiencies: { saves: ['WIS','CHA'], skills: [], expertise: [], weapons: [], armor: [], tools: [], languages: [] },
    spellcasting: null, spellsKnown: [], features: [], inventory: [],
    identity: { name: 'Lyra', alignment: 'N', traits: [], ideals: [], bonds: [], flaws: [], backstory: '' },
  }).returning();
  templateId = tpl!.id;
});

describe('POST /api/campaigns', () => {
  it('creates a campaign with valid body', async () => {
    const req = new Request('http://test/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: 'My tale', premise: 'A goblin warren.', characterTemplateId: templateId }),
    });
    const res = await postCampaign(req as any);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.campaign.name).toBe('My tale');
    expect(body.sessionId).toBeTruthy();
  });

  it('returns 422 when premise is missing', async () => {
    const req = new Request('http://test/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: 'X', characterTemplateId: templateId }),
    });
    const res = await postCampaign(req as any);
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Implement the route**

```typescript
// src/app/api/campaigns/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import { listCampaigns } from '@/campaigns/persist';
import { createCampaign } from '@/campaigns/forge';
import { validateCreateBody } from '@/campaigns/validate';

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const status = statusParam === 'active' || statusParam === 'ended' ? statusParam : undefined;
  const rows = await listCampaigns(userId, status);
  return NextResponse.json({ campaigns: rows });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  await ensureUser(userId);

  const raw = await req.json().catch(() => null);
  const parsed = validateCreateBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 422 });

  try {
    const result = await createCampaign({ userId, ...parsed.value });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message === 'character-not-found') return NextResponse.json({ error: message }, { status: 404 });
    if (message === 'not-a-template') return NextResponse.json({ error: message }, { status: 422 });
    console.error('createCampaign failed:', err);
    return NextResponse.json({ error: 'create-failed' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Run the tests, expect pass**

Run: `pnpm vitest run tests/api/campaigns.test.ts`
Expected: PASS — both cases.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/campaigns/route.ts tests/api/campaigns.test.ts
git commit -m "feat(api): POST + GET /api/campaigns"
```

---

### Task 13: `/api/campaigns/[id]` route (GET, PATCH, DELETE)

**Files:**
- Create: `src/app/api/campaigns/[id]/route.ts`
- Modify: `tests/api/campaigns.test.ts` (append cases)

- [ ] **Step 1: Append the failing tests**

Add to `tests/api/campaigns.test.ts`:

```typescript
import { GET as getOne, PATCH as patchOne, DELETE as delOne } from '@/app/api/campaigns/[id]/route';

describe('GET /api/campaigns/[id]', () => {
  it('returns campaign + character + activeSession', async () => {
    const create = await postCampaign(new Request('http://t', { method: 'POST', body: JSON.stringify({ name: 'X', premise: 'Y', characterTemplateId: templateId }) }) as any);
    const { campaign } = await create.json();
    const res = await getOne(new Request('http://t') as any, { params: Promise.resolve({ id: campaign.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.campaign.id).toBe(campaign.id);
    expect(body.character).toBeTruthy();
    expect(body.activeSession).toBeTruthy();
  });
});

describe('PATCH /api/campaigns/[id]', () => {
  it('renames the campaign', async () => {
    const create = await postCampaign(new Request('http://t', { method: 'POST', body: JSON.stringify({ name: 'Old', premise: 'Y', characterTemplateId: templateId }) }) as any);
    const { campaign } = await create.json();
    const res = await patchOne(
      new Request('http://t', { method: 'PATCH', body: JSON.stringify({ name: 'New' }) }) as any,
      { params: Promise.resolve({ id: campaign.id }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).campaign.name).toBe('New');
  });

  it('rejects premise mutations with 422', async () => {
    const create = await postCampaign(new Request('http://t', { method: 'POST', body: JSON.stringify({ name: 'X', premise: 'Y', characterTemplateId: templateId }) }) as any);
    const { campaign } = await create.json();
    const res = await patchOne(
      new Request('http://t', { method: 'PATCH', body: JSON.stringify({ premise: 'changed' }) }) as any,
      { params: Promise.resolve({ id: campaign.id }) },
    );
    expect(res.status).toBe(422);
  });
});

describe('DELETE /api/campaigns/[id]', () => {
  it('soft-deletes campaign + session + instance', async () => {
    const create = await postCampaign(new Request('http://t', { method: 'POST', body: JSON.stringify({ name: 'X', premise: 'Y', characterTemplateId: templateId }) }) as any);
    const { campaign } = await create.json();
    const res = await delOne(new Request('http://t') as any, { params: Promise.resolve({ id: campaign.id }) });
    expect(res.status).toBe(204);

    const after = await getOne(new Request('http://t') as any, { params: Promise.resolve({ id: campaign.id }) });
    expect(after.status).toBe(404);
  });
});
```

- [ ] **Step 2: Implement the route**

```typescript
// src/app/api/campaigns/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getCampaign, renameCampaign, softDeleteCampaign } from '@/campaigns/persist';
import { validatePatchBody } from '@/campaigns/validate';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const row = await getCampaign(userId, id);
  if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => null);
  const parsed = validatePatchBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 422 });
  const row = await renameCampaign(userId, id, parsed.value.name);
  if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  return NextResponse.json({ campaign: row });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const ok = await softDeleteCampaign(userId, id);
  if (!ok) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 3: Run the tests, expect pass**

Run: `pnpm vitest run tests/api/campaigns.test.ts`
Expected: PASS — all cases.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/campaigns/[id]/route.ts tests/api/campaigns.test.ts
git commit -m "feat(api): GET/PATCH/DELETE /api/campaigns/[id]"
```

---

### Task 14: Deprecate `POST /api/sessions` and `GET /api/sessions`

**Files:**
- Modify: `src/app/api/sessions/route.ts`

- [ ] **Step 1: Replace handlers with 410 Gone**

Replace both `GET` and `POST` in `src/app/api/sessions/route.ts` with:

```typescript
import { NextResponse } from 'next/server';

const GONE_BODY = {
  error: 'endpoint-removed',
  message: 'Sessions are now created via POST /api/campaigns. List sessions via GET /api/campaigns and campaign detail.',
};

export function GET() {
  return NextResponse.json(GONE_BODY, { status: 410 });
}

export function POST() {
  return NextResponse.json(GONE_BODY, { status: 410 });
}
```

- [ ] **Step 2: Update or remove existing tests for these handlers**

Open the existing `tests/api/sessions.test.ts`. Any test that expected a 200/201 from `POST /api/sessions` or a list from `GET /api/sessions` should be replaced with a single assertion that the response is `410`. Keep tests for the rest of the session sub-routes (`turn`, `state`, `dice-log`, etc.) unchanged.

- [ ] **Step 3: Run the affected tests**

Run: `pnpm vitest run tests/api/sessions.test.ts`
Expected: PASS — the new 410 assertion plus any other unchanged tests.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sessions/route.ts tests/api/sessions.test.ts
git commit -m "feat(api): deprecate POST/GET /api/sessions with 410 Gone"
```

---

## Phase 5 — Master loop refactor (campaign-aware reads/writes)

### Task 15: Master loop reads premise/language/tonal/profile from campaign

**Files:**
- Reference: existing master loop and snapshot files — search with `grep -rn "session.premise\|session.tonalFrame\|session.engagementProfile\|session.language" src/` to find call sites
- Modify: each file that reads those fields from the session row
- Modify: tests covering those modules

- [ ] **Step 1: Locate the call sites**

Run: `grep -rn "\.premise\b\|\.tonalFrame\b\|\.engagementProfile\b\|\.language\b" src/ai/ src/sessions/ src/app/api/sessions/`

For each match, decide whether it's a read of a session field that should now come from the campaign join. The expected hot spots are around the master loop's request build and the snapshot hydrator.

- [ ] **Step 2: For each read site, change the source**

The pattern:

```typescript
// Before
const { premise, language, tonalFrame, engagementProfile } = sessionRow;
```

becomes

```typescript
// After — join campaign in the same query, or fetch separately
const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, sessionRow.campaignId)).limit(1);
if (!campaign) throw new Error('campaign-not-found');
const { premise, language, tonalFrame, engagementProfile } = campaign;
```

Prefer joining in the original query when possible:

```typescript
const [row] = await db
  .select({ session: sessions, campaign: campaigns })
  .from(sessions)
  .innerJoin(campaigns, eq(campaigns.id, sessions.campaignId))
  .where(eq(sessions.id, sessionId))
  .limit(1);
```

- [ ] **Step 3: Run typecheck + the related test files**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS. If existing tests fail because they used a session row literal that lacks campaign fields, update those test fixtures to create a campaign first and pass its id.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(master): read premise/language/tonal/profile from campaigns join"
```

---

### Task 16: Tool handlers `set_tonal_frame` and `set_engagement_profile` write to campaigns

**Files:**
- Modify: the tool handler files (find via `grep -rn "set_tonal_frame\|setTonalFrame\|set_engagement_profile" src/`)

- [ ] **Step 1: Locate the handlers**

Run: `grep -rn "set_tonal_frame\|setTonalFrame\|tonal_frame\|engagement_profile" src/ai/ src/engine/ src/app/api/sessions/`

- [ ] **Step 2: Redirect writes to campaigns**

For each handler that currently does `UPDATE sessions SET tonal_frame = ...`, change to `UPDATE campaigns SET tonal_frame = ... WHERE id = (SELECT campaign_id FROM sessions WHERE id = ...)`. The cleanest form:

```typescript
import { campaigns, sessions } from '@/db/schema';
import { sql, eq } from 'drizzle-orm';

await db
  .update(campaigns)
  .set({ tonalFrame: frame, updatedAt: new Date() })
  .where(
    eq(campaigns.id, sql`(SELECT campaign_id FROM ${sessions} WHERE id = ${sessionId})`),
  );
```

Or, if the handler already has `campaignId` in scope (passed in from the master loop), use it directly.

- [ ] **Step 3: Update tests for these handlers**

If tests assert against `sessions.tonal_frame`, change them to assert against `campaigns.tonal_frame`. Same for `engagement_profile`.

- [ ] **Step 4: Run the master/tool tests**

Run: `pnpm vitest run tests/ai/ tests/sessions/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(tools): set_tonal_frame and set_engagement_profile write to campaigns"
```

---

### Task 17: Update `last_played_at` at end of every master turn

**Files:**
- Modify: the master loop turn handler (the file behind `POST /api/sessions/[id]/turn`)

- [ ] **Step 1: Add the touch call**

At the end of the turn loop (after the final persisted message and any cleanup), add a call to `touchCampaign(campaignId)` from `src/campaigns/persist.ts`. If only `sessionId` is in scope, resolve `campaignId` once at the top of the turn handler when the session is loaded.

```typescript
import { touchCampaign } from '@/campaigns/persist';

// ...end of turn loop:
await touchCampaign(session.campaignId);
```

- [ ] **Step 2: Run the turn tests**

Run: `pnpm vitest run tests/sessions/ tests/api/`
Expected: PASS. If existing turn tests don't already cover `last_played_at`, optionally add one assertion that the field is updated after a turn.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(master): bump campaign.last_played_at after each turn"
```

---

### Task 18: `GET /api/sessions/[id]` returns campaign join

**Files:**
- Modify: `src/app/api/sessions/[id]/route.ts`

- [ ] **Step 1: Update the GET handler**

Replace the existing select with a join, and include the joined campaign in the response body:

```typescript
// inside GET handler
const [row] = await db
  .select({
    session: sessions,
    campaign: campaigns,
    state: sessionState,
    character: characters,
  })
  .from(sessions)
  .innerJoin(campaigns, eq(campaigns.id, sessions.campaignId))
  .innerJoin(sessionState, eq(sessionState.sessionId, sessions.id))
  .innerJoin(characters, eq(characters.id, sessions.characterId))
  .where(and(eq(sessions.id, id), eq(sessions.userId, userId), isNull(sessions.deletedAt)))
  .limit(1);

if (!row) return NextResponse.json({ error: 'not-found' }, { status: 404 });
return NextResponse.json({
  session: row.session,
  campaign: row.campaign,
  state: row.state,
  character: row.character,
});
```

(Adapt to the existing response shape if it differs — keep additional fields the UI already consumes.)

- [ ] **Step 2: Run the sessions test file**

Run: `pnpm vitest run tests/api/sessions.test.ts tests/api/sessions-history.test.ts`
Expected: PASS. Update fixtures if needed.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(api): GET /api/sessions/[id] returns joined campaign"
```

---

## Phase 6 — UI

### Task 19: Campaign card component

**Files:**
- Create: `src/components/campaigns/campaign-card.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/campaigns/campaign-card.tsx
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import type { Campaign } from '@/db/schema';

export type CampaignCardData = {
  campaign: Campaign;
  characterName?: string | null;
  characterRace?: string | null;
  characterClass?: string | null;
  characterLevel?: number | null;
};

export function CampaignCard({ campaign, characterName, characterRace, characterClass, characterLevel }: CampaignCardData) {
  return (
    <Link href={`/campaigns/${campaign.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
      <Card accent={campaign.status === 'active'}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, lineHeight: 1.15 }}>
          {campaign.name}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          <Chip tone={campaign.status === 'active' ? 'accent' : 'neutral'} dot={campaign.status === 'active'}>
            {campaign.status}
          </Chip>
          {campaign.language && <Chip tone="gold">{campaign.language}</Chip>}
          <Chip tone="neutral">{campaign.style}</Chip>
        </div>
        {characterName && (
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--fg-muted)' }}>
            {characterName} · {characterRace} {characterClass} L{characterLevel}
          </div>
        )}
        <div
          style={{
            marginTop: 10,
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
            fontSize: 13,
            color: 'var(--fg-muted)',
            lineHeight: 1.45,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          &ldquo;{campaign.premise}&rdquo;
        </div>
      </Card>
    </Link>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/campaigns/campaign-card.tsx
git commit -m "feat(ui): CampaignCard component"
```

---

### Task 20: `/campaigns` list page

**Files:**
- Create: `src/app/(authed)/campaigns/page.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/(authed)/campaigns/page.tsx
import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { campaigns as campaignsTable, characters as charactersTable } from '@/db/schema';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CampaignCard } from '@/components/campaigns/campaign-card';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const rows = await db
    .select({ campaign: campaignsTable, character: charactersTable })
    .from(campaignsTable)
    .leftJoin(charactersTable, eq(charactersTable.campaignId, campaignsTable.id))
    .where(and(eq(campaignsTable.userId, userId), isNull(campaignsTable.deletedAt)));

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>Campaigns</h1>
          <p style={{ marginTop: 8, color: 'var(--fg-muted)', fontSize: 15 }}>
            {rows.length === 0 ? 'No campaigns yet — begin a new tale.' : `${rows.length} campaigns.`}
          </p>
        </div>
        <Link href="/campaigns/new">
          <Button variant="primary" size="md" icon="plus">New campaign</Button>
        </Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        {rows.map(({ campaign, character }) => (
          <CampaignCard
            key={campaign.id}
            campaign={campaign}
            characterName={character?.name}
            characterRace={character?.raceSlug}
            characterClass={character?.classSlug}
            characterLevel={character?.level}
          />
        ))}
        <Link href="/campaigns/new" style={{ textDecoration: 'none' }}>
          <button
            style={{
              width: '100%', background: 'transparent', border: '1px dashed var(--border-strong)',
              borderRadius: 8, padding: 18, minHeight: 200, color: 'var(--fg-muted)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer',
            }}
          >
            <Icon name="plus" size={24}/>
            <span style={{ fontSize: 14 }}>Start a new campaign</span>
          </button>
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Visit the page locally**

Start the dev server: `pnpm dev`. Open `http://localhost:3000/campaigns` (after signing in). Expected: the page renders, lists the backfilled campaigns, and the "New campaign" CTA links to `/campaigns/new`.

- [ ] **Step 3: Commit**

```bash
git add src/app/(authed)/campaigns/page.tsx
git commit -m "feat(ui): /campaigns list page"
```

---

### Task 21: `/campaigns/new` wizard (server + client)

**Files:**
- Create: `src/app/(authed)/campaigns/new/page.tsx`
- Create: `src/app/(authed)/campaigns/new/wizard-client.tsx`

- [ ] **Step 1: Server component fetches templates**

```tsx
// src/app/(authed)/campaigns/new/page.tsx
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters as charactersTable } from '@/db/schema';
import { CAMPAIGN_PRESETS } from '@/sessions/campaign-presets';
import { NewCampaignWizard } from './wizard-client';

export const dynamic = 'force-dynamic';

export default async function NewCampaignPage() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const templates = await db
    .select()
    .from(charactersTable)
    .where(and(
      eq(charactersTable.userId, userId),
      isNull(charactersTable.deletedAt),
      isNull(charactersTable.templateId),
    ));

  if (templates.length === 0) redirect('/characters/new');

  return (
    <NewCampaignWizard
      templates={templates.map((t) => ({ id: t.id, name: t.name, raceSlug: t.raceSlug, classSlug: t.classSlug, level: t.level }))}
      presets={CAMPAIGN_PRESETS}
    />
  );
}
```

- [ ] **Step 2: Client wizard with 2 steps**

```tsx
// src/app/(authed)/campaigns/new/wizard-client.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CampaignPreset } from '@/sessions/campaign-presets';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';

type TemplateOpt = { id: string; name: string; raceSlug: string; classSlug: string; level: number };

export function NewCampaignWizard({ templates, presets }: { templates: TemplateOpt[]; presets: CampaignPreset[] }) {
  const router = useRouter();
  const [step, setStep] = useState<0 | 1>(0);
  const [characterId, setCharacterId] = useState<string>(templates[0]?.id ?? '');
  const [presetId, setPresetId] = useState<string>(presets[0]?.id ?? 'custom');
  const isCustom = presetId === 'custom';
  const preset = presets.find((p) => p.id === presetId);
  const [premise, setPremise] = useState<string>(preset?.premise ?? '');
  const [name, setName] = useState<string>(preset?.name ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPresetChange = (id: string) => {
    setPresetId(id);
    if (id === 'custom') {
      setPremise('');
      setName('');
    } else {
      const p = presets.find((x) => x.id === id);
      if (p) {
        setPremise(p.premise);
        setName(p.name);
      }
    }
  };

  const onCreate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || 'Untitled', premise: premise.trim(), characterTemplateId: characterId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { sessionId } = await res.json();
      router.push(`/sessions/${sessionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown');
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 32px' }}>
      <h1 style={{ fontSize: 32, fontWeight: 600 }}>{step === 0 ? 'Who walks the path?' : 'How does the tale begin?'}</h1>

      {step === 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginTop: 24 }}>
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => setCharacterId(t.id)}
              style={{
                textAlign: 'left', padding: 14, borderRadius: 8,
                background: 'var(--bg-card)',
                border: characterId === t.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                cursor: 'pointer', color: 'inherit', fontFamily: 'inherit',
              }}
            >
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600 }}>{t.name}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{t.raceSlug} · {t.classSlug} · L{t.level}</div>
            </button>
          ))}
        </div>
      )}

      {step === 1 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 16 }}>
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => onPresetChange(p.id)}
                style={{
                  textAlign: 'left', padding: 12, borderRadius: 8,
                  background: 'var(--bg-card)',
                  border: presetId === p.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                  cursor: 'pointer', color: 'inherit', fontFamily: 'inherit',
                }}
              >
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{p.difficulty}</div>
              </button>
            ))}
            <button
              onClick={() => onPresetChange('custom')}
              style={{
                textAlign: 'left', padding: 12, borderRadius: 8,
                background: 'var(--bg-card)',
                border: presetId === 'custom' ? '2px solid var(--accent)' : '1px dashed var(--border-strong)',
                cursor: 'pointer', color: 'inherit', fontFamily: 'inherit',
              }}
            >
              <div style={{ fontWeight: 600 }}>Custom…</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>write your own</div>
            </button>
          </div>

          <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginBottom: 4 }}>Premise</label>
          <textarea
            value={premise}
            onChange={(e) => setPremise(e.target.value)}
            rows={5}
            style={{ width: '100%', padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'inherit', fontFamily: 'inherit', fontSize: 14 }}
          />

          <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginTop: 14, marginBottom: 4 }}>Campaign name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="auto-derived from preset"
            style={{ width: '100%', padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'inherit', fontFamily: 'inherit', fontSize: 14 }}
          />
        </div>
      )}

      {error && <Card style={{ marginTop: 16, borderColor: 'var(--danger)' }}><div style={{ color: 'var(--danger)' }}>Error: {error}</div></Card>}

      <div style={{ marginTop: 28, display: 'flex', justifyContent: 'space-between' }}>
        {step === 0 ? (
          <a href="/campaigns" style={{ textDecoration: 'none' }}><Button variant="ghost" size="md">Cancel</Button></a>
        ) : (
          <Button variant="ghost" size="md" onClick={() => setStep(0)}>Back</Button>
        )}
        {step === 0 ? (
          <Button variant="primary" size="md" iconRight="arrow-right" onClick={() => setStep(1)} disabled={!characterId}>
            Next: Premise
          </Button>
        ) : (
          <Button variant="primary" size="md" icon="sparkle" onClick={onCreate} disabled={submitting || !premise.trim()}>
            {submitting ? 'Forging…' : 'Begin the tale'}
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Visit the wizard locally**

Run: `pnpm dev`. Open `http://localhost:3000/campaigns/new`. Walk through both steps, click "Begin the tale", verify the redirect to `/sessions/[id]` and that the campaign appears in the list.

- [ ] **Step 4: Commit**

```bash
git add src/app/(authed)/campaigns/new/
git commit -m "feat(ui): /campaigns/new wizard (character + premise)"
```

---

### Task 22: `/campaigns/[id]` detail page

**Files:**
- Create: `src/app/(authed)/campaigns/[id]/page.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/app/(authed)/campaigns/[id]/page.tsx
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { getCampaign } from '@/campaigns/persist';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Icon } from '@/components/ui/icon';
import { DeleteCardButton } from '@/components/ui/delete-card-button';

export const dynamic = 'force-dynamic';

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  const { id } = await params;
  const data = await getCampaign(userId, id);
  if (!data) notFound();
  const { campaign, character, activeSession } = data;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 36, fontWeight: 600, lineHeight: 1.1 }}>{campaign.name}</h1>
          <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            <Chip tone={campaign.status === 'active' ? 'accent' : 'neutral'} dot={campaign.status === 'active'}>{campaign.status}</Chip>
            <Chip tone="neutral">{campaign.style}</Chip>
            {campaign.language && <Chip tone="gold">{campaign.language}</Chip>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {activeSession ? (
            <Link href={`/sessions/${activeSession.id}`}>
              <Button variant="primary" size="md" iconRight="arrow-right">Continue</Button>
            </Link>
          ) : (
            <Button variant="primary" size="md" disabled>Resume not available</Button>
          )}
          <DeleteCardButton endpoint={`/api/campaigns/${campaign.id}`} confirmText={`Delete ${campaign.name}? This cannot be undone.`} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 18 }}>
        <Card>
          {character ? (
            <Link href={`/characters/${character.templateId ?? character.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600 }}>{character.name}</div>
              <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{character.raceSlug} · {character.classSlug} · L{character.level}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}>HP {character.hpMax} · AC {character.ac}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 8 }}><Icon name="arrow-right" size={12}/> view sheet</div>
            </Link>
          ) : (
            <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>No character bound to this campaign.</div>
          )}
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>Premise</div>
          <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 14, lineHeight: 1.55 }}>
            &ldquo;{campaign.premise}&rdquo;
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 18, fontSize: 12, color: 'var(--fg-muted)' }}>
        {campaign.lastPlayedAt && <>Last played: {new Date(campaign.lastPlayedAt).toLocaleString()} · </>}
        Created: {new Date(campaign.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Visit the detail page locally**

Run: `pnpm dev`. Open `http://localhost:3000/campaigns/<id>` for an existing campaign. Verify the layout, the "Continue" button redirect, and the delete button.

- [ ] **Step 3: Commit**

```bash
git add src/app/(authed)/campaigns/[id]/page.tsx
git commit -m "feat(ui): /campaigns/[id] detail page"
```

---

### Task 23: Hub — replace sessions section with campaigns

**Files:**
- Modify: `src/app/(authed)/hub/page.tsx`

- [ ] **Step 1: Swap the data source**

In `src/app/(authed)/hub/page.tsx`, replace the `recentSessions` query (the block that joins `sessionsTable` and `charactersTable` ordered by `sessions.updatedAt`) with a campaigns query:

```typescript
import { campaigns as campaignsTable } from '@/db/schema';
import { CampaignCard } from '@/components/campaigns/campaign-card';

const recentCampaigns = await db
  .select({ campaign: campaignsTable, character: charactersTable })
  .from(campaignsTable)
  .leftJoin(charactersTable, eq(charactersTable.campaignId, campaignsTable.id))
  .where(and(eq(campaignsTable.userId, userId), isNull(campaignsTable.deletedAt)))
  .orderBy(desc(campaignsTable.lastPlayedAt), desc(campaignsTable.updatedAt))
  .limit(3);
```

- [ ] **Step 2: Replace the JSX section**

Find the existing "Open tables" / "Sessions" section in the JSX and replace it with:

```tsx
<div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 40, marginBottom: 16 }}>
  <Eyebrow>Campaigns</Eyebrow>
  <h2 style={{ fontSize: 24, fontWeight: 600 }}>Active and recent</h2>
  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-subtle)' }}>{recentCampaigns.length}</span>
  {recentCampaigns.length > 0 && (
    <Link href="/campaigns" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
      View all →
    </Link>
  )}
</div>

<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
  {recentCampaigns.map(({ campaign, character }) => (
    <CampaignCard
      key={campaign.id}
      campaign={campaign}
      characterName={character?.name}
      characterRace={character?.raceSlug}
      characterClass={character?.classSlug}
      characterLevel={character?.level}
    />
  ))}
  <Link href="/campaigns/new" style={{ textDecoration: 'none' }}>
    <button
      style={{
        width: '100%', background: 'transparent', border: '1px dashed var(--border-strong)',
        borderRadius: 8, padding: 18, minHeight: 200, color: 'var(--fg-muted)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer',
      }}
    >
      <Icon name="plus" size={24}/>
      <span style={{ fontSize: 14 }}>Start a new campaign</span>
    </button>
  </Link>
</div>
```

Also update the top-bar CTA in the header: change `<Link href="/sessions/new">` to `<Link href="/campaigns/new">`, and update the button label if needed.

- [ ] **Step 3: Visit /hub locally**

Run: `pnpm dev`. Open `http://localhost:3000/hub`. Verify campaign cards appear, the "New campaign" CTA leads to the wizard, and the heroes section is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/(authed)/hub/page.tsx
git commit -m "feat(ui): hub shows campaigns instead of sessions"
```

---

### Task 24: TopBar — fix Campaigns link

**Files:**
- Modify: `src/components/layout/top-bar.tsx`

- [ ] **Step 1: Update the link**

Open the top bar component. Find the "Campaigns" navigation entry (currently points to `/hub` per post-mvp-improvements C-M5). Change its `href` to `/campaigns`.

- [ ] **Step 2: Smoke-check**

Run: `pnpm dev`. Click "Campaigns" in the top bar. Expected: lands on `/campaigns`.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/top-bar.tsx
git commit -m "fix(ui): TopBar Campaigns link points to /campaigns"
```

---

### Task 25: 301 redirects for `/sessions` and `/sessions/new`

**Files:**
- Modify: `next.config.ts` (or use middleware if redirects-config not used)
- Delete (or empty): `src/app/(authed)/sessions/page.tsx`
- Delete (or empty): `src/app/(authed)/sessions/new/page.tsx`

- [ ] **Step 1: Add redirects to next config**

Open `next.config.ts`. Add (or extend) a `redirects` async function:

```typescript
const config = {
  // ...
  async redirects() {
    return [
      { source: '/sessions', destination: '/campaigns', permanent: true },
      { source: '/sessions/new', destination: '/campaigns/new', permanent: true },
    ];
  },
};
```

If the project uses `vercel.ts` (per session bootstrap notes), put the redirects there using `routes.redirect(...)` from `@vercel/config/v1` instead.

- [ ] **Step 2: Remove the old pages**

Delete `src/app/(authed)/sessions/page.tsx` and `src/app/(authed)/sessions/new/page.tsx`. (Keep `src/app/(authed)/sessions/[id]/` — the game screen is still in use.)

- [ ] **Step 3: Verify the redirects**

Run: `pnpm dev`. `curl -I http://localhost:3000/sessions` and `curl -I http://localhost:3000/sessions/new`. Expected: both return `301` with `Location: /campaigns` and `/campaigns/new` respectively.

- [ ] **Step 4: Commit**

```bash
git add next.config.ts
git rm src/app/(authed)/sessions/page.tsx src/app/(authed)/sessions/new/page.tsx
git commit -m "feat(ui): 301 redirects from /sessions to /campaigns"
```

---

## Phase 7 — End-to-end coverage

### Task 26: E2E golden path

**Files:**
- Create: `tests/e2e/campaigns.spec.ts`

- [ ] **Step 1: Write the test (follows existing pattern in `tests/e2e/game-screen.spec.ts`)**

```typescript
// tests/e2e/campaigns.spec.ts
import { test, expect } from '@playwright/test';

const HAS_CLERK_TESTING = !!process.env.CLERK_TESTING_TOKEN_USER_ID;

test('unauthed /campaigns redirects to sign-in', async ({ page }) => {
  await page.goto('/campaigns');
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});

test('unauthed /campaigns/new redirects to sign-in', async ({ page }) => {
  await page.goto('/campaigns/new');
  await page.waitForURL(/\/sign-in/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/sign-in/);
});

test('authenticated golden path: create → play → resume', async ({ page }) => {
  test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');

  await page.goto('/hub');
  await page.getByRole('link', { name: /new campaign/i }).first().click();
  await expect(page).toHaveURL(/\/campaigns\/new$/);

  // Step 1: pick the first available template character.
  await page.locator('button').filter({ hasText: /L\d+/ }).first().click();
  await page.getByRole('button', { name: /next: premise/i }).click();

  // Step 2: keep the default preset, submit.
  await page.getByRole('button', { name: /begin the tale/i }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+/);
  await expect(page.locator('text=Send').first()).toBeVisible({ timeout: 10_000 });

  // Resume from hub.
  await page.goto('/hub');
  await page.locator('a[href^="/campaigns/"]').first().click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+$/);
  await page.getByRole('link', { name: /continue/i }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+/);
});
```

- [ ] **Step 2: Run the spec**

Run: `pnpm test:e2e tests/e2e/campaigns.spec.ts`
Expected: PASS. The two unauthed cases always run; the authenticated case skips unless `CLERK_TESTING_TOKEN_USER_ID` is set (per post-mvp-improvements X-3).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/campaigns.spec.ts
git commit -m "test(e2e): campaign create → play → resume golden path"
```

---

### Task 27: E2E rename + delete + redirects

**Files:**
- Modify: `tests/e2e/campaigns.spec.ts`

- [ ] **Step 1: Append the redirect case (always runs) and the delete case (skips without Clerk testing)**

```typescript
test('301 redirects /sessions → /campaigns', async ({ page }) => {
  const r1 = await page.goto('/sessions');
  // Next.js 301 redirects are followed transparently; assert final URL.
  await expect(page).toHaveURL(/\/(campaigns|sign-in)/);

  const r2 = await page.goto('/sessions/new');
  await expect(page).toHaveURL(/\/(campaigns\/new|sign-in)/);
});

test('authenticated user can delete a campaign', async ({ page, request }) => {
  test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');

  // Create through the UI wizard so we don't depend on a test-only API.
  await page.goto('/campaigns/new');
  await page.locator('button').filter({ hasText: /L\d+/ }).first().click();
  await page.getByRole('button', { name: /next: premise/i }).click();
  // Edit the name so we can find this campaign later.
  await page.getByLabel(/campaign name/i).fill('To be deleted');
  await page.getByRole('button', { name: /begin the tale/i }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+/);

  // Find the campaign in the list.
  await page.goto('/campaigns');
  const card = page.locator('a[href^="/campaigns/"]').filter({ hasText: 'To be deleted' }).first();
  const detailHref = await card.getAttribute('href');
  expect(detailHref).toBeTruthy();
  await card.click();

  // Click delete + confirm.
  await page.locator('button[aria-label="delete"]').click();
  await page.locator('button:has-text("Confirm")').click();
  await page.waitForURL(/\/(campaigns|hub)$/);

  // Visiting the old detail URL must 404.
  const after = await page.goto(detailHref!);
  expect(after?.status()).toBe(404);
});
```

- [ ] **Step 2: Run**

Run: `pnpm test:e2e tests/e2e/campaigns.spec.ts`
Expected: both new cases PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/campaigns.spec.ts
git commit -m "test(e2e): campaigns redirects + delete cases"
```

---

## Phase 8 — Verification and cleanup

### Task 28: Final verification queries

**Files:** none — runtime checks only.

- [ ] **Step 1: Run all suites**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`
Expected: all green.

- [ ] **Step 2: Run the four §7.8 verification queries against the local DB**

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM sessions WHERE campaign_id IS NULL AND deleted_at IS NULL;" \
                     -c "SELECT COUNT(*) FROM characters WHERE template_id IS NOT NULL AND campaign_id IS NULL;" \
                     -c "SELECT COUNT(*) FROM characters WHERE template_id IS NULL AND campaign_id IS NOT NULL;" \
                     -c "SELECT COUNT(*) FROM campaigns c LEFT JOIN sessions s ON s.campaign_id = c.id WHERE s.id IS NULL;"
```
Expected: all four counts = 0.

- [ ] **Step 3: Check coverage on the new module**

Run: `pnpm test:coverage -- src/campaigns/`
Expected: line coverage ≥ 85% on the `src/campaigns/` files.

- [ ] **Step 4: Manual smoke**

Run: `pnpm dev`. Walk through: hub → new campaign → wizard → play one master turn (verify response reads from the campaign's premise/language/tonal_frame) → back to hub → continue → rename → delete.

- [ ] **Step 5: Final commit if anything tweaked**

Only commit if changes were made during smoke. Otherwise skip.

---

### Task 29: (Follow-up PR, defer 1+ week) — drop deprecated session columns

**Note:** this task is the entire PR 2 (per spec §7.7). Open it only after ≥ 1 week of stable production on the new flow and after the §7.8 queries return 0 in production.

**Files:**
- Modify: `src/db/schema/sessions.ts` — remove the four deprecated columns
- Create: `drizzle/<NNNN>_<auto>.sql` (generated)
- Modify: `src/campaigns/forge.ts` — remove the deprecated double-write to `sessions.premise`

- [ ] **Step 1: Remove from schema**

Delete the lines for `premise`, `language`, `tonalFrame`, `engagementProfile` from `src/db/schema/sessions.ts`.

- [ ] **Step 2: Remove the double-write from forge**

In `src/campaigns/forge.ts`, remove the `premise: input.premise,` line from the `insert(sessions).values({...})` call. Keep `userId`, `characterId`, `campaignId`.

- [ ] **Step 3: Generate migration**

Run: `pnpm db:generate`
Expected: a new migration `0026_*.sql` containing four `ALTER TABLE "sessions" DROP COLUMN ...` statements.

- [ ] **Step 4: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. If any test still references the dropped fields, update the test.

- [ ] **Step 5: Apply locally and commit**

```bash
pnpm db:migrate
git add src/db/schema/sessions.ts src/campaigns/forge.ts drizzle/0026_*.sql drizzle/meta/
git commit -m "feat(db): drop deprecated session columns (premise/language/tonal/profile)"
```

---

## Notes for the executor

- The migration filename suffix (`<adjective>_<noun>`) is generated by `drizzle-kit`. When the plan references `0024_*.sql`, use the actual filename produced.
- The plan assumes Clerk auth tokens are wired into Vitest and Playwright the same way the existing test suites do. If a new test stubs auth differently, mirror the existing pattern in `tests/api/sessions.test.ts` and `tests/e2e/`.
- For Tasks 15–18 (master loop refactor), the exact file locations depend on the codebase. Use `grep` to find call sites — there will be hot spots in `src/ai/master/`, `src/sessions/snapshot.ts`, and `src/app/api/sessions/[id]/turn/route.ts`.
- Keep commits small and focused: each task should produce 1–2 commits at most.
- The `double-write` strategy in `forge.ts` (Task 9) intentionally writes `premise` to both `campaigns` and `sessions` for the PR 1 → PR 2 window. Task 29 removes that double-write.
- Do not skip the legacy fork script (Task 11). Even if the local DB has no legacy template sessions, the production DB might.
