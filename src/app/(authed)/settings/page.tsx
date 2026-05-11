import { auth } from '@clerk/nextjs/server';
import { ensureUser } from '@/db/users';
import { getResolvedPreferences } from '@/lib/preferences';
import { SettingsClient } from './settings-client';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { userId } = await auth();
  if (!userId) return null;
  await ensureUser(userId);

  const prefs = await getResolvedPreferences(userId);

  return <SettingsClient initialPreferences={prefs} />;
}
