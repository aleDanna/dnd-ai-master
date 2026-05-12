import { test, expect } from '@playwright/test';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { ensureUser } from '@/db/users';
import { saveCharacter } from '@/characters/persist';
import { emptyWizardState } from '@/characters/types';
import { sessions, sessionState, sessionMessages, campaigns } from '@/db/schema';

const TESTING_USER = process.env.CLERK_TESTING_TOKEN_USER_ID;
const HAS_CLERK_TESTING = !!TESTING_USER;

test.describe('memory backfill banner', () => {
  let sessionId = '';

  test.beforeAll(async () => {
    test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');
    await ensureUser(TESTING_USER!);
    const w = emptyWizardState();
    w.raceSlug = 'human';
    w.classSlug = 'fighter';
    w.backgroundSlug = 'soldier';
    w.identity.name = 'Memoria E2E';
    const c = await saveCharacter({ userId: TESTING_USER!, wizard: w });
    const [campaign] = await db.insert(campaigns).values({ userId: TESTING_USER!, name: 'Memory backfill E2E campaign', premise: 'memoria-e2e' }).returning();
    const [s] = await db
      .insert(sessions)
      .values({ userId: TESTING_USER!, characterId: c.id, campaignId: campaign!.id, premise: 'memoria-e2e' })
      .returning();
    sessionId = s!.id;
    await db.insert(sessionState).values({ sessionId, hpCurrent: 10, hitDiceRemaining: 1 });
    const rows = [];
    for (let i = 0; i < 80; i++) {
      const isPlayer = i % 2 === 0;
      rows.push({
        sessionId,
        role: (isPlayer ? 'player' : 'master') as 'player' | 'master',
        content: `seeded message ${i}`,
        authorCharacterId: isPlayer ? c.id : null,
      });
    }
    await db.insert(sessionMessages).values(rows);
  });

  test.afterAll(async () => {
    if (!HAS_CLERK_TESTING || !sessionId) return;
    await db.execute(sql`delete from sessions where id = ${sessionId}`);
    // Pool is shared with the test app — leave open.
  });

  test('opens session, sees backfill banner, banner disappears on complete', async ({ page }) => {
    test.skip(!HAS_CLERK_TESTING, 'requires CLERK_TESTING_TOKEN_USER_ID');

    await page.goto(`/sessions/${sessionId}`);
    // Banner expected.
    const banner = page.getByTestId('memory-status-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    // Wait until backfill completes (banner unmounts). Allow up to 90 seconds
    // because the rebuild does N model calls; with the real (non-mocked)
    // extractor this varies.
    await expect(banner).toBeHidden({ timeout: 90_000 });
    // The textarea inside NarrativePane should now be enabled.
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeEnabled();
  });
});
