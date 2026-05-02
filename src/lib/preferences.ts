import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type UserPreferences } from '@/db/schema';

export type { UserPreferences };
export { TTS_VOICES, type TtsVoice, isValidTtsVoice } from './tts-voices';

export const DEFAULT_PREFERENCES: Required<UserPreferences> = {
  ttsVoice: 'onyx',
  ttsAutoplay: false,
  manualRolls: false,
};

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const [row] = await db.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.preferences ?? {};
}

/** Returns prefs with defaults applied for any missing field. */
export async function getResolvedPreferences(userId: string): Promise<Required<UserPreferences>> {
  const prefs = await getUserPreferences(userId);
  return { ...DEFAULT_PREFERENCES, ...prefs };
}

export async function updateUserPreferences(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const current = await getUserPreferences(userId);
  const merged: UserPreferences = { ...current, ...patch };
  await db.update(users).set({ preferences: merged }).where(eq(users.id, userId));
  return merged;
}

