import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, users, type UserPreferences } from '@/db/schema';

export type { UserPreferences };
export {
  TTS_VOICES, type TtsVoice, isValidTtsVoice,
  TTS_MODELS, type TtsModel, isValidTtsModel,
  TTS_PROVIDERS, type TtsProvider, isValidTtsProvider,
  voicesForProvider, voicesForModel, modelsForProvider,
  defaultVoiceForProvider, defaultVoiceForModel, defaultModelForProvider,
  isValidVoiceForProvider, isValidVoiceForModel, isValidModelForProvider,
} from './tts-voices';
import {
  defaultVoiceForModel as ttsVoiceDefaultForModel,
  defaultModelForProvider as ttsModelDefault,
  voicesForModel as ttsVoicesForModel,
  modelsForProvider as ttsModelsFor,
  type TtsProvider,
} from './tts-voices';

/**
 * Defaults are merged on top of stored prefs at read time. Provider/model defaults
 * cascade from env vars when user hasn't picked anything; if env is also unset,
 * fall back to anthropic + claude-sonnet-4-5 (the historical default).
 */
function envDefaultProvider(): 'anthropic' | 'openai' | 'gemini' {
  const raw = (process.env.MASTER_PROVIDER ?? '').trim().toLowerCase();
  if (raw === 'openai') return 'openai';
  if (raw === 'gemini') return 'gemini';
  return 'anthropic';
}

function envDefaultMasterModel(provider: 'anthropic' | 'openai' | 'gemini'): string {
  if (provider === 'openai') return process.env.OPENAI_MASTER_MODEL ?? 'gpt-5';
  if (provider === 'gemini') return process.env.GEMINI_MASTER_MODEL ?? 'gemini-2.5-pro';
  return process.env.ANTHROPIC_MASTER_MODEL ?? 'claude-sonnet-4-5';
}

function envDefaultImageProvider(): 'openai' | 'gemini' {
  const raw = (process.env.IMAGE_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'gemini' ? 'gemini' : 'openai';
}

function envDefaultImageModel(provider: 'openai' | 'gemini'): string {
  if (provider === 'gemini') return process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
  return process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
}

function envDefaultTtsProvider(): TtsProvider {
  const raw = (process.env.TTS_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'gemini' ? 'gemini' : 'openai';
}

/** Per-provider env-overridable model default. Falls back to the static
 *  per-provider default if no env var is set. */
function envDefaultTtsModel(provider: TtsProvider): string {
  if (provider === 'gemini') {
    return process.env.GEMINI_TTS_MODEL ?? ttsModelDefault('gemini');
  }
  return process.env.OPENAI_TTS_MODEL ?? ttsModelDefault('openai');
}

/** Env-overridable default voice for a given (provider, model) pair. The
 *  model matters for OpenAI because some voices (e.g. ballad) only exist on
 *  gpt-4o-mini-tts — the legacy tts-1/tts-1-hd models reject them. */
function envDefaultTtsVoice(provider: TtsProvider, model: string): string {
  const envOverride = provider === 'gemini' ? process.env.GEMINI_TTS_VOICE : process.env.OPENAI_TTS_VOICE;
  // Honour the env override only if it's actually supported by the model in
  // play — otherwise it would force every user onto an invalid voice.
  if (envOverride && ttsVoicesForModel(provider, model).includes(envOverride)) {
    return envOverride;
  }
  return ttsVoiceDefaultForModel(provider, model);
}

export const DEFAULT_PREFERENCES: Required<UserPreferences> = {
  ttsProvider: 'openai',
  ttsVoice: 'onyx',
  ttsModel: 'gpt-4o-mini-tts',
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
  // Default: reveal DC/AC numbers in prose (current behavior). Players who
  // want a more immersive experience can flip this off.
  showDifficultyNumbers: true,
  imageGenerationEnabled: false,
  imageStylePreset: 'pastel',
  imageStyleCustom: '',
  imageProvider: 'openai',
  imageModel: 'gpt-image-1',
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
  const imageGenerationEnabled = prefs.imageGenerationEnabled ?? DEFAULT_PREFERENCES.imageGenerationEnabled;
  const imageStylePreset = prefs.imageStylePreset ?? DEFAULT_PREFERENCES.imageStylePreset;
  const imageStyleCustom = prefs.imageStyleCustom ?? DEFAULT_PREFERENCES.imageStyleCustom;
  const imageProvider = prefs.imageProvider ?? envDefaultImageProvider();
  const imageModel = prefs.imageModel ?? envDefaultImageModel(imageProvider);
  // TTS triplet — provider drives the namespace; (provider, model) drives the
  // namespace for voice. Voice support is model-specific on OpenAI: 'ballad'
  // only works on gpt-4o-mini-tts and the legacy tts-1 / tts-1-hd reject it
  // with 400. Resolve model first, then voice against that model.
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
    ttsAutoplay: prefs.ttsAutoplay ?? DEFAULT_PREFERENCES.ttsAutoplay,
    manualRolls: prefs.manualRolls ?? DEFAULT_PREFERENCES.manualRolls,
    aiProvider: provider,
    aiMasterModel: masterModel,
    masterGuidanceLevel: prefs.masterGuidanceLevel ?? DEFAULT_PREFERENCES.masterGuidanceLevel,
    showDifficultyNumbers: prefs.showDifficultyNumbers ?? DEFAULT_PREFERENCES.showDifficultyNumbers,
    imageGenerationEnabled,
    imageStylePreset,
    imageStyleCustom,
    imageProvider,
    imageModel,
  };
}

export async function updateUserPreferences(userId: string, patch: Partial<UserPreferences>): Promise<UserPreferences> {
  const current = await getUserPreferences(userId);
  const merged: UserPreferences = { ...current, ...patch };
  await db.update(users).set({ preferences: merged }).where(eq(users.id, userId));
  return merged;
}

/**
 * Session-scoped resolved preferences — returns the **host's** preferences for
 * the given session, regardless of who's calling.
 *
 * Multiplayer rule: only the host decides which AI provider/model the Master
 * uses, whether image generation is on, what tonal-frame defaults apply, etc.
 * If we resolved per-caller, a guest's quirky preference (say, Gemini when the
 * host has Anthropic) would either crash the turn or silently switch the
 * narration's voice mid-session. Everything that touches the Master loop or
 * shared session state (image regen on a past message, memory rebuild, the
 * /turn endpoint) MUST go through this helper so the session has one
 * canonical AI configuration.
 *
 * Personal-device choices (TTS voice/model, autoplay) still resolve
 * per-viewer via `getResolvedPreferences(viewerId)` — those don't affect
 * other party members.
 *
 * Throws if the session doesn't exist or has been soft-deleted; callers
 * upstream of this helper have always done auth first, so a missing row is
 * a programmer error worth surfacing.
 */
export async function getSessionMasterPreferences(
  sessionId: string,
): Promise<Required<UserPreferences>> {
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`getSessionMasterPreferences: session ${sessionId} not found`);
  return getResolvedPreferences(row.userId);
}

