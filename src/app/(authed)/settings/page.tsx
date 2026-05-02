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
  const ttsModel = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';

  return <SettingsClient initialPreferences={prefs} ttsModel={ttsModel} />;
}
