import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { characters, sessions } from '@/db/schema';
import { forkTemplateForCampaign } from '@/campaigns/fork';

/**
 * Pre-commit 29e40ce sessions point sessions.character_id at a template
 * (template_id IS NULL) instead of an instance. After the campaigns
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
