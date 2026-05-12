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
