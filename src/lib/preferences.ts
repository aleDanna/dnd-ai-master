import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type UserPreferences } from '@/db/schema';

export type { UserPreferences };
export { TTS_VOICES, type TtsVoice, isValidTtsVoice } from './tts-voices';

/**
 * Defaults are merged on top of stored prefs at read time. Provider/model defaults
 * cascade from env vars when user hasn't picked anything; if env is also unset,
 * fall back to anthropic + claude-sonnet-4-5 (the historical default).
 */
function envDefaultProvider(): 'anthropic' | 'openai' {
  const raw = (process.env.MASTER_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'openai' ? 'openai' : 'anthropic';
}

function envDefaultMasterModel(provider: 'anthropic' | 'openai'): string {
  if (provider === 'openai') return process.env.OPENAI_MASTER_MODEL ?? 'gpt-5';
  return process.env.ANTHROPIC_MASTER_MODEL ?? 'claude-sonnet-4-5';
}

export const DEFAULT_PREFERENCES: Required<UserPreferences> = {
  ttsVoice: 'onyx',
  ttsAutoplay: false,
  manualRolls: false,
  // These are set lazily inside getResolvedPreferences so the env values are read
  // at request time, not at module-load time.
  aiProvider: 'anthropic',
  aiMasterModel: 'claude-sonnet-4-5',
  // Default master guidance: balanced — hint at options without enumerating
  // them as a bullet list. Existing players who set their preference keep
  // their pick; new players start here.
  masterGuidanceLevel: 'balanced',
};

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const [row] = await db.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.preferences ?? {};
}

/** Returns prefs with defaults applied for any missing field. Env-driven defaults
 * for provider/model are resolved at call time so a redeploy with new env vars
 * affects existing users who haven't explicitly set a value. */
export async function getResolvedPreferences(userId: string): Promise<Required<UserPreferences>> {
  const prefs = await getUserPreferences(userId);
  const envProvider = envDefaultProvider();
  const provider = prefs.aiProvider ?? envProvider;
  const masterModel = prefs.aiMasterModel ?? envDefaultMasterModel(provider);
  return {
    ttsVoice: prefs.ttsVoice ?? DEFAULT_PREFERENCES.ttsVoice,
    ttsAutoplay: prefs.ttsAutoplay ?? DEFAULT_PREFERENCES.ttsAutoplay,
    manualRolls: prefs.manualRolls ?? DEFAULT_PREFERENCES.manualRolls,
    aiProvider: provider,
    aiMasterModel: masterModel,
    masterGuidanceLevel: prefs.masterGuidanceLevel ?? DEFAULT_PREFERENCES.masterGuidanceLevel,
  };
}

export async function updateUserPreferences(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const current = await getUserPreferences(userId);
  const merged: UserPreferences = { ...current, ...patch };
  await db.update(users).set({ preferences: merged }).where(eq(users.id, userId));
  return merged;
}

